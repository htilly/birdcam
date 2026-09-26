#!/usr/bin/env python3
"""
Birdcam Motion Detector
=======================
Detects motion using OpenCV MOG2 background subtraction.
Sends bounding box data to the Node.js server via WebSocket.

Two modes:
1. RTSP mode (legacy): Opens RTSP stream directly with OpenCV
2. Stdin mode (recommended): Reads raw gray (or legacy BGR24) frames from stdin (piped from ffmpeg)
   - Avoids duplicate RTSP connection
   - Lower resource usage

Usage:
    python motion.py              # RTSP mode
    python motion.py --stdin      # Stdin mode (read frames from pipe)

Environment overrides (see config.py for full list):
    MOTION_RTSP_URL, MOTION_RELAY_URL, MOTION_MIN_AREA, etc.
    MOTION_FRAME_WIDTH, MOTION_FRAME_HEIGHT, MOTION_FRAME_FORMAT (for stdin mode)
"""

import asyncio
import json
import logging
import os
import sqlite3
import signal
import struct
import sys
import time
import urllib.parse
from datetime import datetime, timezone

import cv2
import numpy as np
import websockets

import config
import push_notifier

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("motion")

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
last_notification_time: float = 0.0
_relay_ws = None  # persistent connection to the Node.js relay

# Where the Node app stores its SQLite DB (mounted as a volume in Docker).
DB_PATH = os.environ.get("BIRDCAM_DB_PATH", "/app/data/birdcam.db")


def get_first_camera_rtsp_from_db():
    """Return (camera_id, rtsp_url) for the first configured camera, or (None, None)."""
    try:
        conn = sqlite3.connect(DB_PATH, timeout=2)
        cur = conn.cursor()
        row = cur.execute(
            "SELECT id, rtsp_url FROM cameras ORDER BY id LIMIT 1"
        ).fetchone()
        conn.close()
        if (
            row
            and len(row) >= 2
            and isinstance(row[0], (int,))
            and isinstance(row[1], str)
            and row[1].strip()
        ):
            return row[0], row[1].strip()
    except Exception as e:
        logger.warning(f"Could not read RTSP URL from DB ({DB_PATH}): {e}")
    return None, None


def get_motion_settings_from_db(camera_id: int) -> dict:
    """Return motion detection settings for a camera from DB, or defaults."""
    settings = {
        "min_area": config.MIN_CONTOUR_AREA,
        "threshold_fraction": config.MOTION_THRESHOLD_FRACTION,
        "blur_kernel": config.BLUR_KERNEL,
        "cooldown_sec": config.NOTIFICATION_COOLDOWN_SEC,
        "recording_cooldown_sec": config.RECORDING_COOLDOWN_SEC,
    }
    try:
        conn = sqlite3.connect(DB_PATH, timeout=2)
        cur = conn.cursor()
        row = cur.execute(
            "SELECT motion_min_area, motion_threshold, motion_blur_kernel, motion_cooldown_sec FROM cameras WHERE id = ?",
            (camera_id,),
        ).fetchone()
        conn.close()
        if row:
            if row[0] is not None:
                settings["min_area"] = int(row[0])
            if row[1] is not None:
                settings["threshold_fraction"] = float(row[1])
            if row[2] is not None:
                k = int(row[2])
                if k % 2 == 0:
                    k += 1
                settings["blur_kernel"] = k
            if row[3] is not None:
                settings["recording_cooldown_sec"] = int(row[3])
    except Exception as e:
        logger.warning(f"Could not read motion settings from DB: {e}")
    return settings


# Mutable config (can be updated by clients at runtime)
runtime_config = {
    "min_area": config.MIN_CONTOUR_AREA,
    "threshold_fraction": config.MOTION_THRESHOLD_FRACTION,
    "cooldown_sec": config.NOTIFICATION_COOLDOWN_SEC,
    "recording_cooldown_sec": config.RECORDING_COOLDOWN_SEC,
    "blur_kernel": config.BLUR_KERNEL,
}


# ---------------------------------------------------------------------------
# WebSocket client — connects to Node.js /motion-ws?role=detector
# ---------------------------------------------------------------------------


