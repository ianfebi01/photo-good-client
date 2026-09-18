import "server-only";

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import { CAPTURES_DIR, getFrame, externalFetch, type FrameDef } from "./config";
import { clearGreenPixels } from "./slots";

// ── Helpers ────────────────────────────────────────────────────────

/** Resolve an ffmpeg binary; returns false when unavailable. */
export async function ffmpegAvailable(): Promise<boolean> {
  return new Promise( ( resolve ) => {
    const proc = spawn( "ffmpeg", ["-version"], { stdio : "ignore" } );
    proc.on( "close", ( code ) => resolve( code === 0 ) );
    proc.on( "error", () => resolve( false ) );
  } );
}

function escapePath( p: string ): string {
  return p.replace( /'/g, "'\\''" );
}

/**
 * Number of decodable video frames in a media file — `0` when the file has no
 * frames at all, `1` for a recording where only a single frame landed.
 *
 * ffmpeg happily exits `0` while writing an empty container in those cases, so
 * callers must check this rather than trusting the process status.
 */
export async function videoFrameCount( filePath: string ): Promise<number> {
  return new Promise( ( resolve ) => {
    const proc = spawn( "ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-count_frames",
      "-show_entries", "stream=nb_read_frames",
      "-of", "csv=p=0",
      filePath,
    ], { stdio : ["ignore", "pipe", "ignore"] } );

    let out = "";
    proc.stdout.on( "data", ( chunk ) => {
      out += String( chunk );
    } );
    // Can't probe (no ffprobe)? Report zero so callers degrade to the slideshow
    // instead of building a video out of clips they can't validate.
    proc.on( "error", () => resolve( 0 ) );
    proc.on( "close", () => {
      const frames = Number.parseInt( out.trim(), 10 );
      resolve( Number.isFinite( frames ) ? frames : 0 );
    } );
  } );
}

/** A clip needs at least two frames — a lone frame encodes to an empty file. */
const MIN_CLIP_FRAMES = 2;

/** Pixel dimensions of a media file (`0×0` when ffprobe can't read it). */
async function videoSize(
  filePath: string,
): Promise<{ width: number; height: number }> {
  return new Promise( ( resolve ) => {
    const proc = spawn( "ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      filePath,
    ], { stdio : ["ignore", "pipe", "ignore"] } );

    let out = "";
    proc.stdout.on( "data", ( chunk ) => {
      out += String( chunk );
    } );
    proc.on( "error", () => resolve( { width : 0, height : 0 } ) );
    proc.on( "close", () => {
      const [ width, height ] = out.trim().split( "," ).map( ( n ) => Number( n ) );
      resolve( {
        width  : Number.isFinite( width ) ? width : 0,
        height : Number.isFinite( height ) ? height : 0,
      } );
    } );
  } );
}

/**
 * Encode media to a private temp file and publish it with a rename.
 *
 * The result page can ask for the same video twice — React StrictMode re-runs
 * the generation effect in dev, and a retry can overlap a slow encode — and two
 * ffmpeg processes writing one path interleave their output. The file that comes
 * out still reports a valid duration but decodes as garbage, which is exactly
 * what a player shows as a blank video. `build` writes to the path it is handed;
 * the rename publishes it only once it is complete.
 */
async function writeMediaAtomically(
  vidName: string,
  build: ( outPath: string ) => Promise<void>,
): Promise<void> {
  const ext = path.extname( vidName );
  const outPath = path.join(
    CAPTURES_DIR,
    `.${path.basename( vidName, ext )}-${Date.now()}.tmp${ext}`,
  );

  try {
    await build( outPath );
    await rename( outPath, path.join( CAPTURES_DIR, vidName ) );
  } catch ( err ) {
    await unlink( outPath ).catch( () => {} );
    throw err;
  }
}

/** Encoding jobs by output name — a duplicate request joins the running one. */
const _encoding = new Map<string, Promise<unknown>>();

function singleFlight<T>( vidName: string, run: () => Promise<T> ): Promise<T> {
  const running = _encoding.get( vidName ) as Promise<T> | undefined;
  if ( running ) return running;

  const job = run().finally( () => _encoding.delete( vidName ) );
  _encoding.set( vidName, job );

  return job;
}

