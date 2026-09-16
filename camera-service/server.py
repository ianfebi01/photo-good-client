"""
Photobooth camera sidecar.

Owns whichever camera source the booth is set to and exposes it over HTTP to
the Next.js app:

    GET  /status   -> {"connected": bool, "model": str | null, "mode": str, ...}
    GET  /preview  -> multipart/x-mixed-replace MJPEG live view
    GET  /snapshot -> the newest live-view frame as one JPEG (a screenshot)
    POST /capture  -> full-resolution still, JPEG bytes (gphoto mode only)
    GET  /mode     -> the active source + the modes this host supports
    POST /mode     -> switch source: {"mode": "gphoto" | "uvc", "device": str}
    GET  /devices  -> capture devices ffmpeg can see (UVC mode)

Two modes, one live view:

- `gphoto` — a PTP camera via libgphoto2. Because we hold one camera object
  in-process we can call camera.exit()/init() to re-bind after an
  unplug/replug, so the preview self-heals WITHOUT restarting anything.
- `uvc` — a USB/HDMI video capture device read by ffmpeg (avfoundation on
  macOS, v4l2 on Linux). A capture device has no still path at all, so there a
  shot is *only ever* a screenshot of the newest video frame.

The live view is the single source of truth in both modes. One pump thread is
the only reader of the camera and BOTH /preview and /snapshot are served from
that one buffer, so the source is never asked for a frame by two callers at
once. A shot is a screenshot of the newest preview frame rather than a PTP
still, which means capturing never pauses the movie preview, never blocks on
the camera's file transfer, and costs a UVC device nothing. The steady traffic
also keeps a PTP body from dropping into its own auto-power-off between shots.
"""

import errno
import json
import os
import platform
import re
import shlex
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import gphoto2 as gp


def load_camera_env( root: str ) -> dict:
    """`CAMERA_*` settings from `<root>/.env` and `<root>/.env.local`.

    `pnpm camera` starts this process directly, so unlike the Next app it has no
    dotenv of its own — a setting that only lived in `.env` would silently do
    nothing here. Only CAMERA_* keys are read, so the sidecar never picks up the
    app's secrets. `.env.local` wins over `.env`, matching Next.js; a real
    environment variable still beats both (applied by the caller).
    """
    merged = {}
    for name in (".env", ".env.local"):
        try:
            with open(os.path.join(root, name), "r", encoding="utf-8") as fh:
                lines = fh.readlines()
        except OSError:
            continue
        for raw in lines:
            line = raw.strip()
            if not line.startswith("export "):
                if not line or line.startswith("#") or "=" not in line:
                    continue
            elif "=" not in line:
                continue
            else:
                line = line[len("export ") :]
            key, _, value = line.partition("=")
            key = key.strip()
            if not key.startswith("CAMERA_"):
                continue
            merged[key] = value.strip().strip( '"' ).strip( "'" )

    return merged


def _load_dotenv():
    """Apply the repo's CAMERA_* settings before anything reads them."""
    root = os.path.dirname( os.path.dirname( os.path.abspath( __file__ ) ) )
    for key, value in load_camera_env( root ).items():
        os.environ.setdefault( key, value )


_load_dotenv()

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

# ── Camera sources ───────────────────────────────────────────────────
#
# `uvc` is the default. `gphoto` is the only mode with a real still capture. `uvc`
# reads a video capture device as live video, so its "shot" is a screenshot —
# which is what /snapshot already is, making the switch a change of reader
# rather than a change of pipeline.
MODE_GPHOTO = "gphoto"
MODE_UVC = "uvc"
MODES = (MODE_GPHOTO, MODE_UVC)

# Cadence/size asked of the capture device. The device's own rate is the ceiling
# (most HDMI dongles do 1080p30 / 4K30), so this only ever drops frames.
UVC_FPS = 25
UVC_QUALITY = 4  # ffmpeg -q:v, 2 (best) .. 31 (worst)