async def send_to_relay(message: dict):
    """Send a JSON message to the Node.js relay (if connected)."""
    global _relay_ws
    if _relay_ws is None:
        return
    try:
        await _relay_ws.send(json.dumps(message))
    except Exception:
        _relay_ws = None


def _clamp(value, lo, hi):
    if value != value:  # NaN
        raise ValueError("NaN")
    return max(lo, min(hi, value))


def _relay_url_with_token(url: str) -> str:
    """Append MOTION_DETECTOR_TOKEN so the Node server accepts us as the detector."""
    token = os.environ.get("MOTION_DETECTOR_TOKEN", "")
    if not token or "token=" in url:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}token={urllib.parse.quote(token)}"


async def handle_relay_message(raw: str):
    """Handle messages forwarded from browser clients via the Node.js relay."""
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return
    if not isinstance(msg, dict):
        return

    msg_type = msg.get("type")

    if msg_type == "config_update":
        # Validate everything before applying, so one bad field can't leave a
        # half-applied config or raise out of the relay loop.
        try:
            updates = {}
            if "min_area" in msg:
                # px² at the 640px reference width (see MotionDetector.prepare),
                # so these bounds are independent of the actual frame size.
                updates["min_area"] = _clamp(int(msg["min_area"]), 100, 200_000)
            if "threshold_fraction" in msg:
                updates["threshold_fraction"] = _clamp(float(msg["threshold_fraction"]), 0.0001, 1.0)
            if "cooldown_sec" in msg:
                updates["cooldown_sec"] = _clamp(int(msg["cooldown_sec"]), 5, 3600)
            if "recording_cooldown_sec" in msg:
                updates["recording_cooldown_sec"] = _clamp(int(msg["recording_cooldown_sec"]), 1, 60)
        except (TypeError, ValueError, OverflowError):
            logger.warning("Ignoring invalid config_update from browser")
            return
        runtime_config.update(updates)
        logger.info(f"Config updated by browser: {runtime_config}")
        await send_to_relay({"type": "config", **runtime_config})

    elif msg_type == "subscribe":
        subscription = msg.get("subscription")
        if subscription and isinstance(subscription, dict):
            ok = push_notifier.add_subscription(config.SUBSCRIPTIONS_FILE, subscription)
            await send_to_relay({"type": "subscribed", "ok": bool(ok)})
            if ok:
                logger.info("Push subscription saved.")

    elif msg_type == "unsubscribe":
        endpoint = msg.get("endpoint")
        if endpoint:
            push_notifier.remove_subscription(config.SUBSCRIPTIONS_FILE, endpoint)
            await send_to_relay({"type": "unsubscribed", "ok": True})

    elif msg_type == "ping":
        await send_to_relay({"type": "pong"})


async def relay_connection_loop(stop_event: asyncio.Event):
    """Maintain a persistent WebSocket connection to the Node.js relay."""
    global _relay_ws
    backoff = [2, 5, 10, 30]
    attempt = 0

    while not stop_event.is_set():
        url = config.RELAY_URL
        try:
            logger.info(f"Connecting to relay at {url}")
            async with websockets.connect(
                _relay_url_with_token(url), ping_interval=20, ping_timeout=10
            ) as ws:
                _relay_ws = ws
                attempt = 0
                logger.info("Connected to relay.")
                await ws.send(json.dumps({"type": "config", **runtime_config}))
                async for raw in ws:
                    if stop_event.is_set():
                        break
                    try:
                        await handle_relay_message(raw)
                    except Exception as e:
                        # A single bad message must not drop the relay connection.
                        logger.warning(f"Error handling relay message: {e}")
        except (websockets.exceptions.ConnectionClosed, OSError) as e:
            logger.warning(f"Relay connection lost: {e}")
        except Exception as e:
            logger.error(f"Relay connection error: {e}")
        finally:
            _relay_ws = None

        if stop_event.is_set():
            break

        delay = backoff[min(attempt, len(backoff) - 1)]
        attempt += 1
        logger.info(f"Reconnecting to relay in {delay}s (attempt {attempt})")
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass


# ---------------------------------------------------------------------------
# Motion detection loop (runs in a thread executor to avoid blocking asyncio)
# ---------------------------------------------------------------------------


