# Camera service

A small Python sidecar that owns the camera and exposes it to the Next.js app
over HTTP. It reads **either** of two sources:

- **`gphoto`** — a PTP camera via [python-gphoto2](https://github.com/jim-easterbrook/python-gphoto2),
  a real libgphoto2 binding. It replaces shelling out to the `gphoto2` CLI.
  Because it holds one camera object in-process, it can call `camera.exit()` /
  `init()` to **rebind to a reconnected camera without restarting anything** —
  so unplug/replug recovers on its own.
- **`uvc`** (default) — a USB/HDMI video capture device, read as live video by `ffmpeg`
  (`avfoundation` on macOS, `v4l2` on Linux). Needs `ffmpeg` on the camera host.

The booth has a **camera source toggle** on the capture step that switches
between them; the choice is remembered in `.camera-state.json` next to this
file, so a service restart does not undo it.

## How the live view and shots fit together

The movie preview is the single source of truth, in **both** modes. One
background pump thread is the only reader of the camera, and both `/preview`
and `/snapshot` are served from that one buffer. Consequences worth knowing:

- The camera is never asked for a frame by two callers at once, so a shot can't
  stall the stream behind it.
- **A shot is a screenshot** of the newest live-view frame — no PTP still is
  driven, so nothing is transferred off a tethered body and the preview never
  freezes while the guest is posing into it. A capture device has no still path
  at all, so there a screenshot is the only capture there is (in `uvc` mode
  `POST /capture` and `GET /snapshot` return the same thing).
- Because the preview keeps running, a capture no longer cuts a countdown clip
  short; the recording ends on its `-t` deadline instead.
- The steady traffic also stops a PTP body dropping into its own auto-power-off
  between shots.

The trade-off is resolution: a screenshot is whatever the source delivers.
The EOS M6 reports `liveviewsize = Small` (its only choice) and delivers
**480×320** — see `/status`, which reports the measured size and rate. That is a
property of the body's PTP live view, not of this code. An HDMI→USB capture
device measured **1920×1080 @ ~22 fps**, which is the reason to use `uvc` mode:
it raises the preview *and* the countdown clip quality at the same time (the
clip is recorded by ffmpeg reading this `/preview` stream). `POST /capture`
still returns a full-resolution still (3984×2656 on an M6) in `gphoto` mode.

## Endpoints

| Method | Path        | Returns                                                    |
| ------ | ----------- | ---------------------------------------------------------- |
| GET    | `/status`   | `{ "connected": bool, "model": str \| null, "mode": str, "device": str \| null, "preview": { "width", "height", "fps" } }` |
| GET    | `/preview`  | `multipart/x-mixed-replace` MJPEG live view                |
| GET    | `/snapshot` | newest live-view frame as one `image/jpeg` (a screenshot)  |
| POST   | `/capture`  | full-resolution `image/jpeg` bytes (`gphoto`); a screenshot in `uvc` |
| GET    | `/mode`     | `{ "mode", "device", "modes", "ffmpeg" }`                  |
| POST   | `/mode`     | switch source — body `{ "mode": "gphoto"\|"uvc", "device": str? }` |
| GET    | `/devices`  | `{ "ffmpeg": bool, "devices": [{ "id", "label" }] }`     |

Both `POST /mode` and `/status` are used by the app's `/api/camera/mode` route,
which is what the booth toggle calls.

## Setup & run

```bash
pnpm camera:setup   # one-time: create venv + install python-gphoto2
pnpm camera         # start the service (default http://127.0.0.1:8088)
```

Run it alongside `pnpm dev` in a second terminal. Starting it twice is harmless:
if the port is taken the new process says so and exits **without** touching the
camera (the device is exclusive, so a second reader would fight the first).

## Configuration

Environment variables (read by both the service and the Next.js app):

> The service reads `CAMERA_*` keys from the repo's `.env` and `.env.local`
> itself (`.env.local` wins, matching Next.js), so one file configures both. It
> deliberately reads *nothing else* from there, keeping the app's secrets out of
> the camera process. A real environment variable still beats the files:
> `CAMERA_UVC_SIZE=1280x720 pnpm camera`.

- `CAMERA_SERVICE_HOST` / `CAMERA_SERVICE_PORT` — bind address (default `127.0.0.1:8088`)
- `CAMERA_SERVICE_URL` — full base URL the Next.js server uses to reach the service
  (default `http://127.0.0.1:8088`)
- `PHOTOBOOTH_MOCK=1` — force the simulated camera (no service needed)
- `CAMERA_CORS_ORIGINS` — comma-separated allowed CORS origins for browser
  direct-connect (default: `https://photo-good.ianfebisastrataruna.my.id,http://localhost:3000`)

UVC mode:

- `CAMERA_MODE` — `uvc` (default) or `gphoto`; a *starting point* only. The
  toggle's choice wins and is remembered in `.camera-state.json`.
- `CAMERA_UVC_DEVICE` — the capture device to read: an AVFoundation index
  (`0`) or name on macOS, a `/dev/video*` path on Linux. Unset, the service
  auto-selects by name preference (usb → hdmi → capture → first device) and
  reports the choice via `/status`. **Prefer the name on macOS** — indices are
  positional and shift as cameras come and go, so `0` is not a stable identity
  (`CAMERA_UVC_DEVICE="USB Video"`).
- `CAMERA_UVC_SIZE` — the capture mode to ask the device for, as `WxH`
  (`1920x1080`, `1280x720`, `640x480`). **This is the resolution setting.**
  Unset, the device's own default is used (1920×1080 on most sticks). A device
  exposes a fixed menu of modes, so it is a *request*: ffmpeg takes the closest
  it can and `/status` reports the size that actually arrived — verified on this
  booth, `1280x720` → 1280×720 and `640x480` → 640×480. Nothing downstream
  rescales the picture, since upscaling adds no detail; asking the device is the
  only real way to change it. A malformed value is ignored with a note in the log.
- `CAMERA_UVC_INPUT_ARGS` — replaces the whole ffmpeg input specification
  (options **and** `-i <source>`). The escape hatch for a capture device ffmpeg
  needs spelled out: a specific `-video_size`, `-framerate` or `-pixel_format`,
  a second capture device, or a non-USB source such as RTSP. Also how the UVC
  reader is exercised without hardware, e.g.
  `CAMERA_UVC_INPUT_ARGS="-f lavfi -i testsrc2=size=1280x720:rate=30"`.
- `CAMERA_UVC_CROP` — the black bars a capture device bakes into its frames.
  Defaults to **auto-detect**: on each start the service probes with
  `cropdetect` (~3 s, before any frame is served) and crops only when the probe
  frames **all** agree on the same crop, the bars sit on exactly **one** axis,
  are symmetric *on that axis*, trim under a fifth of a side, and leave a shape
  a signal can really be (3:2, 4:3, 16:9, …). Anything else means "not a bar" and
  the frame is left alone — `cropdetect` reads *brightness*, so a dark scene,
  a shadowed wall or the black column of SMPTE bars all look like a border, and a
  wrong crop silently eats real picture while refusing one only leaves bars.
  Set it to `W:H:X:Y` to pin one by hand (`1620:1080:150:0` for a 3:2 camera on
  a 1920×1080 stick — also faster, since nothing is probed) or to `none` to
  leave the frames untouched. A pinned crop **must match the size in use**: the
  bars of a 1920×1080 frame are not the bars of a 1280×720 one, so if you set
  `CAMERA_UVC_SIZE`, leave this on auto-detect.
- `CAMERA_UVC_FILTER` — extra ffmpeg video filters appended after the rate cap,
  e.g. `transpose=1` for a capture stick that presents its HDMI input rotated.

### Why frames can arrive with black bars

A capture device hands us a fixed frame size (1920×1080 on essentially every
HDMI dongle) and *pads* a differently-shaped signal into it, so a 3:2 camera
arrives pillarboxed — 150px of black at each side on a 1920×1080 frame, as this
booth's stick does. The bars are a property of the signal, so they are removed
at the source: otherwise the guest sees them in the preview, and every shot, the
countdown clips and the GIF carry them. `/status` reports the size **after** the
crop (1620×1080 here), which is the real shape of the picture.

> **macOS pixel format.** AVFoundation defaults to `yuv420p`, which UVC capture
> dongles reject (`Selected pixel format (yuv420p) is not supported by the input
> device`). The service therefore asks for `uyvy422` explicitly — without it
> ffmpeg never opens the device. If yours needs something else, override
> `CAMERA_UVC_INPUT_ARGS`.
>
> **Portrait output.** Some capture sticks negotiate a portrait mode on reopen
> (`/status` then reports `1080×1920` instead of `1920×1080`), which the booth's
> landscape preview crops. Pin the mode you want with
> `CAMERA_UVC_INPUT_ARGS="-f avfoundation -framerate 30 -pixel_format uyvy422
> -video_size 1920x1080 -i 0"`, or rotate with `CAMERA_UVC_FILTER=transpose=1`.
> Either way `/status` reports the size actually being received — check it after
> switching, because the booth composes into fixed slots.

## Picking a device

```bash
curl -s http://127.0.0.1:8088/devices          # [{"id":"0","label":"USB Video"}, …]
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"mode":"uvc","device":"0"}' http://127.0.0.1:8088/mode
curl -s http://127.0.0.1:8088/status           # mode + measured preview size/fps
```

The switch is live: the pump stops the current reader (releasing the PTP body
when leaving `gphoto`) and starts the other one, then `/preview` returns by
itself. In the booth, the toggle on the capture step does this for you and
restarts the preview.

## Browser direct-connect mode

When the Next.js app is deployed on a remote server but the camera is connected
to your local machine, set **`NEXT_PUBLIC_CAMERA_SERVICE_URL`** on the deployed
server. The browser then connects *directly* to the local camera service for
status, live preview, and capture — no tunnel needed.

**On the camera machine** (your local computer):

```bash
# Bind to all interfaces so other devices on the LAN can reach it
CAMERA_SERVICE_HOST=0.0.0.0 CAMERA_CORS_ORIGINS=* python3 server.py
```

**On the deployed server**, add to `.env.production`:

```
NEXT_PUBLIC_CAMERA_SERVICE_URL=http://192.168.1.100:8088
```

> Replace `192.168.1.100` with your local machine's LAN IP. Any device on the
> same network can then use the photobooth — camera ops hit your local machine,
> everything else (auth, frames, compose) goes through the server.

If the service is unreachable, the app automatically falls back to the mock
camera, so the UI still works without hardware.