# ── Baked-in black bars ──────────────────────────────────────────────
#
# A capture device hands us a fixed frame size (1920×1080 on essentially every
# dongle) and pads a differently-shaped signal into it, so a 3:2 camera arrives
# with black bars at the sides. Those bars are a property of the *signal*, not
# of any one consumer, so they are removed here — otherwise every preview frame,
# every shot and every recorded clip carries them.
#
# cropdetect reads *brightness*, so it cannot be trusted blindly: a dark scene
# can look like a border. A detection is therefore only accepted when the probe
# frames agree, the trim is symmetric (how a scaler pads) and it is small. Set
# CAMERA_UVC_CROP to "W:H:X:Y" to pin one by hand, or "none" to disable this.
UVC_CROP_PROBE_FRAMES = 8
UVC_CROP_PROBE_FPS = 4
# Only *near*-black counts as a bar: the pad a scaler adds is true black, while
# dark picture has some level in it. A permissive limit is how a shadowed wall
# gets mistaken for a border.
UVC_CROP_BLACK = 16
UVC_CROP_MAX_TRIM = 0.2      # never believe a crop that eats a fifth of a side
UVC_CROP_TOLERANCE = 8       # px of asymmetry a scaler may leave behind
# Aspects a padded signal can actually have (a camera's video output is 3:2,
# 4:3 or 16:9). A crop that lands on one of these is a signal shape; one that
# does not is content that merely looked black at the edge.
UVC_CROP_ASPECTS = (
    1.0, 1.25, 1.3333, 1.5, 1.6, 1.6667, 1.7778, 1.85, 1.9, 2.0, 2.35, 2.39,
)
UVC_CROP_ASPECT_TOLERANCE = 0.02
UVC_CROP_PATTERN = re.compile( r"crop=(\d{2,5}):(\d{2,5}):(\d{1,5}):(\d{1,5})" )
UVC_INPUT_SIZE = re.compile( r"Stream #0:0: Video: .*?(\d{2,5})x(\d{2,5})" )
# A requested capture mode, e.g. "1280x720" (see CAMERA_UVC_SIZE).
UVC_SIZE_PATTERN = re.compile( r"^\d{2,5}x\d{2,5}$" )

# Where the chosen source is remembered so a restart does not undo the toggle.
STATE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".camera-state.json"
)

# ffmpeg needs a moment to open the device; a source that has produced nothing
# yet is "warming up", not "broken".
UVC_START_GRACE = 10.0
# After this long with no frames the source is reported as disconnected (and
# the app falls back to its mock camera).
UVC_STALE_AFTER = 3.0
# How long /snapshot waits for the very first frame after a switch to UVC — a
# guest can tap the shutter before ffmpeg has delivered anything.
SNAPSHOT_WAIT = 2.0


def looks_like_text( data: bytes ) -> bool:
    """True when a non-JPEG chunk reads as ffmpeg's own output rather than image
    bytes — used only to decide whether a log line is worth printing."""
    if not data:
        return False
    sample = data[:400]
    printable = sum(
        1 for byte in sample if 32 <= byte < 127 or byte in (9, 10, 13)
    )
    return printable / len( sample ) > 0.9


def iter_jpeg_frames( buf: bytes ):
    """Pull every complete JPEG out of an MJPEG stream buffer.

    Returns `(frames, tail)`: `tail` is the unfinished trailing frame, which the
    caller keeps and prepends to the next chunk. 0xFF is byte-stuffed (0xFF 0x00)
    inside entropy-coded data, so a bare 0xFFD9 can only be a real EOI marker —
    which is what makes this safe without a full JPEG parser.

    Bytes that are not part of a frame (ffmpeg diagnostics, which we merge into
    stdout) are dropped, and if a buffer holds no start marker at all it is
    discarded rather than accumulated.
    """
    frames = []
    pos = 0
    while True:
        start = buf.find(b"\xff\xd8", pos)
        if start < 0:
            return frames, b""
        end = buf.find(b"\xff\xd9", start + 2)
        if end < 0:
            return frames, buf[start:]
        frames.append(buf[start : end + 2])
        pos = end + 2


