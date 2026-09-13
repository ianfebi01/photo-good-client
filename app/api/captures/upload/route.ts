import { writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";

import { CAPTURES_DIR } from "@/lib/photobooth/config";
import {
  convertCountdownToMp4,
  finalizeCountdownMp4,
  saveRawCopy,
  videoFrameCount,
} from "@/lib/photobooth/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^[a-z0-9]+$/i;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50 MB cap for images
const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB cap for videos

/**
 * Accept a captured JPEG or countdown video uploaded from the browser when the
 * client connects directly to the local camera service.
 *
 * Countdown clips arrive as MP4/H.264 when the browser can record it (used
 * as-is, just remuxed for fast start) and as webm otherwise (converted with
 * ffmpeg).
 *
 * Body: multipart/form-data with fields:
 *   - file:      the JPEG blob or video clip
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
      // Countdown video clip — keep the recorded container when the browser
      // already produced H.264 MP4, otherwise store webm and convert it.
      const isMp4 =
        file.type.startsWith( "video/mp4" ) || /\.mp4$/i.test( file.name );
      const clipName = `countdown-${sessionId}-${index}.${isMp4 ? "mp4" : "webm"}`;
      const clipPath = path.join( CAPTURES_DIR, clipName );
      await writeFile( clipPath, buffer );

      // Drop any stale clip from a previous attempt at this index — only one
      // container should survive, or the mashup would pick the wrong one.
      await unlink(
        path.join(
          CAPTURES_DIR,
          `countdown-${sessionId}-${index}.${isMp4 ? "webm" : "mp4"}`,
        ),
      ).catch( () => {} );

      // Reject a recording that captured no usable frames (the canvas had not
      // painted yet). It would encode to an empty MP4 that then breaks the
      // countdown mashup, so tell the client to drop the clip instead.
      if ( await videoFrameCount( clipPath ) < 2 ) {
        await unlink( clipPath ).catch( () => {} );

        return Response.json(
          { error : 'Countdown recording contained no usable frames' },
          { status : 422 },
        );
      }

      if ( isMp4 ) {
        // Already H.264 — only rewrite it for fast-start playback/download.
        await finalizeCountdownMp4( clipName );

        return Response.json( { file : clipName, url : `/captures/${clipName}` } );
      }

      // Auto-convert to H.264 MP4 so it plays everywhere (Safari, iOS, etc.)
      const mp4 = await convertCountdownToMp4( clipName );

      return Response.json(
        mp4 ?? { file : clipName, url : `/captures/${clipName}` },
      );
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
