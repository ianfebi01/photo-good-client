import { ensureCapturesDir } from "@/lib/photobooth/camera";
import { generateLoopVideo } from "@/lib/photobooth/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE_RE = /^shot-[a-z0-9]+-\d+\.jpg$/i;
const ID_RE = /^[a-z0-9]+$/i;

/**
 * Generate a 15-second looping MP4 video from session photo captures.
 *
 * Body (JSON):
 *   - sessionId: the booth session identifier
 *   - files:     ordered list of shot filenames (e.g. shot-abc-0.jpg)
 */
export async function POST( request: Request ) {
  let files: string[] = [];
  let sessionId = "";
  try {
    const body = await request.json();
    files = Array.isArray( body.files ) ? body.files.map( String ) : [];
    sessionId = String( body.sessionId ?? "" );
  } catch {
    return Response.json( { error : "Invalid JSON body" }, { status : 400 } );
  }

  if ( !ID_RE.test( sessionId ) ) {
    return Response.json( { error : "Invalid sessionId" }, { status : 400 } );
  }
  if ( files.length === 0 ) {
    return Response.json( { error : "No files provided" }, { status : 400 } );
  }
  if ( !files.every( ( f ) => FILE_RE.test( f ) ) ) {
    return Response.json( { error : "Invalid file name(s)" }, { status : 400 } );
  }

  try {
    await ensureCapturesDir();
    const result = await generateLoopVideo( sessionId, files );
    if ( !result ) {
      return Response.json(
        { error : "ffmpeg not available — install ffmpeg to enable video generation" },
        { status : 501 },
      );
    }

    return Response.json( result );
  } catch ( err ) {
    return Response.json(
      { error : err instanceof Error ? err.message : "Video loop generation failed" },
      { status : 500 },
    );
  }
}
