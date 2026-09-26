#!/bin/sh
set -e

# Fix ownership of writable dirs if they were mounted/created as root
# (e.g. a fresh Docker volume for /app/data, or a tmpfs for /app/hls).
# Only recurse when the dir itself or one of its direct children has the wrong
# owner, so we don't walk a large motion_clips tree on every start.
fix_owner() {
  dir="$1"
  [ -d "$dir" ] || return 0
  if [ -n "$(find "$dir" -maxdepth 1 ! -user birdcam -print -quit)" ]; then
    chown -R birdcam:birdcam "$dir"
  fi
}

fix_owner /app/data
fix_owner /app/hls

# Drop to birdcam user and run the app
exec gosu birdcam "$@"