/**
 * Writes a text file listing absolute paths to every image, one per line —
 * ffmpeg's concat demuxer reads this to sequence frames without re-encoding
 * each one through a complex filtergraph.
 */
async function writeConcatList( files: string[], listPath: string ) {
  const lines = files.map( ( f ) => {
    const abs = path.resolve( CAPTURES_DIR, path.basename( f ) );

    return `file '${escapePath( abs )}'`;
  } ).join( "\n" );
  await writeFile( listPath, lines + "\n", "utf8" );
}

// ── Animated GIF ───────────────────────────────────────────────────

const GIF_W = 480; // max width for the GIF; height auto-scaled proportionally

/**
 * Generate an animated GIF cycling through every captured photo of a session.
 * Uses ffmpeg with the palettegen / paletteuse two-pass approach for decent
 * quality at a small file size. Falls back to a simpler sharp-based animation
 * when ffmpeg is unavailable.
 */
export async function generateGif(
  sessionId: string,
  files: string[],
): Promise<{ file: string; url: string }> {
  const gifName = `anim-${sessionId}.gif`;

  return singleFlight( gifName, async () => {
    await mkdir( CAPTURES_DIR, { recursive : true } );

    const hasFfmpeg = await ffmpegAvailable();

    await writeMediaAtomically( gifName, async ( outPath ) => {
      if ( hasFfmpeg && files.length > 0 ) {
        await generateGifFfmpeg( files, outPath );
      } else {
        await generateGifSharp( files, outPath );
      }
    } );

    return { file : gifName, url : `/captures/${gifName}` };
  } );
}

async function generateGifFfmpeg( files: string[], outPath: string ) {
  const listPath = path.join( CAPTURES_DIR, `.gif-list-${Date.now()}.txt` );
  await writeConcatList( files, listPath );

  const palettePath = path.join( CAPTURES_DIR, `.palette-${Date.now()}.png` );

  // Pass 1 — generate a global palette
  await new Promise<void>( ( resolve, reject ) => {
    const proc = spawn( "ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-vf", `fps=2,scale=${GIF_W}:-1:flags=lanczos,palettegen=stats_mode=diff`,
      palettePath,
    ], { stdio : "inherit" } );
    proc.on( "close", ( code ) => {
      if ( code === 0 ) resolve();
      else reject( new Error( `ffmpeg palette pass exited with ${code}` ) );
    } );
  } );

  // Pass 2 — apply palette and output an animated GIF
  await new Promise<void>( ( resolve, reject ) => {
    const proc = spawn( "ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-i", palettePath,
      "-lavfi", `fps=2,scale=${GIF_W}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5`,
      outPath,
    ], { stdio : "inherit" } );
    proc.on( "close", ( code ) => {
      if ( code === 0 ) resolve();
      else reject( new Error( `ffmpeg gif pass exited with ${code}` ) );
    } );
  } );

  // Clean up temp files
  try {
    await import( "node:fs/promises" ).then( ( m ) => m.unlink( listPath ) ); 
  } catch { /* ok */ }
  try {
    await import( "node:fs/promises" ).then( ( m ) => m.unlink( palettePath ) ); 
  } catch { /* ok */ }
}

/** Fallback: sharp-based contact-sheet GIF when ffmpeg is unavailable. */
async function generateGifSharp( files: string[], outPath: string ) {
  if ( files.length === 0 ) return

  // Read and resize all frames to a consistent size
  const thumbW = GIF_W
  const thumbH = Math.round( GIF_W * 0.667 )
  const frames: Buffer[] = []
  for ( const f of files ) {
    const fullPath = path.join( CAPTURES_DIR, path.basename( f ) )
    const buf = await readFile( fullPath )
    const resized = await sharp( buf )
      .resize( thumbW, thumbH, { fit : "cover" } )
      .png()
      .toBuffer()
    frames.push( resized )
  }

  if ( frames.length === 0 ) return

  // Layout frames in a grid: max 3 per row
  const cols = Math.min( frames.length, 3 )
  const rows = Math.ceil( frames.length / cols )
  const padding = 4
  const canvasW = cols * thumbW + ( cols + 1 ) * padding
  const canvasH = rows * thumbH + ( rows + 1 ) * padding

  const composites = frames.map( ( frame, i ) => {
    const col = i % cols
    const row = Math.floor( i / cols )

    return {
      input : frame,
      left  : padding + col * ( thumbW + padding ),
      top   : padding + row * ( thumbH + padding ),
    }
  } )

  await sharp( {
    create : {
      width      : canvasW,
      height     : canvasH,
      channels   : 4,
      background : { r : 255, g : 255, b : 255, alpha : 1 },
    },
  } )
    .composite( composites )
    .gif()
    .toFile( outPath )
}

