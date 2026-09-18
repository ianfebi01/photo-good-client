import { detectCamera } from "@/lib/photobooth/camera";
import { ffmpegAvailable, recordCountdownClip } from "@/lib/photobooth/media";
import { SIDECAR_PREVIEW_URL } from "@/lib/photobooth/sidecar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^[a-z0-9]+$/i;

/** Loopback / private-network hosts a booth camera may legitimately live on. */
function isLocalHost( hostname: string ): boolean {
  const host = hostname.toLowerCase();
  if ( host === "localhost" || host === "::1" || host.endsWith( ".local" ) ) {
    return true;
  }
  if ( host.startsWith( "127." ) || host.startsWith( "10." ) ) return true;
  if ( host.startsWith( "192.168." ) ) return true;

  return /^172\.(1[6-9]|2\d|3[01])\./.test( host );
}

/**
 * Pick the stream ffmpeg reads.
 *
 * The client sends the URL its own preview uses — the sidecar directly when the
 * browser can reach it, otherwise this app's MJPEG proxy. Anything that is
 * neither this origin nor a local/private address is ignored: this process must
 * not become an open fetcher for arbitrary hosts, and the sidecar is the only
 * other place a camera can be.
 */
async function resolveStreamUrl(
  requested: string,
  origin: string,
): Promise<string> {
  if ( requested ) {
    try {
      const url = new URL( requested, origin );
      const isHttp = url.protocol === "http:" || url.protocol === "https:";
      if ( isHttp && ( url.origin === origin || isLocalHost( url.hostname ) ) ) {
        return url.toString();
      }
    } catch {
      // Unparsable — fall through to server-side resolution.
    }
  }

  const status = await detectCamera();

  return status.mock ? `${origin}/api/camera/stream` : SIDECAR_PREVIEW_URL;
}

/**
 * Record the countdown clip for one shot from the live camera preview.
 *
 * The browser used to record this itself (canvas + MediaRecorder), which cost
 * quality: an extra decode/encode generation, dropped frames, and WebM/VP9 on
 * browsers that can't mux H.264. ffmpeg now reads the same MJPEG stream the
 * preview shows and encodes it to MP4/H.264 in one pass, at the stream's native
 * resolution.
 *
 * Body (JSON):
 *   - sessionId:   the booth session identifier
 *   - index:       shot index (0-based) — names the clip
 *   - durationSec: countdown length to record (1–15)
 *   - streamUrl:   optional preview URL the client is displaying
 */
export async function POST( request: Request ) {
  let sessionId = "";
  let index = 0;
  let durationSec = 3;
  let streamUrl = "";
  let mirror = false;
  try {
    const body = await request.json();
    sessionId = String( body.sessionId ?? "" );
    index = Number( body.index ?? 0 );
    durationSec = Number( body.durationSec ?? 3 );
    streamUrl = String( body.streamUrl ?? "" );
    mirror = body.mirror === true;
  } catch {
    return Response.json( { error : "Invalid JSON body" }, { status : 400 } );
  }

  if ( !ID_RE.test( sessionId ) ) {
    return Response.json( { error : "Invalid sessionId" }, { status : 400 } );
  }
  if ( !Number.isInteger( index ) || index < 0 || index > 99 ) {
    return Response.json( { error : "Invalid index" }, { status : 400 } );
  }
  if ( !Number.isFinite( durationSec ) || durationSec < 1 || durationSec > 15 ) {
    return Response.json( { error : "Invalid durationSec" }, { status : 400 } );
  }

  if ( !( await ffmpegAvailable() ) ) {
    return Response.json(
      { error : "ffmpeg not available — install ffmpeg to record countdown clips" },
      { status : 501 },
    );
  }

  try {
    const source = await resolveStreamUrl( streamUrl, new URL( request.url ).origin );
    const clip = await recordCountdownClip(
      sessionId,
      index,
      source,
      durationSec,
      mirror,
    );

    // A clip with too few frames is dropped rather than stored: it would encode
    // to a stub that breaks the countdown mashup. The capture itself is fine.
    if ( !clip ) {
      return Response.json(
        { error : "Countdown recording contained no usable frames" },
        { status : 422 },
      );
    }

    return Response.json( clip );
  } catch ( err ) {
    return Response.json(
      { error : err instanceof Error ? err.message : "Countdown recording failed" },
      { status : 500 },
    );
  }
}
