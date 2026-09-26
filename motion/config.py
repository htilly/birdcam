# =============================================================================
# Birdcam Motion Detection - Configuration
# =============================================================================
# Copy this file and edit as needed. All values can be overridden with env vars.

import os

# --- Camera ---
# RTSP stream URL for the camera to monitor.
# If unset, motion.py will read the RTSP URL from the Birdcam SQLite DB.
RTSP_URL = os.environ.get("MOTION_RTSP_URL", "")

# --- Motion Detection Thresholds ---
# Spatial settings below (MIN_CONTOUR_AREA, BLUR_KERNEL, MORPH_KERNEL) are expressed
# relative to a REFERENCE_WIDTH-wide frame (640x360, the historical motion frame size)
# and scaled to the actual processing size by motion.py. That keeps existing
# configured values (e.g. admin UI min_area 600/1500/4000) meaning the same physical
# region size regardless of the frame size ffmpeg delivers or PROCESS_WIDTH.
REFERENCE_WIDTH = 640

# Minimum contour area (in pixels² of a 640-wide reference frame) to count as
# motion. Raise to ignore small changes.
MIN_CONTOUR_AREA = int(os.environ.get("MOTION_MIN_AREA", 1500))

# Fraction of frame area that must change to trigger a notification (0.0 - 1.0)
# e.g. 0.005 = 0.5% of the frame
MOTION_THRESHOLD_FRACTION = float(os.environ.get("MOTION_THRESHOLD_FRACTION", 0.005))

# Background subtractor history (frames). Higher = slower to adapt to changes.
BG_HISTORY = int(os.environ.get("MOTION_BG_HISTORY", 500))

# --- Frame Processing ---
# Downscale frames wider than this before processing (for performance). Height
# auto-scales. Frames already this size or smaller are used as-is (never upscaled);
# the stdin pipeline delivers 320x180 so no resize happens there.
PROCESS_WIDTH = int(os.environ.get("MOTION_PROCESS_WIDTH", 320))

# Gaussian blur kernel size at REFERENCE_WIDTH. Higher = less noise sensitivity.
# Scaled to the processing width and forced odd (21 @ 640px -> 11 @ 320px).
BLUR_KERNEL = int(os.environ.get("MOTION_BLUR_KERNEL", 21))

# Elliptical morphology kernel size at REFERENCE_WIDTH (5 @ 640px -> 3 @ 320px).
MORPH_KERNEL = int(os.environ.get("MOTION_MORPH_KERNEL", 5))

# Morphological dilation iterations to merge nearby contours
DILATE_ITERATIONS = int(os.environ.get("MOTION_DILATE_ITERATIONS", 2))

# OpenCV worker threads. Frames are tiny (320x180), so splitting each op across
# threads costs more in dispatch/sync than it saves, and on a Pi-class device the
# extra threads compete with ffmpeg (which is encoding the live stream) for cores.
CV_THREADS = int(os.environ.get("MOTION_CV_THREADS", 1))

# --- Event rate ---
# Motion events go to the Node relay, which forwards each one to every browser.
# Instead of one per processed frame (~10/s), send on state change, then at most
# every ACTIVE_EVENT_INTERVAL_SEC while motion continues, and an idle heartbeat
# every IDLE_EVENT_INTERVAL_SEC otherwise. ACTIVE_EVENT_INTERVAL_SEC must stay
# well below the server's recording_cooldown_sec (min 1s), see motion.py.
ACTIVE_EVENT_INTERVAL_SEC = 0.5
IDLE_EVENT_INTERVAL_SEC = 5.0

# --- Cooldown ---
# Minimum seconds between push notifications (avoid spam)
NOTIFICATION_COOLDOWN_SEC = int(os.environ.get("MOTION_COOLDOWN_SEC", 30))

# Seconds without motion before recording stops
RECORDING_COOLDOWN_SEC = int(os.environ.get("MOTION_RECORDING_COOLDOWN_SEC", 3))

# --- WebSocket Relay ---
# motion.py connects as a client to the Node.js server on this URL.
# In Docker, use ws://birdcam:3000/motion-ws?role=detector (service name)
RELAY_URL = os.environ.get(
    "MOTION_RELAY_URL", "ws://127.0.0.1:3000/motion-ws?role=detector"
)

# --- Camera Identity (stdin mode) ---
# When running with --stdin (frames piped from Node), the camera ID is passed here.
# Default 1 so the server always gets a valid id (cameras usually start at 1).
CAMERA_ID = int(os.environ.get("MOTION_CAMERA_ID", 1)) or 1

# --- Web Push (VAPID) ---
# Generate these with: python generate_keys.py
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_CLAIMS_SUB = os.environ.get("VAPID_CLAIMS_SUB", "mailto:admin@example.com")

# Path to file where browser push subscriptions are stored (JSON array)
SUBSCRIPTIONS_FILE = os.environ.get(
    "SUBSCRIPTIONS_FILE", "/app/data/subscriptions.json"
)

# --- Warmup ---
# Number of frames to skip detection while background model stabilizes.
# Higher = fewer false positives at startup, but longer delay before detection begins.
# At 10fps: 100 frames ≈ 10s, 200 frames ≈ 20s, 500 frames ≈ 50s (matches BG_HISTORY)
WARMUP_FRAMES = int(os.environ.get("MOTION_WARMUP_FRAMES", 100))

# --- Reconnect ---
# Seconds to wait before reconnecting to RTSP on failure
RECONNECT_DELAY_SEC = int(os.environ.get("MOTION_RECONNECT_DELAY", 5))

# --- Debug ---
# Set to True to show a debug window with overlays (requires display / X server)
DEBUG_WINDOW = os.environ.get("MOTION_DEBUG_WINDOW", "false").lower() == "true"