// ── Video slideshow of all captures ────────────────────────────────

const VID_W = 1080;

/**
 * Create an MP4 slideshow video from every captured photo in the session.
 * Each image displays for 1.5 seconds with a crossfade transition.
 * Falls back to no-op when ffmpeg is unavailable (the GIF still works).
 */
export async function generateSlideshowVideo(
  sessionId: string,
  files: string[],
): Promise<{ file: string; url: string } | null> {
  if ( files.length === 0 ) return null;

  const hasFfmpeg = await ffmpegAvailable();
  if ( !hasFfmpeg ) return null;

  await mkdir( CAPTURES_DIR, { recursive : true } );

  const vidName = `slideshow-${sessionId}.mp4`;

  return singleFlight( vidName, async () => {
    await mkdir( CAPTURES_DIR, { recursive : true } );

    const listPath = path.join( CAPTURES_DIR, `.vid-list-${Date.now()}.txt` );
    await writeConcatList( files, listPath );

    try {
      // Concat demuxer → each image shown for 1.5 s with a smooth zoom effect
      await writeMediaAtomically(
        vidName,
        ( outPath ) => new Promise<void>( ( resolve, reject ) => {
          const proc = spawn( "ffmpeg", [
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", listPath,
            "-vf",
            [
              `scale=${VID_W}:-2:force_original_aspect_ratio=decrease`,
              "fps=24",
              "format=yuv420p",
            ].join( "," ),
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-level", "4.0",
            "-tag:v", "avc1",
            "-movflags", "+faststart",
            outPath,
          ], { stdio : "inherit" } );
          proc.on( "close", ( code ) => {
            if ( code === 0 ) resolve();
            else reject( new Error( `ffmpeg video pass exited with ${code}` ) );
          } );
        } ),
      );
    } finally {
      await unlink( listPath ).catch( () => {} );
    }

    return { file : vidName, url : `/captures/${vidName}` };
  } );
}

// ── Countdown video mashup onto frame ─────────────────────────────

/**
 * Result video canvas — the frame's own pixels, rounded down to even numbers.
 *
 * libx264 with yuv420p needs both dimensions even, so a 1333×1999 frame can't be
 * encoded as it stands. Encoding at the frame's size (rather than the 4×6 print
 * size) keeps the artwork unresampled, so decorations stay as crisp as the strip
 * the guest prints from the same design.
 */
function outputSize( frame: FrameDef ): { width: number; height: number } {
  return {
    width  : Math.floor( frame.width / 2 ) * 2,
    height : Math.floor( frame.height / 2 ) * 2,
  };
}

/** Round up to the next even number — ffmpeg's yuv420p units. */
function evenUp( value: number ): number {
  return Math.max( 2, Math.ceil( value / 2 ) * 2 );
}

/** Per-slot framing the capture step stores (frame pixels, same as the strip). */
type SlotAdjustment = { x: number; y: number; zoom: number; filter: string };

/** Framing used for a slot the guest never touched. */
const NEUTRAL_ADJUSTMENT: SlotAdjustment = {
  x      : 0,
  y      : 0,
  zoom   : 1,
  filter : "none",
};

/**
 * Bleed drawn around each slot, matching `composeStrip`.
 *
 * The frame's keyed window is a hair larger than the slot rectangle, so a clip
 * pasted at exactly the slot size leaves its own edge showing through as a dark
 * outline. The clip is therefore laid down 8px wider on every side, under the
 * frame artwork.
 */
const SLOT_PADDING = 8;

/**
 * `composeStrip`'s sharp `recomb` matrices, as ffmpeg channel mixers — the same
 * numbers, so a filtered slot looks the same in the video as on the strip.
 * (`vintage` adds sharp's brightness/saturation modulate; eq's brightness is an
 * offset where sharp multiplies, so it is the close equivalent, not exact.)
 */
