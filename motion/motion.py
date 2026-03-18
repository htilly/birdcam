#!/usr/bin/env python3
"""
Birdcam Motion Detector
=======================
Detects motion using OpenCV MOG2 background subtraction.
Sends bounding box data to the Node.js server via WebSocket.

Two modes:
1. RTSP mode (legacy): Opens RTSP stream directly with OpenCV
2. Stdin mode (recommended): Reads raw BGR24 frames from stdin (piped from ffmpeg)
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


# Mutable config (can be updated by clients at runtime)
runtime_config = {
    "min_area": config.MIN_CONTOUR_AREA,
    "threshold_fraction": config.MOTION_THRESHOLD_FRACTION,
    "cooldown_sec": config.NOTIFICATION_COOLDOWN_SEC,
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


async def handle_relay_message(raw: str):
    """Handle messages forwarded from browser clients via the Node.js relay."""
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return

    msg_type = msg.get("type")

    if msg_type == "config_update":
        if "min_area" in msg:
            runtime_config["min_area"] = max(100, int(msg["min_area"]))
        if "threshold_fraction" in msg:
            runtime_config["threshold_fraction"] = max(
                0.0001, min(1.0, float(msg["threshold_fraction"]))
            )
        if "cooldown_sec" in msg:
            runtime_config["cooldown_sec"] = max(5, int(msg["cooldown_sec"]))
        logger.info(f"Config updated by browser: {runtime_config}")
        await send_to_relay({"type": "config", **runtime_config})

    elif msg_type == "subscribe":
        subscription = msg.get("subscription")
        if subscription and isinstance(subscription, dict):
            push_notifier.add_subscription(config.SUBSCRIPTIONS_FILE, subscription)
            await send_to_relay({"type": "subscribed", "ok": True})
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
            async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
                _relay_ws = ws
                attempt = 0
                logger.info("Connected to relay.")
                await ws.send(json.dumps({"type": "config", **runtime_config}))
                async for raw in ws:
                    if stop_event.is_set():
                        break
                    await handle_relay_message(raw)
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


def build_detector():
    """Create and return a fresh MOG2 background subtractor."""
    return cv2.createBackgroundSubtractorMOG2(
        history=config.BG_HISTORY,
        varThreshold=50,
        detectShadows=False,
    )


def process_frame(frame, bg_subtractor) -> tuple[bool, list, int, int]:
    """
    Apply motion detection to a single frame.

    Returns:
        (motion_detected, boxes, frame_w, frame_h)
        boxes = list of {"x", "y", "w", "h", "area"} dicts
    """
    # Resize for processing speed
    h, w = frame.shape[:2]
    scale = config.PROCESS_WIDTH / w
    proc_w = config.PROCESS_WIDTH
    proc_h = int(h * scale)
    small = cv2.resize(frame, (proc_w, proc_h))

    # Convert to grayscale, blur to reduce noise
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    # Ensure blur kernel is odd
    k = config.BLUR_KERNEL | 1
    blurred = cv2.GaussianBlur(gray, (k, k), 0)

    # Background subtraction
    fg_mask = bg_subtractor.apply(blurred)

    # Morphological operations to fill holes and merge nearby regions
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    fg_mask = cv2.dilate(fg_mask, kernel, iterations=config.DILATE_ITERATIONS)
    fg_mask = cv2.erode(fg_mask, kernel, iterations=1)

    # Find contours
    contours, _ = cv2.findContours(fg_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # Scale factor to map coordinates back to original resolution
    inv_scale = 1.0 / scale

    boxes = []
    total_motion_area = 0
    frame_area = w * h

    for cnt in contours:
        area_small = cv2.contourArea(cnt)
        area_orig = area_small * (inv_scale**2)

        if area_orig < runtime_config["min_area"]:
            continue

        x, y, bw, bh = cv2.boundingRect(cnt)
        # Scale back to original frame coordinates
        boxes.append(
            {
                "x": int(x * inv_scale),
                "y": int(y * inv_scale),
                "w": int(bw * inv_scale),
                "h": int(bh * inv_scale),
                "area": int(area_orig),
            }
        )
        total_motion_area += area_orig

    motion_fraction = total_motion_area / frame_area if frame_area > 0 else 0
    motion_detected = motion_fraction >= runtime_config["threshold_fraction"]

    return motion_detected, boxes, w, h


async def run_motion_loop_stdin(
    loop: asyncio.AbstractEventLoop, stop_event: asyncio.Event
):
    """
    Motion detection loop reading raw BGR24 frames from stdin.
    Frames are piped from ffmpeg to avoid duplicate RTSP connection.
    """
    global last_notification_time
    bg_subtractor = build_detector()
    warmup_frames = 30

    frame_width = int(os.environ.get("MOTION_FRAME_WIDTH", "640"))
    frame_height = int(os.environ.get("MOTION_FRAME_HEIGHT", "360"))
    frame_size = frame_width * frame_height * 3  # BGR24 = 3 bytes per pixel

    logger.info(f"Reading frames from stdin: {frame_width}x{frame_height} BGR24")
    await send_to_relay(
        {"type": "status", "connected": True, "message": "Reading frames from stream."}
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
            frame = np.frombuffer(raw_frame, dtype=np.uint8).reshape(
                (frame_height, frame_width, 3)
            )

            # Skip detection during warmup (background model learning phase)
            if frame_count <= warmup_frames:
                _, _, _, _ = await asyncio.to_thread(
                    process_frame, frame, bg_subtractor
                )
                if frame_count == warmup_frames:
                    logger.info("Background model warmed up. Detection active.")
                await asyncio.sleep(0)
                continue

            motion_detected, boxes, fw, fh = await asyncio.to_thread(
                process_frame, frame, bg_subtractor
            )

            # Build and broadcast motion event
            event = {
                "type": "motion",
                "detected": motion_detected,
                "boxes": boxes,
                "frame_w": fw,
                "frame_h": fh,
                "camera_id": config.CAMERA_ID,
                "timestamp": datetime.now(timezone.utc)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z"),
            }

            await send_to_relay(event)

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
    bg_subtractor = build_detector()
    warmup_frames = 30  # Let background model stabilise before detecting

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
            bg_subtractor = build_detector()
            warmup_frames = 30
            continue

        logger.info("RTSP stream opened.")
        await send_to_relay(
            {"type": "status", "connected": True, "message": "Camera connected."}
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
                        process_frame, frame, bg_subtractor
                    )
                    if frame_count == warmup_frames:
                        logger.info("Background model warmed up. Detection active.")
                    await asyncio.sleep(0)  # Yield to event loop
                    continue

                motion_detected, boxes, fw, fh = await asyncio.to_thread(
                    process_frame, frame, bg_subtractor
                )

                # Build and broadcast motion event
                event = {
                    "type": "motion",
                    "detected": motion_detected,
                    "boxes": boxes,
                    "frame_w": fw,
                    "frame_h": fh,
                    "camera_id": camera_id or config.CAMERA_ID,
                    "timestamp": datetime.now(timezone.utc)
                    .isoformat(timespec="milliseconds")
                    .replace("+00:00", "Z"),
                }

                await send_to_relay(event)

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
        bg_subtractor = build_detector()
        warmup_frames = 30


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
    logger.info(f"Min contour area: {config.MIN_CONTOUR_AREA}px\u00b2")
    logger.info(f"Notification cooldown: {config.NOTIFICATION_COOLDOWN_SEC}s")

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
