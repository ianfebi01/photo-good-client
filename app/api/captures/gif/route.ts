import { ensureCapturesDir } from "@/lib/photobooth/camera";
import { generateGif } from "@/lib/photobooth/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE_RE = /^shot-[a-z0-9]+-\d+\.jpg$/i;
const ID_RE = /^[a-z0-9]+$/i;

/**
 * Generate an animated GIF from a session's captured photos.
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
    const result = await generateGif( sessionId, files );

    return Response.json( result );
  } catch ( err ) {
    return Response.json(
      { error : err instanceof Error ? err.message : "GIF generation failed" },
      { status : 500 },
    );
  }
}