const SLOT_FILTERS: Record<string, string> = {
  grayscale : "hue=s=0",
  sepia     : "colorchannelmixer=0.393:0.769:0.189:0:0.349:0.686:0.168:0:0.272:0.534:0.131:0:0:0:0:1",
  warm      : "colorchannelmixer=1.1:0:0:0:0:1:0:0:0:0:0.9:0:0:0:0:1",
  cool      : "colorchannelmixer=0.9:0:0:0:0:1:0:0:0:0:1.15:0:0:0:0:1",
  vintage   : "colorchannelmixer=0.95:0.05:0:0:0:0.9:0.1:0:0.05:0:0.85:0:0:0:0:1,eq=saturation=0.85:brightness=0.05",
};

/**
 * Output cadence. The clips are recorded at this rate and the canvas is built at
 * it too, so the mashup runs exactly as long as the countdown — a 24 fps slot
 * chain over a 25 fps canvas rounded 5.00s down to 4.96s.
 */
const OUT_FPS = 25

/**
 * Overlay each countdown clip (MP4/H.264) into its corresponding slot on the
 * frame image, producing a single combined MP4. Each clip is scaled to
 * fit its slot rect; the output runs as long as the countdown the guest saw, so
 * a 5s countdown yields a 5s video.
 *
 * Framing mirrors `composeStrip` — the same 8px bleed, cover-fit, per-slot
 * zoom/pan with white edges and per-slot colour filter — so the video matches the
 * strip the guest takes away instead of showing a differently cropped take.
 */
export async function generateCountdownMashup(
  sessionId: string,
  countdownFiles: string[],
  frameKey: string,
  adjustments?: SlotAdjustment[],
): Promise<{ file: string; url: string } | null> {
  return singleFlight(
    // Framing is part of the output, so two requests with different adjustments
    // must not share one encode.
    `countdown-mashup-${sessionId}-${JSON.stringify( adjustments ?? [] )}.mp4`,
    () => buildCountdownMashup( sessionId, countdownFiles, frameKey, adjustments ),
  )
}