def ffmpeg_available() -> bool:
    """True when the UVC reader can run on this host."""
    try:
        subprocess.run(
            ["ffmpeg", "-version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=True,
        )
        return True
    except Exception:  # noqa: BLE001 — missing binary, timeout, anything
        return False


def uvc_requested_size() -> list:
    """`-video_size WxH` for the mode CAMERA_UVC_SIZE asks for, or [] for the
    device default.

    A capture device exposes a fixed menu of modes, so this is a request rather
    than a guarantee: ffmpeg picks the closest thing it can, and /status reports
    the size that actually arrived. Ignored with a note when malformed, because a
    bad value here would otherwise surface as an unexplained missing preview.
    """
    size = os.environ.get("CAMERA_UVC_SIZE", "").strip()
    if not size:
        return []
    if not UVC_SIZE_PATTERN.match( size ):
        print(
            f"[camera-service] ignoring CAMERA_UVC_SIZE={size!r} "
            "(expected WxH, e.g. 1280x720)",
            flush=True,
        )
        return []

    return ["-video_size", size]


def uvc_input_args( device: str ) -> list:
    """ffmpeg *input specification* (input options plus `-i <source>`).

    CAMERA_UVC_INPUT_ARGS replaces this wholesale — the escape hatch for devices
    ffmpeg needs spelled out (a specific pixel format or video_size, a second
    capture device, a network source) and how this reader is exercised without
    hardware. CAMERA_UVC_SIZE is the plain way to ask for a capture mode.
    """
    override = os.environ.get("CAMERA_UVC_INPUT_ARGS")
    if override:
        return shlex.split( override )

    size = uvc_requested_size()

    if IS_DARWIN:
        # AVFoundation addresses devices by index ("0") or by name, and defaults
        # to yuv420p — which *no* UVC capture dongle accepts (they offer
        # uyvy422/yuyv422/nv12/0rgb/bgr0), so the pixel format has to be asked
        # for explicitly or ffmpeg never opens the device.
        return [
            "-f",
            "avfoundation",
            "-framerate",
            "30",
            "-pixel_format",
            "uyvy422",
            *size,
            "-i",
            device or "0",
        ]

    return ["-f", "v4l2", *size, "-i", device or "/dev/video0"]


def build_uvc_command( device: str, crop: str = "" ) -> list:
    """ffmpeg command that turns the capture device into an MJPEG stream.

    `crop` ("W:H:X:Y") is applied first, so the bars never reach a consumer and
    the size /status reports is the size the picture really is.

    stderr is merged into stdout on purpose: a failing device then cannot
    deadlock on a full stderr pipe, and `iter_jpeg_frames` ignores the text.
    """
    # CAMERA_UVC_FILTER appends to the rate filter — e.g. "transpose=1" for a
    # capture stick that presents its HDMI input rotated.
    extra = os.environ.get("CAMERA_UVC_FILTER", "").strip()

    filters = []
    if crop:
        filters.append( f"crop={crop}" )
    filters.append( f"fps={UVC_FPS}" )
    if extra:
        filters.append( extra )

    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        *uvc_input_args( device ),
        "-an",
        "-vf",
        ",".join( filters ),
        "-f",
        "mjpeg",
        "-q:v",
        str( UVC_QUALITY ),
        "-",
    ]


