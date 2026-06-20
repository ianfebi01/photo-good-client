import "server-only";

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

export type SidecarStatus = { connected: boolean; model?: string | null };

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

/** The sidecar's live-preview MJPEG endpoint, proxied by the stream route. */
export const SIDECAR_PREVIEW_URL = `${SIDECAR_URL}/preview`;