async function buildCountdownMashup(
  sessionId: string,
  countdownFiles: string[],
  frameKey: string,
  adjustments?: SlotAdjustment[],
): Promise<{ file: string; url: string } | null> {
  if ( countdownFiles.length === 0 ) return null

  const hasFfmpeg = await ffmpegAvailable()
  if ( !hasFfmpeg ) return null

  const frame = await getFrame( frameKey )
  if ( !frame || frame.slots.length === 0 ) return null

  await mkdir( CAPTURES_DIR, { recursive : true } )

  // Resolve the frame image to a temp PNG ffmpeg can read
  const frameImagePath = await resolveFrameImagePath( frame.key )

  const vidName = `countdown-mashup-${sessionId}.mp4`
  const { width: outW, height: outH } = outputSize( frame )

  // Place each clip in the slot its own filename names — `countdown-<session>-
  // <index>` — rather than in the order the store happened to collect them.
  // Recordings land at different times, so store order is not index order, and
  // a missing or retaken clip must not shift its neighbours into the wrong
  // frame window. Each clip's pixel size is read here too: the framing maths
  // below needs it, exactly as composeStrip reads it with sharp.
  const clips = new Array<{ name: string; width: number; height: number } | null>(
    frame.slots.length,
  ).fill( null );

  await Promise.all(
    countdownFiles.map( async ( file ) => {
      const name = path.basename( file );
      const slot = Number( /-(\d+)\.mp4$/i.exec( name )?.[1] );
      if ( !Number.isInteger( slot ) || slot < 0 || slot >= clips.length ) return;

      const clipPath = path.join( CAPTURES_DIR, name );
      // Probe first: a clip with too few frames makes ffmpeg fail the whole
      // graph, so a bad input is dropped rather than taking the mashup down.
      if ( await videoFrameCount( clipPath ) < MIN_CLIP_FRAMES ) return;

      const { width, height } = await videoSize( clipPath );
      if ( !width || !height ) return;

      clips[slot] = { name, width, height };
    } ),
  );

  if ( clips.every( ( clip ) => clip === null ) ) return null;

  // Build filter graph:
  // 1. White backdrop at frame size
  // 2. Fit each clip into its slot (bleed, zoom, pan, filter) → overlay
  // 3. Overlay the keyed frame on TOP → decorations cover the clip edges
  //    (the keying itself happened in resolveFrameImagePath, with sharp)
  const inputs: string[] = []
  const filters: string[] = []

  // Synthetic backdrop [0:v] — white, the same paper colour composeStrip fills
  // with, so a slot with no clip reads as an empty window instead of a hole.
  filters.push(
    `color=c=white:s=${frame.width}x${frame.height}:d=9999:r=${OUT_FPS},format=rgba[canvas]`,
  )
  let lastOut = "canvas"
  let inputIdx = 0

  for ( let i = 0; i < clips.length; i++ ) {
    const clip = clips[i]
    if ( !clip ) continue

    const slot = frame.slots[i]
    // The clip covers a padded box, not just the slot — see SLOT_PADDING. The box
    // is rounded up to an even size so ffmpeg's yuv420p crop cannot shave a row
    // off it (an odd 375px box came back as 374 and left a gap under the window).
    const boxW = evenUp( slot.width + SLOT_PADDING * 2 )
    const boxH = evenUp( slot.height + SLOT_PADDING * 2 )

    // Mirror composeStrip's framing: cover-fit the padded box, apply the guest's
    // zoom, then crop the box back out at their pan offset (in frame pixels).
    const adj = adjustments?.[i] ?? NEUTRAL_ADJUSTMENT
    const zoom = Number.isFinite( adj.zoom ) && adj.zoom > 0 ? adj.zoom : 1
    const dx = Number.isFinite( adj.x ) ? adj.x : 0
    const dy = Number.isFinite( adj.y ) ? adj.y : 0

    const cover = Math.max( boxW / clip.width, boxH / clip.height )
    // Even dimensions keep ffmpeg from nudging the scale output off the size we
    // computed, which would put the crop below off by a pixel (and pad rejects a
    // no-op). The sub-pixel aspect change matches composeStrip's own rounding.
    const scaledW = evenUp( clip.width * cover * zoom )
    const scaledH = evenUp( clip.height * cover * zoom )

    const leftRaw = ( scaledW - boxW ) / 2 - dx
    const topRaw = ( scaledH - boxH ) / 2 - dy
    // Panning past the edge reveals paper, so the image is padded with white
    // first and the box is cropped out of the padded frame. The capture step
    // clamps the pan well inside the overflow, so this only fires for a framing
    // the UI can't produce — which is why it is left out when unnecessary.
    const leftPad = Math.max( 0, Math.ceil( -leftRaw ) )
    const topPad = Math.max( 0, Math.ceil( -topRaw ) )
    const padX = leftPad + Math.max( 0, Math.ceil( leftRaw + boxW - scaledW ) )
    const padY = topPad + Math.max( 0, Math.ceil( topRaw + boxH - scaledH ) )
    const padFilter = leftPad || topPad || padX || padY
      ? `pad=iw+${padX}:ih+${padY}:${leftPad}:${topPad}:white,`
      : ""
    const cropX = leftPad + Math.max( 0, Math.floor( leftRaw ) )
    const cropY = topPad + Math.max( 0, Math.floor( topRaw ) )

    // `inputIdx` counts only the clips we actually pass to ffmpeg, since the
    // canvas is synthetic and skipped clips are absent from the input list.
    inputs.push( "-i", path.join( CAPTURES_DIR, clip.name ) )

    const tag = `v${i}`
    // Live-view clips are small (the EOS M6 preview is 480×320) and a portrait
    // slot can stretch them ~2.5×, so scale with lanczos and add a touch of
    // sharpening to keep the upscaled clip from looking mushy.
    const colour = SLOT_FILTERS[adj.filter] ?? ""
    filters.push(
      `[${inputIdx}:v]scale=${scaledW}:${scaledH}:flags=lanczos,` +
      padFilter +
      `crop=${boxW}:${boxH}:${cropX}:${cropY},` +
      "unsharp=5:5:0.5:5:5:0,format=rgba," +
      `${colour ? `${colour},` : ""}setsar=1,fps=${OUT_FPS}[${tag}]`,
    )

    const outTag = `o${i}`
    filters.push(
      `[${lastOut}][${tag}]overlay=${slot.left - SLOT_PADDING}:${slot.top - SLOT_PADDING}:shortest=1[${outTag}]`,
    )
    lastOut = outTag
    inputIdx++
  }

  // Frame image: already pre-keyed (green pixels → transparent via sharp),
  // so just ensure rgba pixel format before overlaying on top of clips.
  const frameIdx = inputIdx
  inputs.push( "-i", frameImagePath )
  filters.push(
    `[${frameIdx}:v]format=rgba[fk]`,
  )
  // setsar=1 after the final scale: scaling 1333×1999 down to 1332×1998 keeps
  // the source SAR, which would advertise a 1333:1999 display aspect ratio.
  filters.push(
    `[${lastOut}][fk]overlay=0:0,scale=${outW}:${outH}:flags=lanczos,setsar=1,format=yuv420p[out]`,
  )

  const filterComplex = filters.join( ";" )

  await writeMediaAtomically( vidName, ( outPath ) => new Promise<void>( ( resolve, reject ) => {
    const args = [
      "-y",
      ...inputs,
      "-filter_complex", filterComplex,
      "-map", "[out]",
      "-c:v", "libx264",
      // Near-lossless: this is the last encode generation, and the clips inside
      // it are already upscaled live-view frames. Measured against a lossless
      // master of the same composite: CRF 15 is already SSIM 0.9992, CRF 12 is
      // 0.9995 at ~35% more bytes — a cheap margin for real camera motion.
      "-preset", "slow",
      "-crf", "12",
      "-pix_fmt", "yuv420p",
      "-profile:v", "main",
      // Level 5.0 is the lowest level whose frame-size limit covers this canvas:
      // 1332×1998 is 10,500 macroblocks per frame, past level 4.2's 8,704 (and
      // level 4.0's 8,192).
      "-level", "5.0",
      "-tag:v", "avc1",
      "-movflags", "+faststart",
      outPath,
    ]
    // ffmpeg's own complaint is the only useful thing when the graph is wrong,
    // so keep its stderr and hand the tail back with the failure.
    const proc = spawn( "ffmpeg", args, { stdio : ["ignore", "ignore", "pipe"] } )

    let stderr = ""
    proc.stderr.on( "data", ( chunk ) => {
      stderr = ( stderr + String( chunk ) ).slice( -4000 )
    } )
    proc.on( "close", ( code ) => {
      if ( code === 0 ) resolve()
      else reject( new Error( `ffmpeg mashup exited with ${code}: ${stderr.trim()}` ) )
    } )
  } ) )

  return { file : vidName, url : `/captures/${vidName}` }
}

