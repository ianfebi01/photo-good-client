import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { CAPTURES_DIR } from "@/lib/photobooth/config";
import { saveRawCopy } from "@/lib/photobooth/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^[a-z0-9]+$/i;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50 MB cap for images
const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB cap for videos

/**
 * Accept a captured JPEG or countdown video (webm) uploaded from the browser
 * when the client connects directly to the local camera service.
 *
 * Body: multipart/form-data with fields:
 *   - file:      the JPEG blob or webm video
 *   - sessionId: the active booth session
 *   - index:     shot index (0-based)
 *   - kind:      "photo" (default) or "countdown" for the 3s video clip
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
  const kind = String( form.get( "kind" ) ?? "photo" ).trim();

  if ( !( file instanceof File ) ) {
    return Response.json( { error : "Missing file" }, { status : 400 } );
  }
  const isVideo = file.type.startsWith( "video/" ) || kind === "countdown";
  const isImage = file.type.startsWith( "image/" );
  if ( !isImage && !isVideo ) {
    return Response.json( { error : "Unsupported file type" }, { status : 400 } );
  }
  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if ( file.size > maxBytes ) {
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

    if ( isVideo ) {
      // Countdown video clip
      const name = `countdown-${sessionId}-${index}.webm`;
      await writeFile( path.join( CAPTURES_DIR, name ), buffer );

      return Response.json( { file : name, url : `/captures/${name}` } );
    }

    // Photo — save the main shot and an immutable raw copy
    const name = `shot-${sessionId}-${index}.jpg`;
    await writeFile( path.join( CAPTURES_DIR, name ), buffer );
    await saveRawCopy( sessionId, index, buffer );

    return Response.json( { file : name, url : `/captures/${name}` } );
  } catch ( err ) {
    return Response.json(
      { error : err instanceof Error ? err.message : "Upload failed" },
      { status : 500 },
    );
  }
}
