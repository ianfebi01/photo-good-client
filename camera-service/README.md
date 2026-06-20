# Camera service

A small Python sidecar that owns the camera via [python-gphoto2](https://github.com/jim-easterbrook/python-gphoto2)
(a real libgphoto2 binding) and exposes it to the Next.js app over HTTP.

It replaces shelling out to the `gphoto2` CLI. Because it holds one camera
object in-process, it can call `camera.exit()` / `init()` to **rebind to a
reconnected camera without restarting anything** — so unplug/replug recovers on
its own, and the live preview never has to be torn down for a capture.

## Endpoints

| Method | Path       | Returns                                            |
| ------ | ---------- | -------------------------------------------------- |
| GET    | `/status`  | `{ "connected": bool, "model": str \| null }`      |
| GET    | `/preview` | `multipart/x-mixed-replace` MJPEG live view        |
| POST   | `/capture` | full-resolution `image/jpeg` bytes                 |

## Setup & run

```bash
pnpm camera:setup   # one-time: create venv + install python-gphoto2
pnpm camera         # start the service (default http://127.0.0.1:8088)
```

Run it alongside `pnpm dev` in a second terminal.

## Configuration

Environment variables (read by both the service and the Next.js app):

- `CAMERA_SERVICE_HOST` / `CAMERA_SERVICE_PORT` — bind address (default `127.0.0.1:8088`)
- `CAMERA_SERVICE_URL` — full base URL the Next.js server uses to reach the service
  (default `http://127.0.0.1:8088`)
- `PHOTOBOOTH_MOCK=1` — force the simulated camera (no service needed)
- `CAMERA_CORS_ORIGINS` — comma-separated allowed CORS origins for browser
  direct-connect (default: `https://photo-good.ianfebisastrataruna.my.id,http://localhost:3000`)

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
