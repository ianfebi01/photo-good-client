import "server-only";

import type { CameraDevice, CameraMode } from "@/types/booth";

/**
 * Thin client for the Python camera sidecar (see camera-service/). The sidecar
 * owns the camera via libgphoto2 and recovers across USB reconnects in-process,
 * so the app just talks HTTP to it. When it is unreachable, callers fall back to
 * the mock camera.
 */

export const SIDECAR_URL =
  process.env.CAMERA_SERVICE_URL ??
  `http://${process.env.CAMERA_SERVICE_HOST ?? "127.0.0.1"}:${
    process.env.CAMERA_SERVICE_PORT ?? "8088"
  }`;

export type SidecarStatus = {
  connected: boolean;
  model?: string | null;
  /** Which source the service is reading. */
  mode?: CameraMode;
  /** Source the service supports (older builds omit this). */
  modes?: CameraMode[];
  /** Capture device `uvc` mode is reading. */
  device?: string | null;
  /** True while a freshly-selected source has not produced a frame yet. */
  warming?: boolean;
  /** Measured size/rate of the live view the sidecar is actually getting. */
  preview?: { width: number; height: number; fps: number };
};

/** GET /mode — the active source plus what this camera host can offer. */
export type SidecarModeState = {
  mode: CameraMode;
  device: string | null;
  modes?: CameraMode[];
  /** False when the host has no ffmpeg, so UVC mode cannot run. */
  ffmpeg?: boolean;
};

/** GET /devices — capture devices ffmpeg can see. */
export type SidecarDeviceList = {
  ffmpeg: boolean;
  devices: CameraDevice[];
};

/** GET /status. Returns null when the sidecar itself is unreachable/timed out. */
export async function sidecarStatus(
  timeoutMs = 2_000,
): Promise<SidecarStatus | null> {
  const controller = new AbortController();
  const timer = setTimeout( () => controller.abort(), timeoutMs );
  try {
    const res = await fetch( `${SIDECAR_URL}/status`, {
      signal : controller.signal,
      cache  : "no-store",
    } );
    if ( !res.ok ) return null;

    return ( await res.json() ) as SidecarStatus;
  } catch {
    return null;
  } finally {
    clearTimeout( timer );
  }
}

/** POST /capture — full-resolution JPEG bytes. Throws on failure. */
export async function sidecarCapture( timeoutMs = 40_000 ): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout( () => controller.abort(), timeoutMs );
  try {
    const res = await fetch( `${SIDECAR_URL}/capture`, {
      method : "POST",
      signal : controller.signal,
      cache  : "no-store",
    } );
    if ( !res.ok ) {
      let detail = `capture failed (${res.status})`;
      try {
        const body = await res.json();
        if ( body?.error ) detail = String( body.error );
      } catch {}
      throw new Error( detail );
    }

    return Buffer.from( await res.arrayBuffer() );
  } finally {
    clearTimeout( timer );
  }
}

/**
 * GET /snapshot — the newest live-view frame as one JPEG.
 *
 * This is what a shot is: a screenshot of the movie preview, taken from the
 * frame the sidecar is already streaming. It costs no camera time — nothing is
 * driven and nothing is pulled off the body — so the preview keeps running and
 * the countdown clip is never cut short by a capture.
 */
export async function sidecarSnapshot( timeoutMs = 8_000 ): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout( () => controller.abort(), timeoutMs );
  try {
    const res = await fetch( `${SIDECAR_URL}/snapshot`, {
      signal : controller.signal,
      cache  : "no-store",
    } );
    if ( !res.ok ) {
      let detail = `snapshot failed (${res.status})`;
      try {
        const body = await res.json();
        if ( body?.error ) detail = String( body.error );
      } catch {}
      throw new Error( detail );
    }

    return Buffer.from( await res.arrayBuffer() );
  } finally {
    clearTimeout( timer );
  }
}

/** The sidecar's live-preview MJPEG endpoint, proxied by the stream route. */
export const SIDECAR_PREVIEW_URL = `${SIDECAR_URL}/preview`;

/**
 * GET /mode — which source the camera service is reading.
 *
 * Switching source is what the booth's mode toggle does; both modes then serve
 * the same `/preview` + `/snapshot` pair, so nothing downstream changes.
 */
export async function sidecarMode(
  timeoutMs = 8_000,
): Promise<SidecarModeState | null> {
  return sidecarJson<SidecarModeState>( "/mode", timeoutMs );
}

/** GET /devices — capture devices this host can read, for the mode picker. */
export async function sidecarDevices(
  timeoutMs = 20_000,
): Promise<SidecarDeviceList | null> {
  return sidecarJson<SidecarDeviceList>( "/devices", timeoutMs );
}

/**
 * POST /mode — switch the camera source (`gphoto` ⇄ `uvc`).
 *
 * The service tears its current reader down and opens the other one; the booth
 * restarts its preview afterwards. Returns null when the service is
 * unreachable, and throws with the service's message for a rejected switch
 * (e.g. an unknown mode).
 */
export async function sidecarSetMode(
  mode: CameraMode,
  device?: string,
  timeoutMs = 20_000,
): Promise<SidecarModeState | null> {
  const controller = new AbortController();
  const timer = setTimeout( () => controller.abort(), timeoutMs );
  try {
    const res = await fetch( `${SIDECAR_URL}/mode`, {
      method  : "POST",
      headers : { "Content-Type" : "application/json" },
      body    : JSON.stringify( { mode, ...( device ? { device } : {} ) } ),
      signal  : controller.signal,
      cache   : "no-store",
    } );
    if ( !res.ok ) {
      // 404 means the service answered but has no /mode at all (an older build).
      // Its body would only say "not found", which tells the operator nothing.
      if ( res.status === 404 ) throw new Error( await cameraServiceHint() );

      let detail = `camera mode switch failed (${res.status})`;
      try {
        const body = await res.json();
        if ( body?.error ) detail = String( body.error );
      } catch {}
      throw new Error( detail );
    }

    return ( await res.json() ) as SidecarModeState;
  } catch ( err ) {
    if ( err instanceof Error && err.name === "AbortError" ) return null;
    if ( err instanceof TypeError ) return null; // service down / unreachable
    throw err;
  } finally {
    clearTimeout( timer );
  }
}

/** Shared GET + JSON parse for the sidecar's small state endpoints. */
async function sidecarJson<T>( path: string, timeoutMs: number ): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout( () => controller.abort(), timeoutMs );
  try {
    const res = await fetch( `${SIDECAR_URL}${path}`, {
      signal : controller.signal,
      cache  : "no-store",
    } );
    if ( !res.ok ) return null;

    return ( await res.json() ) as T;
  } catch {
    return null;
  } finally {
    clearTimeout( timer );
  }
}

/**
 * Why a camera-service call failed, phrased for whoever is standing at the
 * booth.
 *
 * "Unreachable" on its own is not enough to act on: the two causes need
 * different fixes, and the difference is invisible from the outside. `/status`
 * has existed as long as this service has, so if it answers while `/mode` does
 * not, the service is simply an older build.
 */
export async function cameraServiceHint( timeoutMs = 4_000 ): Promise<string> {
  const status = await sidecarJson<{ connected?: boolean }>(
    "/status",
    timeoutMs,
  );

  if ( status ) {
    return `Camera service at ${SIDECAR_URL} has no /mode endpoint — restart it to pick up the new code`;
  }

  return `No camera service at ${SIDECAR_URL} — start it on the camera machine with: pnpm camera`;
}