def pick_crop( size, crops ) -> str:
    """The crop worth applying, or "" when nothing convincing was detected.

    `size` is the frame the device delivers and `crops` the raw detections, in
    order. Deliberately strict: a wrong crop silently eats real picture, while
    refusing one only leaves the bars that were already there.
    """
    if not size or not crops:
        return ""
    width, height = size

    counts = {}
    for crop in crops:
        counts[crop] = counts.get( crop, 0 ) + 1
    crop, votes = max( counts.items(), key=lambda item: item[1] )
    if votes != len( crops ) or votes < 3:
        return ""

    w, h, x, y = ( int( part ) for part in crop )
    if ( w, h, x, y ) == ( width, height, 0, 0 ):
        return ""

    left, right = x, width - w - x
    top, bottom = y, height - h - y
    bars_x, bars_y = left or right, top or bottom

    # A scaler pads ONE axis. Black on both means the detector is reading the
    # scene, not the signal.
    if bars_x and bars_y:
        return ""
    if not ( bars_x or bars_y ):
        return ""

    # ...and it pads that axis evenly. This is the check that matters: with no
    # trim on the other axis the symmetry test is vacuous, so a band of dark
    # scene on one side only (262px off the right, measured on this booth's
    # stick) must fail here — cropping to it would cut real picture.
    if bars_x and abs( left - right ) > UVC_CROP_TOLERANCE:
        return ""
    if bars_y and abs( top - bottom ) > UVC_CROP_TOLERANCE:
        return ""

    # A real pad is a modest slice of one side (a 3:2 image in a 16:9 frame is
    # 8% each side, 4:3 is 12.5%).
    if max( left, right ) > width * UVC_CROP_MAX_TRIM:
        return ""
    if max( top, bottom ) > height * UVC_CROP_MAX_TRIM:
        return ""

    # And the result has to be a shape a signal can be — the tie-breaker that
    # rejects a crop which passes the geometry checks by coincidence.
    aspect = w / h
    if not any(
        abs( aspect - shape ) <= UVC_CROP_ASPECT_TOLERANCE * shape
        for shape in UVC_CROP_ASPECTS
    ):
        return ""

    return f"{w}:{h}:{x}:{y}"


def detect_uvc_crop( device: str ) -> str:
    """Probe the capture device once for the black bars it bakes in.

    Runs the same input through cropdetect and returns the crop the frames
    agree on, or "" for "no bars I am sure about". Takes about a second, and
    the reader only starts afterwards — the booth treats a source as warming up
    until frames arrive, so this is invisible to the guest.
    """
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "info",
        "-nostdin",
        *uvc_input_args( device ),
        "-an",
        "-vf",
        f"fps={UVC_CROP_PROBE_FPS},"
        f"cropdetect=limit={UVC_CROP_BLACK}:round=2:reset=0",
        "-frames:v",
        str( UVC_CROP_PROBE_FRAMES ),
        "-f",
        "null",
        "-",
    ]
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=20,
        )
    except Exception:  # noqa: BLE001 — a failed probe is not an error
        return ""

    text = proc.stderr.decode("utf-8", "replace")
    size_match = UVC_INPUT_SIZE.search( text )
    size = (
        ( int( size_match.group(1) ), int( size_match.group(2) ) )
        if size_match
        else None
    )

    return pick_crop( size, UVC_CROP_PATTERN.findall( text ) )


def uvc_crop_for( device: str ) -> str:
    """Explicit crop when one is configured, otherwise the detected one."""
    explicit = os.environ.get("CAMERA_UVC_CROP")
    if explicit is not None:
        value = explicit.strip()
        if value.lower() in ("none", "off", "0", ""):
            return ""

        return value

    return detect_uvc_crop( device )


def list_video_devices() -> list:
    """Capture devices this host can offer, best-effort: `[{id, label}]`.

    macOS: ffmpeg's AVFoundation list, which is both the discovery and the
    addressing ("0", "1", …). Linux: /dev/video*, named via v4l2-ctl when it is
    installed. Never raises — an empty list just means "let the operator type
    one in".
    """
    try:
        if IS_DARWIN:
            proc = subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-f",
                    "avfoundation",
                    "-list_devices",
                    "true",
                    "-i",
                    "",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=15,
            )
            devices, in_video = [], False
            for raw in proc.stderr.decode("utf-8", "replace").splitlines():
                line = raw.split("] ", 1)[-1].strip()
                if "AVFoundation video devices" in line:
                    in_video = True
                    continue
                if "AVFoundation audio devices" in line:
                    break
                if not in_video or not line.startswith("["):
                    continue
                index, _, label = line[1:].partition("]")
                devices.append({"id": index.strip(), "label": label.strip()})
            return devices

        import glob

        return [
            {"id": path, "label": os.path.basename( path )}
            for path in sorted( glob.glob("/dev/video*") )
        ]
    except Exception:  # noqa: BLE001
        return []