/** Resolve frame image to a pre-keyed RGBA PNG that ffmpeg can overlay directly.
 *  Uses the same sharp + clearGreenPixels pipeline as composeStrip so green
 *  marker pixels are reliably turned transparent (with dilation for anti-aliased
 *  edges), avoiding ffmpeg's less precise colorkey filter. */
async function resolveFrameImagePath( frameKey: string ): Promise<string> {
  const frame = await getFrame( frameKey )
  if ( !frame ) throw new Error( `Unknown frame: ${frameKey}` )

  const cachedPath = path.join( CAPTURES_DIR, `.frame-${frameKey}.png` )

  // Return cached pre-keyed overlay if it already exists
  try {
    await readFile( cachedPath )

    return cachedPath
  } catch {
    // not cached yet — build it below
  }

  let imageBuffer: Buffer
  if ( frame.image ) {
    // Local filesystem frame
    imageBuffer = await readFile( frame.image )
  } else {
    // Fetch from external URL
    const res = await externalFetch( frame.publicUrl );
    if ( !res.ok ) throw new Error( `Failed to fetch frame image: ${res.statusText}` );
    imageBuffer = Buffer.from( await res.arrayBuffer() );
  }

  // Process through sharp: convert to RGBA, clear green marker pixels
  const { data, info } = await sharp( imageBuffer )
    .ensureAlpha()
    .raw()
    .toBuffer( { resolveWithObject : true } )

  const pixels = Buffer.from( data )
  clearGreenPixels( pixels, info.width, info.height, info.channels )

  const overlay = await sharp( pixels, {
    raw : { width : info.width, height : info.height, channels : info.channels },
  } )
    .png()
    .toBuffer()

  await writeFile( cachedPath, overlay )

  return cachedPath
}

// ── Image loop MP4 ────────────────────────────────────────────────

