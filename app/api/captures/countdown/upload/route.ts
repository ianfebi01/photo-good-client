import { ffmpegAvailable, importCountdownClip } from "@/lib/photobooth/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^[a-z0-9]+$/i;
const MAX_CLIP_BYTES = 100 * 1024 * 1024; // a 15s 1080p recording is far below this

/**
 * Accept a countdown clip recorded on the booth device.
 *
 * The Android app has no camera service to record from, so it records the
 * countdown itself (MediaRecorder on the device camera) and uploads the raw
 * file here. It is transcoded to the same MP4/H.264 that /api/captures/countdown
 * produces, so the mashup and the sync cannot tell the two apart.
 *
 * Body: multipart/form-data with fields:
 *   - file:      the recorded video blob (WebM or MP4)
 *   - sessionId: the active booth session
 *   - index:     shot index (0-based) — names the clip
 *   - mirror:    "1" to flip the clip horizontally, matching the preview
 *
 * Responds like /api/captures/countdown: 501 without ffmpeg and 422 when the
 * upload held no usable frames — both mean "no clip", not a failed capture.
 */
export async function POST( request: Request ) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json( { error : "Expected multipart/form-data" }, { status : 400 } );
  }

  const file = form.get( "file" );
  const sessionId = String( form.get( "sessionId" ) ?? "" ).trim();
  const index = Number( String( form.get( "index" ) ?? "" ).trim() );
  const mirror = form.get( "mirror" ) === "1";

  if ( !( file instanceof File ) ) {
    return Response.json( { error : "Missing file" }, { status : 400 } );
  }
  if ( !file.type.startsWith( "video/" ) ) {
    return Response.json( { error : "Only video can be uploaded here" }, { status : 400 } );
  }
  if ( file.size > MAX_CLIP_BYTES ) {
    return Response.json( { error : "File too large" }, { status : 400 } );
  }
  if ( !ID_RE.test( sessionId ) ) {
    return Response.json( { error : "Invalid sessionId" }, { status : 400 } );
  }
  if ( !Number.isInteger( index ) || index < 0 || index > 99 ) {
    return Response.json( { error : "Invalid index" }, { status : 400 } );
  }

  if ( !( await ffmpegAvailable() ) ) {
    return Response.json(
      { error : "ffmpeg not available — install ffmpeg to keep countdown clips" },
      { status : 501 },
    );
  }

  try {
    const clip = await importCountdownClip(
      sessionId,
      index,
      Buffer.from( await file.arrayBuffer() ),
      mirror,
    );
    if ( !clip ) {
      return Response.json(
        { error : "Countdown recording contained no usable frames" },
        { status : 422 },
      );
    }

    return Response.json( clip );
  } catch ( err ) {
    return Response.json(
      { error : err instanceof Error ? err.message : "Countdown upload failed" },
      { status : 500 },
    );
  }
}