def load_state():
    """The mode/device/label this service was last switched to."""
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as fh:
            data = json.load( fh )
        mode = str( data.get("mode", "") ).strip().lower()
        device = data.get("device")
        label = data.get("label")
        return (
            mode if mode in MODES else None,
            str( device ) if device else None,
            str( label ) if label else None,
        )
    except Exception:  # noqa: BLE001 — missing/corrupt state is not an error
        return None, None, None


def save_state( mode: str, device: str, label: str = "" ):
    """Persist the choice. The label is stored because it, not the id, is what
    survives a replug on platforms that address devices positionally."""
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as fh:
            json.dump(
                {"mode": mode, "device": device or "", "label": label or ""}, fh
            )
    except Exception:  # noqa: BLE001 — a read-only checkout must still work
        pass


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
        # Rate is measured over a window rather than between two frames: ffmpeg
        # hands us several frames per read, so consecutive publishes are
        # near-simultaneous and a per-pair delta would report thousands of fps.
        self._rate_at = time.monotonic()
        self._rate_frames = 0
        self._frame_cv = threading.Condition()
        # Active source. `_gen` is bumped on every switch so the running reader
        # knows it is stale without having to touch it; the pump wakes up on
        # _mode_cv and picks the new source up.
        stored_mode, stored_device, stored_label = load_state()
        env_mode = os.environ.get("CAMERA_MODE", "").strip().lower()
        self._mode = env_mode if env_mode in MODES else ( stored_mode or MODE_UVC )
        # Explicit request only (env or a switch). A device remembered from a
        # previous run is kept to one side and re-resolved by name, because the
        # id it was stored as may point somewhere else by now.
        self._device = os.environ.get("CAMERA_UVC_DEVICE") or ""
        self._remembered = stored_device or ""
        self._remembered_label = stored_label or ""
        self._gen = 0
        self._mode_since = time.monotonic()
        self._mode_cv = threading.Condition( threading.Lock() )

    # ── camera source (mode) ─────────────────────────────────────────

    def _active_source(self):
        """(mode, device, generation) — the source the pump should be running."""
        with self._mode_cv:
            return self._mode, self._device, self._gen

    def _is_current(self, gen: int) -> bool:
        with self._mode_cv:
            return self._gen == gen

    def _wait_for_change(self, gen: int, timeout: float):
        """Sleep up to `timeout`, waking early when the source is switched."""
        deadline = time.monotonic() + timeout
        with self._mode_cv:
            while self._gen == gen:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                self._mode_cv.wait( remaining )

    def set_mode(self, mode: str, device=None) -> None:
        """Switch the reader. Raises ValueError for an unknown mode.

        The running reader is not killed from here — it notices the generation
        bump and tears down its own ffmpeg/camera handle between frames, so the
        device is never released while it is mid-read.
        """
        if mode not in MODES:
            raise ValueError(f"unknown mode: {mode}")

        with self._mode_cv:
            changed = mode != self._mode or (
                device is not None and device != self._device
            )
            if device is not None:
                self._device = str( device )
                if self._device != self._remembered:
                    # A different device: its label is unknown until the reader
                    # resolves it against a fresh device list.
                    self._remembered_label = ""
            self._mode = mode
            if not changed:
                return
            self._gen += 1
            self._mode_since = time.monotonic()
            with self._frame_cv:
                # Drop the old source's frame: a PTP still must never be served
                # as a UVC screenshot, or the other way round. The notify must
                # happen inside this block — Condition.notify() raises when the
                # lock is not held, which would abort the switch half-applied.
                self._frame = None
                self._frame_size = None
                self._fps = 0.0
                self._frame_cv.notify_all()
            # Wake the reader, whose waits are on _mode_cv.
            self._mode_cv.notify_all()
            mode, device = self._mode, self._device
            label = self._remembered_label

        save_state( mode, device, label )
        print(
            f"[camera-service] mode -> {mode} (device: {device or 'auto'})",
            flush=True,
        )

    def mode_state(self) -> dict:
        with self._mode_cv:
            mode, device = self._mode, self._device
        return {
            "mode": mode,
            "device": device or None,
            "modes": list( MODES ),
            "ffmpeg": ffmpeg_available(),
        }

    def _resolve_device(self, device: str) -> str:
        """The device to read, re-resolving a remembered choice by name.

        AVFoundation addresses devices positionally and those positions shift as
        cameras are plugged and unplugged, so a remembered *index* can quietly
        point at a different device next run. The label is therefore what a
        remembered choice is matched on, and a device that has since gone falls
        back to a fresh auto-pick rather than to whatever now sits at that
        index. A device requested right now (env var, or the booth's picker
        reading a fresh list) is used as given.
        """
        if os.environ.get("CAMERA_UVC_INPUT_ARGS"):
            return device

        devices = list_video_devices()
        if not devices:
            return device

        # A screen recorder is never the booth's camera, so it is excluded from
        # the *auto-pick* — otherwise a machine with one attached would select
        # it over a real camera. An explicit or remembered choice is matched
        # against the full list, since choosing one is the operator's call.
        candidates = [
            entry for entry in devices if "screen" not in entry["label"].lower()
        ] or devices

        chosen = (
            device
            or self._match_remembered( devices )
            or self._auto_pick( candidates )
        )
        label = next(
            ( entry["label"] for entry in devices if entry["id"] == chosen ), ""
        )

        with self._mode_cv:
            self._device = chosen or ""
            self._remembered = self._device
            self._remembered_label = label
        save_state( MODE_UVC, self._device, label )
        print(
            f"[camera-service] uvc device: {chosen or 'auto'} "
            f"({label or 'unknown'})",
            flush=True,
        )
        return chosen

    def _match_remembered(self, devices) -> str:
        """The remembered device, matched by name — never by a bare index."""
        if self._remembered_label:
            entry = next(
                (
                    e
                    for e in devices
                    if e["label"] == self._remembered_label
                ),
                None,
            )
            return entry["id"] if entry else ""

        # A state file from before labels were recorded: trust the id only if
        # that device is still attached under it, else let auto-pick decide.
        return ""

    def _auto_pick(self, candidates) -> str:
        """Most-specific first: an HDMI/USB capture stick, then anything that
        calls itself a capture device, then whatever is attached."""
        hints = ("usb", "hdmi", "capture")
        chosen = next(
            (
                entry
                for hint in hints
                for entry in candidates
                if hint in entry["label"].lower()
            ),
            candidates[0],
        )
        return chosen["id"]

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
        if self._active_source()[0] == MODE_UVC:
            return self._uvc_status()

        with self._lock:
            try:
                self._ensure()
                connected, model = True, self._model
            except gp.GPhoto2Error:
                self._reset()
                connected, model = False, None

        if not connected:
            return {
                "connected": False,
                "model": None,
                "mode": MODE_GPHOTO,
                "modes": list( MODES ),
            }

        with self._frame_cv:
            size, fps = self._frame_size, self._fps

        payload = {
            "connected": True,
            "model": model,
            "mode": MODE_GPHOTO,
            "modes": list( MODES ),
        }
        if size:
            payload["preview"] = {
                "width": size[0],
                "height": size[1],
                "fps": round( fps, 1 ),
            }
        return payload

    def _uvc_status(self):
        """Status for a capture device — there is no device to query here.

        Connected means "frames are arriving": a capture device has no query
        protocol, so the arrival of frames *is* the health check. A source that
        was switched to recently is reported as connected (with `warming: true`)
        so a cold start does not flash mock mode in the booth before ffmpeg has
        delivered its first frame.
        """
        with self._mode_cv:
            device = self._device
            since = self._mode_since
        with self._frame_cv:
            fresh = (
                self._frame is not None
                and time.monotonic() - self._frame_at <= UVC_STALE_AFTER
            )
            size, fps = self._frame_size, self._fps

        warming = not fresh and time.monotonic() - since <= UVC_START_GRACE
        payload = {
            "connected": fresh or warming,
            "model": device or None,
            "mode": MODE_UVC,
            "modes": list( MODES ),
            "device": device or None,
            "warming": warming,
        }
        if fresh and size:
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
        """Run the reader for whichever source is active, forever.

        One thread, one reader: the camera is never asked for a frame by two
        callers at once, and a mode switch tears the old reader down completely
        before the new one opens its device (so the PTP body and the capture
        device are never held at the same time).
        """
        reported_gen = -1
        while True:
            mode, device, gen = self._active_source()
            try:
                if mode == MODE_GPHOTO:
                    self._pump_gphoto( gen )
                else:
                    self._pump_uvc( device, gen )
            except Exception as err:  # noqa: BLE001 — never let the pump die
                # Never silent, and never repeated: a raise here leaves the
                # booth showing mock frames, and without this line there is
                # nothing in the log to say why.
                if gen != reported_gen:
                    reported_gen = gen
                    print(
                        f"[camera-service] {mode} reader failed: {err!r}",
                        flush=True,
                    )
            # Back off before starting the reader again, so a missing or dead
            # device cannot spin (a switch wakes this up immediately).
            self._wait_for_change( gen, 0.5 if mode == MODE_GPHOTO else 2.0 )

    def _publish(self, frame: bytes, now: float):
        """Hand the newest frame to every consumer (both modes)."""
        with self._frame_cv:
            self._frame = frame
            self._frame_seq += 1
            self._frame_at = now
            self._frame_size = jpeg_size( frame )
            self._rate_frames += 1
            span = now - self._rate_at
            if span >= 1.0:
                measured = self._rate_frames / span
                # Smoothed so /status reports a steady rate, not the jitter of
                # one window.
                self._fps = ( 0.7 * self._fps + 0.3 * measured ) if self._fps else measured
                self._rate_frames = 0
                self._rate_at = now
            self._frame_cv.notify_all()

    def _pump_gphoto(self, gen: int):
        """Pull live-view frames off the PTP body as fast as it delivers them."""
        failures = 0
        while self._is_current( gen ):
            started = time.monotonic()
            try:
                frame = self.preview_frame()
            except Exception:  # noqa: BLE001 — camera missing, asleep or busy
                failures += 1
                self._wait_for_change(
                    gen, min( 0.4 * failures, PUMP_MAX_BACKOFF )
                )
                continue
            failures = 0

            self._publish( frame, time.monotonic() )

            elapsed = time.monotonic() - started
            if elapsed < PREVIEW_MIN_INTERVAL:
                self._wait_for_change( gen, PREVIEW_MIN_INTERVAL - elapsed )

        # Source switched away: release the body here (never from the switch
        # itself) so camera.exit() can't race a capture_preview() in flight.
        with self._lock:
            self._reset()

    def _pump_uvc(self, device: str, gen: int):
        """Read MJPEG off ffmpeg's stdout — the only reader of the device.

        Everything that wants a frame (/preview, /snapshot, the countdown
        recorder) reads this one buffer, exactly as with the PTP pump, so a
        shot costs the device nothing and can never stall the live view.
        """
        device = self._resolve_device( device )
        # Bars are measured before the reader starts, so nothing ever sees them.
        crop = uvc_crop_for( device )
        cmd = build_uvc_command( device, crop )
        print(
            f"[camera-service] uvc crop: {crop or 'none'}",
            flush=True,
        )
        print(f"[camera-service] uvc reading: {' '.join( cmd )}", flush=True)

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            bufsize=0,
        )

        tail = b""
        announced = False
        try:
            while self._is_current( gen ):
                chunk = proc.stdout.read( 65536 )
                if not chunk:
                    break  # ffmpeg gave up: device busy, unplugged, bad args

                frames, tail = iter_jpeg_frames( tail + chunk )
                # Between frames (nothing buffered) anything that is not a JPEG
                # start marker is ffmpeg's own diagnostics, merged into stdout —
                # the only clue when a device cannot be opened at all.
                if not frames and not tail and not announced:
                    text = chunk.decode("utf-8", "replace").strip()
                    if text and looks_like_text( chunk ):
                        announced = True
                        print(f"[camera-service] uvc: {text[:400]}", flush=True)

                for frame in frames:
                    self._publish( frame, time.monotonic() )
        finally:
            try:
                proc.terminate()
                code = proc.wait( timeout=3 )
            except Exception:  # noqa: BLE001
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass
                code = None
            if code not in (0, -15, None) and self._is_current( gen ):
                print(
                    f"[camera-service] ffmpeg (uvc) exited with {code}",
                    flush=True,
                )

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

    def snapshot(self):
        """The newest live-view frame — literally what the guest last saw.

        In UVC mode this is the *only* capture there is (a capture device has no
        still path), so it waits briefly for the first frame instead of failing
        when a guest taps the shutter during startup. Returns None when the
        source has no frame to give.
        """
        mode = self._active_source()[0]

        with self._frame_cv:
            frame = self._frame
            fresh = (
                frame is not None
                and time.monotonic() - self._frame_at <= SNAPSHOT_MAX_AGE
            )
            if not fresh and mode == MODE_UVC:
                self._frame_cv.wait( SNAPSHOT_WAIT )
                frame = self._frame
                fresh = (
                    frame is not None
                    and time.monotonic() - self._frame_at <= UVC_STALE_AFTER
                )
        if fresh:
            return frame

        if mode == MODE_UVC:
            return None

        # Pump has nothing yet (camera just came back) — take one directly so a
        # shot is never silently dropped.
        return self.preview_frame()

    def capture(self) -> bytes:
        """A full-resolution still — which only a PTP body can produce.

        A capture device has no still: in UVC mode this is the screenshot that
        /snapshot serves, so both endpoints mean the same thing there.
        """
        if self._active_source()[0] == MODE_UVC:
            frame = self.snapshot()
            if frame is None:
                raise RuntimeError("capture device has produced no frame yet")
            return frame

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
    "https://photo-good.ianfebisastrataruna.my.id,http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000,http://127.0.0.1:3001",
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
        elif self.path.startswith("/mode"):
            self._send_json(manager.mode_state())
        elif self.path.startswith("/devices"):
            self._do_devices()
        else:
            self._send_json({"error": "not found"}, status=404)

    def do_POST(self):
        if self.path.startswith("/capture"):
            self._do_capture()
        elif self.path.startswith("/mode"):
            self._do_set_mode()
        else:
            self._send_json({"error": "not found"}, status=404)

    def _do_capture(self):
        try:
            jpeg = manager.capture()
        except gp.GPhoto2Error as err:
            self._send_json({"error": f"capture failed: {err}"}, status=503)
            return
        except RuntimeError as err:
            # UVC mode with nothing decoded yet — the source is not up, not broken.
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
        if not jpeg:
            self._send_json(
                {"error": "snapshot failed: no frame from the capture device yet"},
                status=503,
            )
            return
        self._send_jpeg(jpeg)

    def _do_devices(self):
        """Capture devices this host can offer (empty list is a valid answer)."""
        self._send_json(
            {
                "ffmpeg": ffmpeg_available(),
                "devices": list_video_devices(),
            }
        )

    def _do_set_mode(self):
        """Switch the camera source. Body: {"mode": str, "device": str?}."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw) if raw else {}
            if not isinstance(body, dict):
                raise ValueError("body must be an object")
        except ValueError:
            self._send_json({"error": "invalid JSON body"}, status=400)
            return

        mode = str(body.get("mode", "")).strip().lower()
        device = body.get("device")
        try:
            manager.set_mode(mode, None if device is None else str(device))
        except ValueError as err:
            self._send_json({"error": str(err)}, status=400)
            return

        self._send_json(manager.mode_state())

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
    # Claim the port FIRST. The camera itself is exclusive (PTP, and
    # AVFoundation for a capture device), so a second copy of this service that
    # started its reader before noticing the clash would fight the first one for
    # the device — and then fail anyway.
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as err:
        if err.errno == errno.EADDRINUSE:
            print(
                f"[camera-service] http://{HOST}:{PORT} is already in use — a "
                "camera service is already running. Nothing to do; stop that one "
                "(`lsof -nP -iTCP:%s -sTCP:LISTEN`) to restart it." % PORT,
                flush=True,
            )
            return
        raise

    # libgphoto2 does a one-time driver + USB port scan on the first init(),
    # which can take several seconds. The pump starts it off-thread, so it both
    # warms that up and has a frame waiting before the first client arrives.
    manager.start_pump()
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
