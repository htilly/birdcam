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
# Minimum contour area (in pixels²) to count as motion. Raise to ignore small changes.
MIN_CONTOUR_AREA = int(os.environ.get("MOTION_MIN_AREA", 1500))

# Fraction of frame area that must change to trigger a notification (0.0 - 1.0)
# e.g. 0.005 = 0.5% of the frame
MOTION_THRESHOLD_FRACTION = float(os.environ.get("MOTION_THRESHOLD_FRACTION", 0.005))

# Background subtractor history (frames). Higher = slower to adapt to changes.
BG_HISTORY = int(os.environ.get("MOTION_BG_HISTORY", 500))

# --- Frame Processing ---
# Resize frames to this width before processing (for performance). Height auto-scales.
PROCESS_WIDTH = int(os.environ.get("MOTION_PROCESS_WIDTH", 640))

# Gaussian blur kernel size (must be odd). Higher = less noise sensitivity.
BLUR_KERNEL = int(os.environ.get("MOTION_BLUR_KERNEL", 21))

# Morphological dilation iterations to merge nearby contours
DILATE_ITERATIONS = int(os.environ.get("MOTION_DILATE_ITERATIONS", 2))

# --- Cooldown ---
# Minimum seconds between push notifications (avoid spam)
NOTIFICATION_COOLDOWN_SEC = int(os.environ.get("MOTION_COOLDOWN_SEC", 30))

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

# --- Reconnect ---
# Seconds to wait before reconnecting to RTSP on failure
RECONNECT_DELAY_SEC = int(os.environ.get("MOTION_RECONNECT_DELAY", 5))

# --- Debug ---
# Set to True to show a debug window with overlays (requires display / X server)
DEBUG_WINDOW = os.environ.get("MOTION_DEBUG_WINDOW", "false").lower() == "true"