# Raw frame formats accepted in stdin mode -> bytes per pixel.
# "gray" is what motionManager.js/streamManager.js send; "bgr24" is kept for
# older setups and matches what cv2.VideoCapture returns in RTSP mode.
FRAME_FORMATS = {"gray": 1, "bgr24": 3}


def _scaled_odd(size_at_ref: int, proc_w: int) -> int:
    """Scale a kernel size given at config.REFERENCE_WIDTH to proc_w; odd, >= 1."""
    return max(1, int(round(size_at_ref * proc_w / config.REFERENCE_WIDTH))) | 1


class MotionDetector:
    """MOG2 background subtractor plus per-frame-size processing parameters.

    Everything that depends only on the frame size (resize target, blur size,
    morphology kernel, area scale) is computed once per size, not per frame.
    """

    def __init__(self):
        self.bg_subtractor = cv2.createBackgroundSubtractorMOG2(
            history=config.BG_HISTORY,
            varThreshold=50,
            detectShadows=False,
        )
        self._frame_size = None

    def prepare(self, w: int, h: int):
        if self._frame_size == (w, h):
            return
        if w > config.PROCESS_WIDTH:
            proc_w = config.PROCESS_WIDTH
            proc_h = max(1, int(h * proc_w / w))
            self.resize_to = (proc_w, proc_h)
        else:
            # Already at (or below) the processing size: skip cv2.resize.
            proc_w, proc_h = w, h
            self.resize_to = None
        self.proc_area = proc_w * proc_h
        # Processing px -> original frame px (box coordinates are reported in
        # the coordinates of the frame we were given, with frame_w/frame_h).
        self.inv_scale = w / proc_w
        # min_area is configured in px² of a REFERENCE_WIDTH-wide frame (640x360),
        # so existing values (admin UI sends 600/1500/4000) keep meaning the same
        # region size at any frame/processing resolution: at 320px one processing
        # pixel is 4 reference px².
        self.area_to_ref = (config.REFERENCE_WIDTH / proc_w) ** 2
        self.proc_w = proc_w
        self._blur_cache = {}
        k = self.blur_for(config.BLUR_KERNEL)[0]
        m = _scaled_odd(config.MORPH_KERNEL, proc_w)
        self.morph_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (m, m))
        self._frame_size = (w, h)
        logger.info(
            f"Processing {w}x{h} frames at {proc_w}x{proc_h} "
            f"(blur {k}x{k}, morph {m}x{m})"
        )


    def blur_for(self, ref_kernel) -> tuple:
        """Gaussian kernel size for a blur given in reference (640-wide) px."""
        ksize = self._blur_cache.get(ref_kernel)
        if ksize is None:
            k = _scaled_odd(int(ref_kernel), self.proc_w)
            ksize = self._blur_cache[ref_kernel] = (k, k)
        return ksize


def build_detector() -> MotionDetector:
    """Create and return a fresh detector (MOG2 background subtractor)."""
    return MotionDetector()


