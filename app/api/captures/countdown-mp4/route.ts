import path from "node:path";

import { ensureCapturesDir } from "@/lib/photobooth/camera";
import { convertCountdownToMp4 } from "@/lib/photobooth/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COUNTDOWN_RE = /^countdown-[a-z0-9]+-\d+\.(webm|mp4)$/i;

/**
 * Convert a recorded countdown clip into a downloadable MP4.
 *
 * Body (JSON):
 *   - file: the countdown clip filename (e.g. countdown-abc-0.webm)
 */
export async function POST( request: Request ) {
  let file = "";
  try {
    const body = await request.json();
    file = String( body.file ?? "" );
  } catch {
    return Response.json( { error : "Invalid JSON body" }, { status : 400 } );
  }

  if ( !COUNTDOWN_RE.test( file ) ) {
    return Response.json( { error : "Invalid file name" }, { status : 400 } );
  }

  try {
    await ensureCapturesDir();

    // Clips recorded in the browser as MP4 are already downloadable — nothing
    // to convert.
    if ( file.toLowerCase().endsWith( ".mp4" ) ) {
      const name = path.basename( file );

      return Response.json( { file : name, url : `/captures/${name}` } );
    }

    const result = await convertCountdownToMp4( file );
    if ( !result ) {
      return Response.json(
        { error : "ffmpeg not available — install ffmpeg to enable MP4 conversion" },
        { status : 501 },
      );
    }

    return Response.json( result );
  } catch ( err ) {
    return Response.json(
      { error : err instanceof Error ? err.message : "MP4 conversion failed" },
      { status : 500 },
    );
  }
}
