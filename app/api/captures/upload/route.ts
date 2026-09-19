import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { CAPTURES_DIR } from "@/lib/photobooth/config";
import { saveRawCopy } from "@/lib/photobooth/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^[a-z0-9]+$/i;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50 MB cap for images

/**
 * Accept a captured JPEG uploaded from the browser when the client connects
 * directly to the local camera service.
 *
 * Photos only. The countdown clip used to be recorded in the browser and
 * uploaded here as MP4/WebM (converted server-side when needed); it is now
 * recorded by /api/captures/countdown, which encodes MP4/H.264 directly off the
 * live preview — so a video upload has nowhere to go and is rejected.
 *
 * Body: multipart/form-data with fields:
 *   - file:      the JPEG blob
 *   - sessionId: the active booth session
 *   - index:     shot index (0-based)
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
  const indexRaw = String( form.get( "index" ) ?? "" ).trim();
  const index = Number( indexRaw );

  if ( !( file instanceof File ) ) {
    return Response.json( { error : "Missing file" }, { status : 400 } );
  }
  if ( !file.type.startsWith( "image/" ) ) {
    return Response.json(
      { error : "Unsupported file type — only images can be uploaded" },
      { status : 400 },
    );
  }
  if ( file.size > MAX_IMAGE_BYTES ) {
    return Response.json( { error : "File too large" }, { status : 400 } );
  }
  if ( !ID_RE.test( sessionId ) ) {
    return Response.json( { error : "Invalid sessionId" }, { status : 400 } );
  }
  if ( !Number.isInteger( index ) || index < 0 || index > 99 ) {
    return Response.json( { error : "Invalid index" }, { status : 400 } );
  }

  try {
    await mkdir( CAPTURES_DIR, { recursive : true } );
    const buffer = Buffer.from( await file.arrayBuffer() );

    // Photo — save the main shot and an immutable raw copy
    const name = `shot-${sessionId}-${index}.jpg`;
    await writeFile( path.join( CAPTURES_DIR, name ), buffer );
    await saveRawCopy( sessionId, index, buffer );

    return Response.json( { file : name, url : `/api/captures/${name}` } );
  } catch ( err ) {
    return Response.json(
      { error : err instanceof Error ? err.message : "Upload failed" },
      { status : 500 },
    );
  }
}