def process_frame(frame, detector: MotionDetector) -> tuple[bool, list, int, int]:
    """
    Apply motion detection to a single frame (grayscale HxW or BGR HxWx3).

    Returns:
        (motion_detected, boxes, frame_w, frame_h)
        boxes = list of {"x", "y", "w", "h", "area"} dicts; x/y/w/h are in
        frame pixels, area in reference (640-wide) px² like min_area.
    """
    h, w = frame.shape[:2]
    detector.prepare(w, h)

    # Resize for processing speed (only when larger than PROCESS_WIDTH)
    small = cv2.resize(frame, detector.resize_to) if detector.resize_to else frame

    # Convert to grayscale (unless already gray), blur to reduce noise.
    # blur_kernel (per-camera setting) is in reference 640-wide px, like min_area.
    gray = small if small.ndim == 2 else cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    blur_ksize = detector.blur_for(runtime_config.get("blur_kernel", config.BLUR_KERNEL))
    blurred = cv2.GaussianBlur(gray, blur_ksize, 0)

    # Background subtraction
    fg_mask = detector.bg_subtractor.apply(blurred)

    # Morphological operations to fill holes and merge nearby regions
    kernel = detector.morph_kernel
    fg_mask = cv2.dilate(fg_mask, kernel, iterations=config.DILATE_ITERATIONS)
    fg_mask = cv2.erode(fg_mask, kernel, iterations=1)

    # Find contours
    contours, _ = cv2.findContours(fg_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    inv_scale = detector.inv_scale
    min_area = runtime_config["min_area"]

    boxes = []
    total_motion_area = 0.0  # in processing px²

    for cnt in contours:
        area_proc = cv2.contourArea(cnt)
        area_ref = area_proc * detector.area_to_ref

        if area_ref < min_area:
            continue

        x, y, bw, bh = cv2.boundingRect(cnt)
        # Scale back to original frame coordinates
        boxes.append(
            {
                "x": int(x * inv_scale),
                "y": int(y * inv_scale),
                "w": int(bw * inv_scale),
                "h": int(bh * inv_scale),
                "area": int(area_ref),
            }
        )
        total_motion_area += area_proc

    motion_fraction = total_motion_area / detector.proc_area if detector.proc_area > 0 else 0
    motion_detected = motion_fraction >= runtime_config["threshold_fraction"]

    return motion_detected, boxes, w, h


class MotionEventThrottle:
    """Decides which per-frame detection results are sent to the relay.

    The relay (server.js) forwards every detector message to every browser, so
    sending one per processed frame (~10/s) while nothing moves is wasted work.
    A result is sent when:
      - the state changes (motion starts, or stops -> clients clear overlays),
      - motion continues and ACTIVE_EVENT_INTERVAL_SEC passed (box updates ~2/s),
      - nothing moves and IDLE_EVENT_INTERVAL_SEC passed (liveness heartbeat).

    INVARIANT: while motion continues, a detected=True event with boxes is sent
    at least every ACTIVE_EVENT_INTERVAL_SEC (+ one frame period, ~0.6s total).
    server.js starts/extends a recording on each such event and ends it after
    recording_cooldown_sec (min 1s, default 3s) without one, so this interval
    must stay well under 1s or recordings get cut short mid-motion.
    """

    def __init__(
        self,
        active_interval: float = config.ACTIVE_EVENT_INTERVAL_SEC,
        idle_interval: float = config.IDLE_EVENT_INTERVAL_SEC,
        clock=time.monotonic,
    ):
        self.active_interval = active_interval
        self.idle_interval = idle_interval
        self.clock = clock
        self.last_active = None
        self.last_sent = float("-inf")

    def should_send(self, active: bool) -> bool:
        now = self.clock()
        interval = self.active_interval if active else self.idle_interval
        if active != self.last_active or now - self.last_sent >= interval:
            self.last_active = active
            self.last_sent = now
            return True
        return False


async def emit_motion_event(
    throttle: MotionEventThrottle, motion_detected: bool, boxes: list,
    fw: int, fh: int, camera_id: int,
):
    """Send a motion event to the relay if the throttle allows it."""
    # "Active" mirrors what server.js records on: detected && boxes.length > 0.
    if not throttle.should_send(bool(motion_detected and boxes)):
        return
    await send_to_relay(
        {
            "type": "motion",
            "detected": motion_detected,
            "boxes": boxes,
            "frame_w": fw,
            "frame_h": fh,
            "camera_id": camera_id,
            "timestamp": datetime.now(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
        }
    )


async def run_motion_loop_stdin(
    loop: asyncio.AbstractEventLoop, stop_event: asyncio.Event
):
    """
    Motion detection loop reading raw frames (gray or bgr24) from stdin.
    Frames are piped from ffmpeg to avoid duplicate RTSP connection.
    """
    global last_notification_time
    detector = build_detector()
    throttle = MotionEventThrottle()
    warmup_frames = config.WARMUP_FRAMES
    warmup_update_interval = max(10, warmup_frames // 10)
    last_warmup_update = 0

    # Defaults match the legacy 640x360 bgr24 pipe; motionManager.js sets these.
    frame_width = int(os.environ.get("MOTION_FRAME_WIDTH", "640"))
    frame_height = int(os.environ.get("MOTION_FRAME_HEIGHT", "360"))
    frame_format = os.environ.get("MOTION_FRAME_FORMAT", "bgr24").strip().lower()
    if frame_format not in FRAME_FORMATS:
        logger.error(
            f"Unsupported MOTION_FRAME_FORMAT {frame_format!r} "
            f"(expected one of: {', '.join(FRAME_FORMATS)})"
        )
        return
    bytes_per_pixel = FRAME_FORMATS[frame_format]
    frame_size = frame_width * frame_height * bytes_per_pixel
    frame_shape = (
        (frame_height, frame_width)
        if bytes_per_pixel == 1
        else (frame_height, frame_width, bytes_per_pixel)
    )

    logger.info(
        f"Reading frames from stdin: {frame_width}x{frame_height} {frame_format}"
    )
    logger.info(f"Warming up background model ({warmup_frames} frames)...")
    await send_to_relay(
        {
            "type": "status",
            "connected": True,
            "message": f"Warming up... 0/{warmup_frames} frames",
            "warming_up": True,
            "warmup_progress": {"current": 0, "total": warmup_frames},
        }
    )

    frame_count = 0
    consecutive_failures = 0
    MAX_FAILURES = 50

    try:
        while not stop_event.is_set():
            # Read one frame worth of bytes from stdin
            raw_frame = await asyncio.to_thread(sys.stdin.buffer.read, frame_size)

            if len(raw_frame) == 0:
                # EOF — ffmpeg stream ended
                logger.info("Stdin EOF (stream ended)")
                break

            if len(raw_frame) != frame_size:
                consecutive_failures += 1
                if consecutive_failures >= MAX_FAILURES:
                    logger.error(
                        f"Too many incomplete frames ({consecutive_failures}), stopping"
                    )
                    break
                logger.warning(
                    f"Incomplete frame: expected {frame_size} bytes, got {len(raw_frame)}"
                )
                await asyncio.sleep(0.1)
                continue

            consecutive_failures = 0
            frame_count += 1

            # Convert raw bytes to numpy array
            frame = np.frombuffer(raw_frame, dtype=np.uint8).reshape(frame_shape)

            # Skip detection during warmup (background model learning phase)
            if frame_count <= warmup_frames:
                _, _, _, _ = await asyncio.to_thread(
                    process_frame, frame, detector
                )
                if (
                    frame_count - last_warmup_update >= warmup_update_interval
                    or frame_count == warmup_frames
                ):
                    last_warmup_update = frame_count
                    await send_to_relay(
                        {
                            "type": "status",
                            "connected": True,
                            "message": f"Warming up... {frame_count}/{warmup_frames} frames",
                            "warming_up": True,
                            "warmup_progress": {
                                "current": frame_count,
                                "total": warmup_frames,
                            },
                        }
                    )
                if frame_count == warmup_frames:
                    logger.info("Background model warmed up. Detection active.")
                    await send_to_relay(
                        {
                            "type": "status",
                            "connected": True,
                            "message": "Detection active",
                            "warming_up": False,
                        }
                    )
                await asyncio.sleep(0)
                continue

            motion_detected, boxes, fw, fh = await asyncio.to_thread(
                process_frame, frame, detector
            )

            # Broadcast motion event (throttled, see MotionEventThrottle)
            await emit_motion_event(
                throttle, motion_detected, boxes, fw, fh, config.CAMERA_ID
            )

            # Fire push notification with cooldown
            if motion_detected and boxes:
                now = time.time()
                if now - last_notification_time >= runtime_config["cooldown_sec"]:
                    last_notification_time = now
                    logger.info(
                        f"Motion detected! {len(boxes)} region(s). Sending push..."
                    )
                    push_task = asyncio.create_task(send_push_async(len(boxes)))

                    def _on_push_done(t: asyncio.Task):
                        try:
                            _ = t.result()
                        except asyncio.CancelledError:
                            return
                        except Exception:
                            logger.exception("Background push notification task failed")

                    push_task.add_done_callback(_on_push_done)

            await asyncio.sleep(0)

    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.error(f"Error in stdin motion loop: {e}")
    finally:
        logger.info("Stdin motion loop ended.")


async def run_motion_loop(loop: asyncio.AbstractEventLoop, stop_event: asyncio.Event):
    """
    Main RTSP capture and motion detection loop.
    Runs indefinitely, reconnecting on failure.
    Broadcasts motion events over WebSocket.
    """
    global last_notification_time
    detector = build_detector()
    throttle = MotionEventThrottle()
    warmup_frames = config.WARMUP_FRAMES
    warmup_update_interval = max(10, warmup_frames // 10)
    last_warmup_update = 0

    while not stop_event.is_set():
        # Resolve RTSP URL either from env or from DB (first camera).
        rtsp_url = config.RTSP_URL.strip() if isinstance(config.RTSP_URL, str) else ""
        camera_id = None
        if not rtsp_url:
            camera_id, rtsp_url = get_first_camera_rtsp_from_db()
            rtsp_url = rtsp_url or ""
            if not rtsp_url:
                logger.error(
                    f"No RTSP URL configured in env or DB at {DB_PATH}. "
                    f"Retrying in {config.RECONNECT_DELAY_SEC}s..."
                )
                await send_to_relay(
                    {
                        "type": "status",
                        "connected": False,
                        "message": "No camera configured",
                    }
                )
                await asyncio.sleep(config.RECONNECT_DELAY_SEC)
                continue

        logger.info(f"Connecting to RTSP: {rtsp_url}")
        await send_to_relay(
            {"type": "status", "connected": False, "message": "Connecting to camera..."}
        )

        # OpenCV calls can block for many seconds (RTSP timeouts).
        # Run in a worker thread so the asyncio relay connection stays alive.
        cap = await asyncio.to_thread(cv2.VideoCapture, rtsp_url)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # Minimize latency

        opened = await asyncio.to_thread(cap.isOpened)
        if not opened:
            logger.warning(
                "Failed to open RTSP stream. Retrying in %ds...",
                config.RECONNECT_DELAY_SEC,
            )
            await send_to_relay(
                {
                    "type": "status",
                    "connected": False,
                    "message": "Camera unavailable. Retrying...",
                }
            )
            await asyncio.sleep(config.RECONNECT_DELAY_SEC)
            detector = build_detector()
            warmup_frames = config.WARMUP_FRAMES
            last_warmup_update = 0
            continue

        logger.info("RTSP stream opened.")
        logger.info(f"Warming up background model ({warmup_frames} frames)...")
        await send_to_relay(
            {
                "type": "status",
                "connected": True,
                "message": f"Warming up... 0/{warmup_frames} frames",
                "warming_up": True,
                "warmup_progress": {"current": 0, "total": warmup_frames},
            }
        )

        frame_count = 0
        consecutive_failures = 0
        MAX_FAILURES = 10

        try:
            while not stop_event.is_set():
                ret, frame = await asyncio.to_thread(cap.read)
                if not ret:
                    consecutive_failures += 1
                    if consecutive_failures >= MAX_FAILURES:
                        logger.warning("Too many read failures, reconnecting...")
                        break
                    await asyncio.sleep(0.1)
                    continue

                consecutive_failures = 0
                frame_count += 1

                # Skip detection during warmup (background model learning phase)
                if frame_count <= warmup_frames:
                    _, _, _, _ = await asyncio.to_thread(
                        process_frame, frame, detector
                    )
                    if (
                        frame_count - last_warmup_update >= warmup_update_interval
                        or frame_count == warmup_frames
                    ):
                        last_warmup_update = frame_count
                        await send_to_relay(
                            {
                                "type": "status",
                                "connected": True,
                                "message": f"Warming up... {frame_count}/{warmup_frames} frames",
                                "warming_up": True,
                                "warmup_progress": {
                                    "current": frame_count,
                                    "total": warmup_frames,
                                },
                            }
                        )
                    if frame_count == warmup_frames:
                        logger.info("Background model warmed up. Detection active.")
                        await send_to_relay(
                            {
                                "type": "status",
                                "connected": True,
                                "message": "Detection active",
                                "warming_up": False,
                            }
                        )
                    await asyncio.sleep(0)  # Yield to event loop
                    continue

                motion_detected, boxes, fw, fh = await asyncio.to_thread(
                    process_frame, frame, detector
                )

                # Broadcast motion event (throttled, see MotionEventThrottle)
                await emit_motion_event(
                    throttle, motion_detected, boxes, fw, fh,
                    camera_id or config.CAMERA_ID,
                )

                # Fire push notification with cooldown
                if motion_detected and boxes:
                    now = time.time()
                    if now - last_notification_time >= runtime_config["cooldown_sec"]:
                        last_notification_time = now
                        logger.info(
                            f"Motion detected! {len(boxes)} region(s). Sending push..."
                        )
                        # Run push in background so it doesn't block frame processing
                        push_task = asyncio.create_task(send_push_async(len(boxes)))

                        def _on_push_done(t: asyncio.Task):
                            try:
                                _ = t.result()
                            except asyncio.CancelledError:
                                return
                            except Exception:
                                logger.exception(
                                    "Background push notification task failed"
                                )

                        push_task.add_done_callback(_on_push_done)

                # Debug window (disabled by default)
                if config.DEBUG_WINDOW:
                    debug_frame = frame.copy()
                    for box in boxes:
                        cv2.rectangle(
                            debug_frame,
                            (box["x"], box["y"]),
                            (box["x"] + box["w"], box["y"] + box["h"]),
                            (0, 255, 0),
                            2,
                        )
                    cv2.imshow("Motion Debug", debug_frame)
                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        logger.info("Debug window closed.")
                        break

                # Target ~10fps for detection (100ms per frame)
                await asyncio.sleep(0.1)

        except asyncio.CancelledError:
            # Allow task cancellation to stop the detector cleanly.
            raise
        except Exception as e:
            logger.error(f"Error in motion loop: {e}")
        finally:
            cap.release()
            if config.DEBUG_WINDOW:
                cv2.destroyAllWindows()

        if stop_event.is_set():
            return

        logger.info(f"Stream ended. Reconnecting in {config.RECONNECT_DELAY_SEC}s...")
        await send_to_relay(
            {
                "type": "status",
                "connected": False,
                "message": "Stream interrupted. Reconnecting...",
            }
        )
        await asyncio.sleep(config.RECONNECT_DELAY_SEC)
        detector = build_detector()
        warmup_frames = config.WARMUP_FRAMES


async def send_push_async(num_boxes: int):
    """Send Web Push notification in a thread pool (non-blocking)."""
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: push_notifier.notify_all(
            subscriptions_file=config.SUBSCRIPTIONS_FILE,
            title="Motion Detected",
            body=f"Movement detected in {num_boxes} area{'s' if num_boxes != 1 else ''}.",
            icon="/favicon.png",
            vapid_private_key=config.VAPID_PRIVATE_KEY,
            vapid_claims_sub=config.VAPID_CLAIMS_SUB,
        ),
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def main():
    use_stdin = "--stdin" in sys.argv

    logger.info("Starting Birdcam Motion Detector")
    logger.info(f"Mode: {'stdin (piped frames)' if use_stdin else 'RTSP direct'}")
    logger.info(f"Relay: {config.RELAY_URL}")
    if not use_stdin:
        logger.info(f"RTSP source: {config.RTSP_URL}")
    logger.info(
        f"Min contour area: {config.MIN_CONTOUR_AREA}px\u00b2 "
        f"(at {config.REFERENCE_WIDTH}px reference width)"
    )
    logger.info(f"Notification cooldown: {config.NOTIFICATION_COOLDOWN_SEC}s")

    # See config.CV_THREADS: single-threaded OpenCV is cheaper for small frames
    # and leaves the other cores to ffmpeg on Pi-class hardware.
    cv2.setNumThreads(config.CV_THREADS)

    loop = asyncio.get_event_loop()

    stop_event = asyncio.Event()

    def _signal_handler():
        logger.info("Shutdown signal received.")
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _signal_handler)
        except NotImplementedError:
            pass

    relay_task = asyncio.create_task(relay_connection_loop(stop_event))

    # Choose motion loop based on mode
    if use_stdin:
        motion_task = asyncio.create_task(run_motion_loop_stdin(loop, stop_event))
    else:
        motion_task = asyncio.create_task(run_motion_loop(loop, stop_event))

    stop_wait_task = asyncio.create_task(stop_event.wait())

    try:
        done, pending = await asyncio.wait(
            {relay_task, motion_task, stop_wait_task},
            return_when=asyncio.FIRST_COMPLETED,
        )

        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

        # If a loop task failed, surface the error.
        for task in done:
            if task is stop_wait_task:
                continue
            exc = task.exception()
            if exc:
                raise exc
    finally:
        logger.info("Motion detector stopped.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Interrupted.")
        sys.exit(0)
