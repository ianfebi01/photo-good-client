"""
Photobooth camera sidecar.

Holds ONE libgphoto2 camera object for the whole process and exposes it over
HTTP to the Next.js app:

    GET  /status   -> {"connected": bool, "model": str | null}
    GET  /preview  -> multipart/x-mixed-replace MJPEG live view
    POST /capture  -> full-resolution JPEG bytes

Why a sidecar (vs. spawning the gphoto2 CLI)? A real binding lets us call
camera.exit()/init() to re-bind to a reconnected camera *in-process*. So when
the camera is unplugged and plugged back in, the preview stream self-heals and
captures keep working WITHOUT restarting anything. One lock serializes preview
and capture, so a shot briefly pauses live view (the HTTP connection stays open,
so the browser just holds the last frame) instead of tearing the stream down.
"""

import json
import os
import platform
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import gphoto2 as gp

HOST = os.environ.get("CAMERA_SERVICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("CAMERA_SERVICE_PORT", "8088"))
BOUNDARY = "photoboothframe"
# Target preview cadence; capture_preview latency is usually the real limiter.
PREVIEW_MIN_INTERVAL = 1 / 25
IS_DARWIN = platform.system() == "Darwin"


class CameraManager:
    """Owns the single camera object and recovers it across disconnects."""

    def __init__(self):
        self._lock = threading.Lock()
        self._camera = None
        self._model = None

    def _free_macos_claim(self):
        # macOS auto-claims PTP cameras via this assistant; evict it so our
        # process can take the device after a (re)connect.
        if IS_DARWIN:
            try:
                subprocess.run(
                    ["killall", "cameracaptured"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=3,
                )
            except Exception:
                pass

    def _ensure(self):
        """Connect to the camera if not already; raises gp.GPhoto2Error if none."""
        if self._camera is not None:
            return
        self._free_macos_claim()
        camera = gp.Camera()
        camera.init()  # raises GP_ERROR_MODEL_NOT_FOUND when nothing is attached
        self._camera = camera
        try:
            self._model = camera.get_abilities().model
        except gp.GPhoto2Error:
            self._model = None

    def _reset(self):
        """Drop the current camera session so the next _ensure() rebinds cleanly."""
        camera = self._camera
        self._camera = None
        self._model = None
        if camera is not None:
            try:
                camera.exit()
            except Exception:
                pass

    def status(self):
        with self._lock:
            try:
                self._ensure()
                return {"connected": True, "model": self._model}
            except gp.GPhoto2Error:
                self._reset()
                return {"connected": False, "model": None}

    def preview_frame(self) -> bytes:
        with self._lock:
            self._ensure()
            try:
                camera_file = self._camera.capture_preview()
                return memoryview(camera_file.get_data_and_size()).tobytes()
            except gp.GPhoto2Error:
                self._reset()  # likely unplugged — rebind on next call
                raise

    def capture(self) -> bytes:
        with self._lock:
            self._ensure()
            try:
                path = self._camera.capture(gp.GP_CAPTURE_IMAGE)
                camera_file = self._camera.file_get(
                    path.folder, path.name, gp.GP_FILE_TYPE_NORMAL
                )
                data = memoryview(camera_file.get_data_and_size()).tobytes()
                try:
                    self._camera.file_delete(path.folder, path.name)
                except gp.GPhoto2Error:
                    pass
                return data
            except gp.GPhoto2Error:
                self._reset()
                raise


manager = CameraManager()


# Allowed origins for CORS (browser direct-connect). Comma-separated list, or
# "*" to allow any origin (easier for local dev). Defaults to the production
# domain so browsers on any device can reach the local camera service.
ALLOWED_ORIGINS = os.environ.get(
    "CAMERA_CORS_ORIGINS",
    "https://photo-good.ianfebisastrataruna.my.id,http://localhost:3000",
)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # quiet by default
        pass

    def _cors_header(self, origin: str | None) -> str | None:
        """Return the Access-Control-Allow-Origin value, or None to skip."""
        if not origin:
            return None
        if ALLOWED_ORIGINS == "*":
            return "*"
        for allowed in ALLOWED_ORIGINS.split(","):
            if origin == allowed.strip():
                return origin
        return None

    def _send_cors(self):
        origin = self.headers.get("Origin")
        value = self._cors_header(origin)
        if value:
            self.send_header("Access-Control-Allow-Origin", value)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers", "Content-Type, Authorization"
            )
            self.send_header("Access-Control-Max-Age", "86400")

    def handle_one_request(self):
        # The app aborts /status on a short timeout and closes preview/capture
        # connections when the user navigates away. Treat the resulting client
        # disconnect as a normal end-of-request instead of an unhandled crash.
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._send_cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/status"):
            self._send_json(manager.status())
        elif self.path.startswith("/preview"):
            self._stream_preview()
        else:
            self._send_json({"error": "not found"}, status=404)

    def do_POST(self):
        if self.path.startswith("/capture"):
            self._do_capture()
        else:
            self._send_json({"error": "not found"}, status=404)

    def _do_capture(self):
        try:
            jpeg = manager.capture()
        except gp.GPhoto2Error as err:
            self._send_json({"error": f"capture failed: {err}"}, status=503)
            return
        except Exception as err:  # noqa: BLE001
            self._send_json({"error": f"capture failed: {err}"}, status=500)
            return
        self.send_response(200)
        self._send_cors()
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(jpeg)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(jpeg)

    def _stream_preview(self):
        self.send_response(200)
        self._send_cors()
        self.send_header(
            "Content-Type", f"multipart/x-mixed-replace; boundary={BOUNDARY}"
        )
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.end_headers()

        # One long-lived connection. On camera error we keep the connection open
        # and keep retrying, so live view returns by itself once the camera is
        # back — no client reconnect or app restart needed.
        while True:
            started = time.monotonic()
            try:
                frame = manager.preview_frame()
            except gp.GPhoto2Error:
                time.sleep(0.4)  # camera missing/busy — pause, then retry
                continue
            except Exception:  # noqa: BLE001
                time.sleep(0.4)
                continue
            try:
                self.wfile.write(
                    (
                        f"--{BOUNDARY}\r\n"
                        f"Content-Type: image/jpeg\r\n"
                        f"Content-Length: {len(frame)}\r\n\r\n"
                    ).encode("ascii")
                )
                self.wfile.write(frame)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ValueError):
                break  # client went away
            elapsed = time.monotonic() - started
            if elapsed < PREVIEW_MIN_INTERVAL:
                time.sleep(PREVIEW_MIN_INTERVAL - elapsed)


def main():
    # libgphoto2 does a one-time driver + USB port scan on the first init(),
    # which can take several seconds. Warm it up off-thread so the first real
    # /status poll from the app is fast.
    threading.Thread(target=manager.status, daemon=True).start()

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[camera-service] listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        manager._reset()
        server.server_close()


if __name__ == "__main__":
    main()
