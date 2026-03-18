#!/bin/sh
set -eu

# If enabled, start the Python motion detector alongside the Node.js server.
# This keeps everything inside one container (single port/network namespace).
#
# Env:
#   ENABLE_MOTION_DETECTOR=true
#   MOTION_RELAY_URL=ws://127.0.0.1:3000/motion-ws?role=detector
#
# Args:
#   Command to run (e.g. "node server.js")

motion_pid=""

cleanup() {
  if [ -n "$motion_pid" ]; then
    kill "$motion_pid" 2>/dev/null || true
  fi
}

trap 'cleanup; exit 0' TERM INT

# Motion detector is now managed by Node.js (motionManager.js) — no longer launched here.
# The shell script remains for compatibility but doesn't start motion.py anymore.

# Run the main Node.js process (foreground).
"$@"
exit_code=$?

# If Node exits, stop motion too.
cleanup
wait 2>/dev/null || true

exit "$exit_code"

