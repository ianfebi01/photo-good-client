import { writeFile } from "node:fs/promises";
import path from "node:path";

import { captureStill, ensureCapturesDir } from "@/lib/photobooth/camera";
import { CAPTURES_DIR } from "@/lib/photobooth/config";
import { saveRawCopy } from "@/lib/photobooth/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^[a-z0-9]+$/i;

export async function POST( request: Request ) {
  let sessionId = "";
  let index = 0;
  try {
    const body = await request.json();
    sessionId = String( body.sessionId ?? "" );
    index = Number( body.index ?? 0 );
  } catch {
    return Response.json( { error : "Invalid JSON body" }, { status : 400 } );
  }

  if ( !ID_RE.test( sessionId ) ) {
    return Response.json( { error : "Invalid sessionId" }, { status : 400 } );
  }
  if ( !Number.isInteger( index ) || index < 0 || index > 99 ) {
    return Response.json( { error : "Invalid index" }, { status : 400 } );
  }

  try {
    await ensureCapturesDir();
    const jpeg = await captureStill( index );
    if ( jpeg.length === 0 ) {
      return Response.json( { error : "Empty image from camera" }, { status : 500 } );
    }
    const name = `shot-${sessionId}-${index}.jpg`;
    await writeFile( path.join( CAPTURES_DIR, name ), jpeg );
    // Preserve an immutable raw copy
    await saveRawCopy( sessionId, index, jpeg );

    return Response.json( { file : name, url : `/api/captures/${name}` } );
  } catch ( err ) {
    return Response.json(
      { error : err instanceof Error ? err.message : "Capture failed" },
      { status : 500 },
    );
  }
}