const LOOP_W = 720;
/** Canvas height used only when the photos' own shape cannot be probed. */
const LOOP_FALLBACK_H = 480;
const SECS_PER_PHOTO = 0.7;

/**
 * Create an MP4 video showing each photo for 0.7s. Uses per-input
 * `-loop 1 -t 0.7` so each image stays on screen for the full duration
 * instead of flickering as a single frame.
 */
export async function generateLoopVideo(
  sessionId: string,
  files: string[],
): Promise<{ file: string; url: string } | null> {
  return singleFlight( `loop-${sessionId}.mp4`, () => buildLoopVideo( sessionId, files ) )
}

async function buildLoopVideo(
  sessionId: string,
  files: string[],
): Promise<{ file: string; url: string } | null> {
  if ( files.length === 0 ) return null

  const hasFfmpeg = await ffmpegAvailable()
  if ( !hasFfmpeg ) return null

  await mkdir( CAPTURES_DIR, { recursive : true } )

  const vidName = `loop-${sessionId}.mp4`

  // Build inputs: each image looped for SECS_PER_PHOTO seconds
  const inputs: string[] = []
  for ( const f of files ) {
    const abs = path.resolve( CAPTURES_DIR, path.basename( f ) )
    inputs.push(
      "-loop", "1",
      "-t", String( SECS_PER_PHOTO ),
      "-i", abs,
    )
  }

  // Build concat filter: [0:v][1:v][2:v]...concat=n=N:v=1:a=0
  const streamTags = files.map( ( _, i ) => `[${i}:v]` ).join( "" )

  // Size the canvas to the photos' own shape, so a session needs no padding at
  // all. `pad` defaults to black, which reads as a border around every photo —
  // the strip's paper is white, so white is the fallback for a session whose
  // photos differ in size. Round *up*: a canvas smaller than the scaled frame
  // makes ffmpeg reject the whole filter graph.
  const first = await videoSize(
    path.resolve( CAPTURES_DIR, path.basename( files[0] ) ),
  )
  const canvasH = first.width > 0
    ? evenUp( Math.round( ( LOOP_W * first.height ) / first.width ) )
    : LOOP_FALLBACK_H

  const filterComplex = [
    `${streamTags}concat=n=${files.length}:v=1:a=0`,
    `scale=${LOOP_W}:-2:force_original_aspect_ratio=decrease`,
    `pad=${LOOP_W}:${canvasH}:(ow-iw)/2:(oh-ih)/2:color=white`,
    "fps=24",
    "format=yuv420p",
  ].join( "," )

  await writeMediaAtomically( vidName, ( outPath ) => new Promise<void>( ( resolve, reject ) => {
    const proc = spawn( "ffmpeg", [
      "-y",
      ...inputs,
      "-filter_complex", filterComplex,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-profile:v", "main",
      "-level", "4.0",
      "-tag:v", "avc1",
      "-movflags", "+faststart",
      outPath,
    ], { stdio : "inherit" } )
    proc.on( "close", ( code ) => {
      if ( code === 0 ) resolve()
      else reject( new Error( `ffmpeg loop video exited with ${code}` ) )
    } )
  } ) )

  return { file : vidName, url : `/captures/${vidName}` }
}

// ── Countdown clip recording ──────────────────────────────────────

/** Constant output cadence for a recorded countdown clip. */
const CLIP_FPS = 25

/**
 * End a recording whose preview has been silent for this many milliseconds.
 *
 * Taking the still pauses the live view (the sidecar serializes preview and
 * capture), so frames simply stop arriving when the countdown ends. Long enough
 * to ride out a slow frame, short enough to finish soon after the shot.
 */
const CLIP_READ_TIMEOUT_MS = 3000

/**
 * Record the countdown window straight off the camera's live MJPEG preview and
 * encode it to MP4/H.264.
 *
 * The live view is a JPEG stream, so a browser-side recorder had to paint every
 * frame onto a canvas and re-encode it with MediaRecorder — a frame-dropping
 * second generation, and VP9/WebM on browsers that can't mux H.264. ffmpeg
 * reads the same stream the preview shows, so the clip is a single H.264 encode
 * of exactly the frames the camera sent.
 *
 * Resolution is left at the stream's native size — the EOS M6 PTP live view is
 * 480×320 and upscaling only adds interpolated pixels.
 *
 * Returns null when ffmpeg is unavailable or nothing usable was recorded; the
 * capture itself is unaffected, the result video just falls back to the image
 * slideshow.
 */
