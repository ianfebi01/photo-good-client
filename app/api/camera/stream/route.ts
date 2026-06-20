import { detectCamera, mockPreviewFrame } from "@/lib/photobooth/camera";
import { SIDECAR_PREVIEW_URL } from "@/lib/photobooth/sidecar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BOUNDARY = "photoboothframe";
const PART_TRAILER = Buffer.from( "\r\n" );

const delay = ( ms: number ) => new Promise( ( r ) => setTimeout( r, ms ) );

function wrap( jpeg: Buffer ) {
  const header = Buffer.from(
    `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
  );

  return Buffer.concat( [header, jpeg, PART_TRAILER] );
}

const STREAM_HEADERS = {
  "Access-Control-Allow-Origin" : "*",
  "Cache-Control"               : "no-store, no-cache, must-revalidate",
  "Pragma"                      : "no-cache",
  "Connection"                  : "close",
};

/**
 * Live preview as multipart/x-mixed-replace MJPEG, consumable by an <img> tag.
 *
 * With a real camera we proxy the sidecar's /preview stream straight through —
 * the sidecar self-heals across USB reconnects on that same connection, so live
 * view returns on its own after an unplug/replug. With no camera (or sidecar
 * down) we synthesize mock frames.
 */
export async function GET( request: Request ) {
  const status = await detectCamera();

  if ( !status.mock ) {
    try {
      const upstream = await fetch( SIDECAR_PREVIEW_URL, {
        signal : request.signal,
        cache  : "no-store",
      } );
      if ( upstream.ok && upstream.body ) {
        return new Response( upstream.body, {
          headers : {
            "Content-Type" :
              upstream.headers.get( "content-type" ) ??
              `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
            ...STREAM_HEADERS,
          },
        } );
      }
    } catch {
      // sidecar unreachable mid-request — fall through to mock frames
    }
  }

  let aborted = false;
  const stop = () => {
    aborted = true;
  };
  request.signal.addEventListener( "abort", stop );

  let tick = 0;
  const minInterval = 120;

  const stream = new ReadableStream( {
    async start( controller ) {
      try {
        while ( !aborted ) {
          const started = Date.now();
          let frame: Buffer;
          try {
            frame = await mockPreviewFrame( tick++ );
          } catch {
            if ( aborted ) break;
            await delay( 250 );
            continue;
          }
          if ( aborted ) break;
          try {
            controller.enqueue( wrap( frame ) );
          } catch {
            break;
          }
          const elapsed = Date.now() - started;
          if ( elapsed < minInterval ) await delay( minInterval - elapsed );
        }
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      stop();
    },
  } );

  return new Response( stream, {
    headers : {
      "Content-Type" : `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      ...STREAM_HEADERS,
    },
  } );
}
