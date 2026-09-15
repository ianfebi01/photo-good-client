"""
Photobooth camera sidecar.

Holds ONE libgphoto2 camera object for the whole process and exposes it over
HTTP to the Next.js app:

    GET  /status   -> {"connected": bool, "model": str | null, "preview": {...}}
    GET  /preview  -> multipart/x-mixed-replace MJPEG live view
    GET  /snapshot -> the newest live-view frame as one JPEG (a screenshot)
    POST /capture  -> full-resolution still, JPEG bytes

Why a sidecar (vs. spawning the gphoto2 CLI)? A real binding lets us call
camera.exit()/init() to re-bind to a reconnected camera *in-process*. So when
the camera is unplugged and plugged back in, the preview stream self-heals and
captures keep working WITHOUT restarting anything.

The live view is the single source of truth. One pump thread pulls frames from
the camera as fast as it will deliver them, and BOTH /preview and /snapshot are
served from that one buffer, so the camera is never asked for a frame by two
callers at once. A shot is a screenshot of the newest preview frame rather than
a PTP still, which means capturing never pauses the movie preview and never
blocks on the camera's file transfer. The steady traffic also keeps the body
from dropping into its own auto-power-off between shots.
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
# A buffered frame older than this is stale — the pump has stopped delivering
# (camera unplugged, or just reconnected) — so /snapshot takes a fresh one
# instead of handing back a frame from before the gap.
SNAPSHOT_MAX_AGE = 2.0
# Longest the pump backs off to while no camera is attached, so a missing body
# costs one retry every few seconds rather than a USB rescan several times a
# second.
PUMP_MAX_BACKOFF = 3.0
IS_DARWIN = platform.system() == "Darwin"


def jpeg_size( data: bytes ):
    """(width, height) read straight out of a JPEG's SOF marker, or None.

    Reported through /status so the app can log the resolution it is actually
    getting — the difference between a 480×320 live view and a 1080p one is the
    whole reason this pipeline looks the way it does.
    """
    n = len( data )
    if n < 4 or data[0] != 0xFF or data[1] != 0xD8:
        return None
    i = 2
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        # SOF0–SOF15, minus the non-frame markers DHT (c4), JPG (c8) and DAC (cc).
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height = ( data[i + 5] << 8 ) | data[i + 6]
            width = ( data[i + 7] << 8 ) | data[i + 8]
            return ( width, height )
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        i += 2 + ( ( data[i + 2] << 8 ) | data[i + 3] )
    return None


class CameraManager:
    """Owns the single camera object and recovers it across disconnects."""

    def __init__(self):
        self._lock = threading.Lock()
        self._camera = None
        self._model = None
        # Newest live-view frame + pump bookkeeping. Written only by the pump
        # thread, read by every HTTP handler — all guarded by _frame_cv.
        self._frame = None
        self._frame_seq = 0
        self._frame_at = 0.0
        self._frame_size = None
        self._fps = 0.0
        self._frame_cv = threading.Condition()

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
                connected, model = True, self._model
            except gp.GPhoto2Error:
                self._reset()
                connected, model = False, None

        if not connected:
            return {"connected": False, "model": None}

        with self._frame_cv:
            size, fps = self._frame_size, self._fps

        payload = {"connected": True, "model": model}
        if size:
            payload["preview"] = {
                "width": size[0],
                "height": size[1],
                "fps": round( fps, 1 ),
            }
        return payload

    def preview_frame(self) -> bytes:
        with self._lock:
            self._ensure()
            try:
                camera_file = self._camera.capture_preview()
                return memoryview(camera_file.get_data_and_size()).tobytes()
            except gp.GPhoto2Error:
                self._reset()  # likely unplugged — rebind on next call
                raise

    # ── live-view pump ────────────────────────────────────────────────

    def start_pump(self):
        threading.Thread(target=self._pump_loop, daemon=True).start()

    def _pump_loop(self):
        """Pull live-view frames forever, as the camera's only reader.

        Everything that wants a frame reads this buffer, so the camera is never
        asked for one by two callers at once and a shot can never stall the
        stream behind a capture.
        """
        failures = 0
        prev = 0.0
        while True:
            started = time.monotonic()
            try:
                frame = self.preview_frame()
            except Exception:  # noqa: BLE001 — camera missing, asleep or busy
                failures += 1
                time.sleep( min( 0.4 * failures, PUMP_MAX_BACKOFF ) )
                continue
            failures = 0

            now = time.monotonic()
            with self._frame_cv:
                self._frame = frame
                self._frame_seq += 1
                self._frame_at = now
                self._frame_size = jpeg_size( frame )
                if prev and now > prev:
                    # Smoothed so /status reports a steady rate, not the jitter
                    # of a single frame pair.
                    self._fps = 0.8 * self._fps + 0.2 / ( now - prev )
                self._frame_cv.notify_all()
            prev = now

            elapsed = time.monotonic() - started
            if elapsed < PREVIEW_MIN_INTERVAL:
                time.sleep( PREVIEW_MIN_INTERVAL - elapsed )

    def next_frame( self, after_seq: int, timeout: float = 2.0 ):
        """Block until a frame newer than `after_seq`, then return the newest.

        A slow reader misses intermediate frames rather than falling behind:
        for live view the latest frame is the only interesting one.
        """
        with self._frame_cv:
            if self._frame is None or self._frame_seq == after_seq:
                self._frame_cv.wait( timeout )
            if self._frame is None:
                return None, after_seq
            return self._frame, self._frame_seq

    def snapshot(self) -> bytes:
        """The newest live-view frame — literally what the guest last saw."""
        with self._frame_cv:
            frame = self._frame
            fresh = (
                frame is not None
                and time.monotonic() - self._frame_at <= SNAPSHOT_MAX_AGE
            )
        if fresh:
            return frame
        # Pump has nothing yet (camera just came back) — take one directly so a
        # shot is never silently dropped.
        return self.preview_frame()

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
        elif self.path.startswith("/snapshot"):
            self._do_snapshot()
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
        self._send_jpeg(jpeg)

    def _do_snapshot(self):
        """One JPEG: the newest frame of the movie preview."""
        try:
            jpeg = manager.snapshot()
        except gp.GPhoto2Error as err:
            self._send_json({"error": f"snapshot failed: {err}"}, status=503)
            return
        except Exception as err:  # noqa: BLE001
            self._send_json({"error": f"snapshot failed: {err}"}, status=500)
            return
        self._send_jpeg(jpeg)

    def _send_jpeg(self, jpeg: bytes):
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

        # One long-lived connection, fed from the pump's buffer. The pump keeps
        # retrying the camera on its own, so live view returns by itself once
        # the camera is back — no client reconnect or app restart needed. While
        # the camera is away this just re-sends the last real frame instead of
        # tearing the connection down.
        seq = 0
        while True:
            frame, seq = manager.next_frame(seq)
            if frame is None:
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


def main():
    # libgphoto2 does a one-time driver + USB port scan on the first init(),
    # which can take several seconds. The pump starts it off-thread, so it both
    # warms that up and has a frame waiting before the first client arrives.
    manager.start_pump()

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
