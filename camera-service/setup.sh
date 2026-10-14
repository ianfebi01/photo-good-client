#!/usr/bin/env bash
# Create the camera-service virtualenv and install the camera bindings.
# Run once: `pnpm camera:setup` (or `bash camera-service/setup.sh`).
set -euo pipefail

cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

if [ ! -d .venv ]; then
  echo "[camera-service] creating venv with $PYTHON"
  "$PYTHON" -m venv .venv
fi

./.venv/bin/python3 -m pip install --quiet --upgrade pip
./.venv/bin/python3 -m pip install -r requirements.txt

echo "[camera-service] ready. PyAV is bundled in the virtualenv; start with: pnpm camera"
