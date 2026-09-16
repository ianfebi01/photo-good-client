import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { CAPTURES_DIR } from "@/lib/photobooth/config";

export const runtime = "nodejs";

const ID_RE = /^[a-z0-9]+$/i;
const MEDIA_PREFIXES = [
  "shot",
  "raw-shot",
  "strip",
  "anim",
  "slideshow",
  "countdown",
  "countdown-mashup",
  "loop",
];

/** Delete local capture artifacts for a completed or abandoned session. */
export async function DELETE( request: Request ) {
  let sessionId = "";
  try {
    const body = await request.json() as { sessionId?: unknown };
    sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  } catch {
    return Response.json( { error : "Invalid JSON body" }, { status : 400 } );
  }

  if ( !ID_RE.test( sessionId ) ) {
    return Response.json( { error : "Invalid sessionId" }, { status : 400 } );
  }

  const escapedId = sessionId.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" );
  const mediaPattern = new RegExp(
    `^(?:${MEDIA_PREFIXES.join( "|" )})-${escapedId}(?:-|\\.)`,
    "i",
  );

  try {
    const files = await readdir( CAPTURES_DIR );
    const sessionFiles = files.filter( ( file ) => mediaPattern.test( file ) );
    await Promise.all( sessionFiles.map( ( file ) => unlink( path.join( CAPTURES_DIR, file ) ) ) );

    return Response.json( { deleted : sessionFiles.length } );
  } catch ( err ) {
    return Response.json(
      { error : err instanceof Error ? err.message : "Capture cleanup failed" },
      { status : 500 },
    );
  }
}