export async function recordCountdownClip(
  sessionId: string,
  index: number,
  streamUrl: string,
  durationSec: number,
  mirror = false,
): Promise<{ file: string; url: string } | null> {
  const hasFfmpeg = await ffmpegAvailable()
  if ( !hasFfmpeg ) return null

  await mkdir( CAPTURES_DIR, { recursive : true } )

  const clipName = `countdown-${sessionId}-${index}.mp4`
  const outPath = path.join( CAPTURES_DIR, clipName )
  // Encode to a temp file and rename only once it's known good — a half-written
  // `countdown-*.mp4` would otherwise be picked up by the mashup and the sync.
  const tmpPath = path.join(
    CAPTURES_DIR,
    `.rec-${sessionId}-${index}-${Date.now()}.mp4`,
  )

  const duration = Math.min( 15, Math.max( 1, durationSec ) )
  // `-t` ends a healthy recording at exactly the countdown length. When the
  // preview goes quiet instead, the input read timeout ends it — and ffmpeg
  // finalizes the file on the way out. A signal can't do that job: blocked on a
  // stalled socket, ffmpeg ignores SIGINT until the read returns, so the
  // deadline below is only a backstop for a genuinely hung process.
  const stopAt = duration * 1000 + CLIP_READ_TIMEOUT_MS + 2000
  const killAt = stopAt + 3000

  await new Promise<void>( ( resolve ) => {
    const proc = spawn( "ffmpeg", [
      "-y",
      // The preview is multipart/x-mixed-replace MJPEG.
      "-f", "mpjpeg",
      // Give up on a silent stream rather than waiting for a frame forever.
      "-rw_timeout", String( CLIP_READ_TIMEOUT_MS * 1000 ),
      // Stamp each frame with its arrival time. The demuxer assumes 25 fps, so
      // a slower (or bursty) camera would otherwise play back sped up.
      "-use_wallclock_as_timestamps", "1",
      "-i", streamUrl,
      "-t", String( duration ),
      // `fps` gives a constant-rate output from the arrival timestamps;
      // the odd-sized crop keeps any stream legal for yuv420p.
      "-vf", `${mirror ? "hflip," : ""}fps=${CLIP_FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-profile:v", "main",
      "-level", "4.0",
      "-tag:v", "avc1",
      "-movflags", "+faststart",
      tmpPath,
    ], { stdio : "ignore" } )

    let settled = false
    const finish = () => {
      if ( settled ) return
      settled = true
      clearTimeout( sigintTimer )
      clearTimeout( sigkillTimer )
      resolve()
    }

    const sigintTimer = setTimeout( () => proc.kill( "SIGINT" ), stopAt )
    const sigkillTimer = setTimeout( () => proc.kill( "SIGKILL" ), killAt )
    proc.on( "close", finish )
    proc.on( "error", finish )
  } )

  // The exit code depends on how the recording ended (`-t` stop, read timeout,
  // or the backstop signal), so the file is the only source of truth: fewer
  // than two frames means ffmpeg wrote an unplayable stub.
  const frames = await videoFrameCount( tmpPath )
  if ( frames < MIN_CLIP_FRAMES ) {
    await unlink( tmpPath ).catch( () => {} )

    return null
  }

  await rename( tmpPath, outPath )
  // Only one container may exist per index, or the mashup picks the wrong one.
  await unlink(
    path.join( CAPTURES_DIR, `countdown-${sessionId}-${index}.webm` ),
  ).catch( () => {} )

  return { file : clipName, url : `/captures/${clipName}` }
}

// ── Save raw (unprocessed copy) ────────────────────────────────────

/** Write a second immutable copy of the raw capture so the original is always
 *  preserved even if a slot is later retaken and overwrites the shot-N file. */
export async function saveRawCopy(
  sessionId: string,
  index: number,
  buffer: Buffer,
): Promise<string> {
  await mkdir( CAPTURES_DIR, { recursive : true } );
  const name = `raw-shot-${sessionId}-${index}.jpg`;
  await writeFile( path.join( CAPTURES_DIR, name ), buffer );

  return name;
}
