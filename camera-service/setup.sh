#!/usr/bin/env bash
# Create the camera-service virtualenv and install python-gphoto2.
# Run once: `pnpm camera:setup` (or `bash camera-service/setup.sh`).
set -euo pipefail

cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

if [ ! -d .venv ]; then
  echo "[camera-service] creating venv with $PYTHON"
  "$PYTHON" -m venv .venv
fi

./.venv/bin/pip install --quiet --upgrade pip
./.venv/bin/pip install -r requirements.txt

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[camera-service] note: ffmpeg not found — UVC mode (USB/HDMI capture"
  echo "[camera-service]       device) needs it. Install with: brew install ffmpeg"
fi

echo "[camera-service] ready. Start it with: pnpm camera"
