import { ensureCapturesDir } from "@/lib/photobooth/camera";
import {
  generateSlideshowVideo,
  generateCountdownMashup,
} from "@/lib/photobooth/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE_RE = /^shot-[a-z0-9]+-\d+\.jpg$/i;
const COUNTDOWN_RE = /^countdown-[a-z0-9]+-\d+\.(webm|mp4)$/i;
const ID_RE = /^[a-z0-9]+$/i;

/**
 * Generate an MP4 video from a session's captures.
 *
 * If countdownFiles are provided with a frameKey, overlays each clip
 * into its slot on the frame. Falls back to an image slideshow otherwise.
 *
 * Body (JSON):
 *   - sessionId:      the booth session identifier
 *   - files:          ordered list of shot filenames (for slideshow)
 *   - countdownFiles: ordered list of countdown clip filenames (for mashup)
 *   - frameKey:       frame identifier (required for countdown mashup)
 */
export async function POST( request: Request ) {
  let files: string[] = [];
  let countdownFiles: string[] = [];
  let sessionId = "";
  let frameKey = "";
  try {
    const body = await request.json();
    files = Array.isArray( body.files ) ? body.files.map( String ) : [];
    countdownFiles = Array.isArray( body.countdownFiles )
      ? body.countdownFiles.map( String )
      : [];
    sessionId = String( body.sessionId ?? "" );
    frameKey = String( body.frameKey ?? "" );
  } catch {
    return Response.json( { error : "Invalid JSON body" }, { status : 400 } );
  }

  if ( !ID_RE.test( sessionId ) ) {
    return Response.json( { error : "Invalid sessionId" }, { status : 400 } );
  }

  try {
    await ensureCapturesDir();

    // Prefer countdown mashup over image slideshow
    if ( countdownFiles.length > 0 ) {
      if ( !countdownFiles.every( ( f ) => COUNTDOWN_RE.test( f ) ) ) {
        return Response.json( { error : "Invalid countdown file name(s)" }, { status : 400 } );
      }
      const result = await generateCountdownMashup(
        sessionId,
        countdownFiles,
        frameKey,
      );
      // A clip may have been unusable (e.g. recorded before the preview was
      // live). Fall through to the slideshow rather than failing the request.
      if ( result ) {
        return Response.json( result );
      }
    }

    // Fallback: image slideshow
    if ( files.length === 0 ) {
      return Response.json( { error : "No files provided" }, { status : 400 } );
    }
    if ( !files.every( ( f ) => FILE_RE.test( f ) ) ) {
      return Response.json( { error : "Invalid file name(s)" }, { status : 400 } );
    }

    const result = await generateSlideshowVideo( sessionId, files );
    if ( !result ) {
      return Response.json(
        { error : "ffmpeg not available — install ffmpeg to enable video generation" },
        { status : 501 },
      );
    }

    return Response.json( result );
  } catch ( err ) {
    return Response.json(
      { error : err instanceof Error ? err.message : "Video generation failed" },
      { status : 500 },
    );
  }
}
