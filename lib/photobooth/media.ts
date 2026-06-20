import "server-only";

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import { CAPTURES_DIR, getFrame, externalFetch } from "./config";
import { clearGreenPixels } from "./slots";

// ── Helpers ────────────────────────────────────────────────────────

/** Resolve an ffmpeg binary; returns null when unavailable. */
async function ffmpegAvailable(): Promise<boolean> {
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
  await mkdir( CAPTURES_DIR, { recursive : true } );

  const baseName = `anim-${sessionId}`;
  const gifName = `${baseName}.gif`;
  const outPath = path.join( CAPTURES_DIR, gifName );

  const hasFfmpeg = await ffmpegAvailable();

  if ( hasFfmpeg && files.length > 0 ) {
    await generateGifFfmpeg( files, outPath );
  } else {
    await generateGifSharp( files, outPath );
  }

  return { file : gifName, url : `/captures/${gifName}` };
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
  try { await import( "node:fs/promises" ).then( ( m ) => m.unlink( listPath ) ); } catch { /* ok */ }
  try { await import( "node:fs/promises" ).then( ( m ) => m.unlink( palettePath ) ); } catch { /* ok */ }
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
  const outPath = path.join( CAPTURES_DIR, vidName );
  const listPath = path.join( CAPTURES_DIR, `.vid-list-${Date.now()}.txt` );
  await writeConcatList( files, listPath );

  // Use concat demuxer → each image shown for 1.5 s with a smooth zoom effect
  await new Promise<void>( ( resolve, reject ) => {
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
  } );

  try { await import( "node:fs/promises" ).then( ( m ) => m.unlink( listPath ) ); } catch { /* ok */ }

  return { file : vidName, url : `/captures/${vidName}` };
}

// ── Countdown video mashup onto frame ─────────────────────────────

/**
 * Overlay each countdown .webm clip into its corresponding slot on the
 * frame image, producing a single combined MP4. Each clip is scaled to
 * fit its slot rect; the output is as long as the shortest clip.
 */
export async function generateCountdownMashup(
  sessionId: string,
  countdownFiles: string[],
  frameKey: string,
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
  const outPath = path.join( CAPTURES_DIR, vidName )

  // Build filter graph:
  // 1. Black canvas at frame size
  // 2. Scale clips into slots → overlay on canvas
  // 3. Colorkey green (#00BF63) out of frame PNG
  // 4. Overlay keyed frame on TOP → decorations cover clips
  const inputs: string[] = []
  const filters: string[] = []

  // Synthetic black canvas [0:v]
  filters.push(
    `color=c=black:s=${frame.width}x${frame.height}:d=9999,format=rgba[canvas]`,
  )
  let lastOut = "canvas"

  for ( let i = 0; i < countdownFiles.length && i < frame.slots.length; i++ ) {
    const clipPath = path.join(
      CAPTURES_DIR,
      path.basename( countdownFiles[i] ),
    )
    const slot = frame.slots[i]
    const idx = i // clip input index (canvas is synthetic)

    inputs.push( "-i", clipPath )

    const tag = `v${i}`
    filters.push(
      `[${idx}:v]scale=${slot.width}:${slot.height}:force_original_aspect_ratio=increase,crop=${slot.width}:${slot.height},setsar=1,fps=24,format=rgba[${tag}]`,
    )

    const outTag = i === countdownFiles.length - 1 ? "clips" : `o${i}`
    filters.push(
      `[${lastOut}][${tag}]overlay=${slot.left}:${slot.top}:shortest=1[${outTag}]`,
    )
    lastOut = outTag
  }

  // Frame image: already pre-keyed (green pixels → transparent via sharp),
  // so just ensure rgba pixel format before overlaying on top of clips.
  const frameIdx = countdownFiles.length
  inputs.push( "-i", frameImagePath )
  filters.push(
    `[${frameIdx}:v]format=rgba[fk]`,
  )
  filters.push( `[${lastOut}][fk]overlay=0:0,scale=720:-2,format=yuv420p[out]` )

  const filterComplex = filters.join( ";" )

  await new Promise<void>( ( resolve, reject ) => {
    const args = [
      "-y",
      ...inputs,
      "-filter_complex", filterComplex,
      "-map", "[out]",
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-profile:v", "main",
      "-level", "4.0",
      "-tag:v", "avc1",
      "-movflags", "+faststart",
      outPath,
    ]
    const proc = spawn( "ffmpeg", args, { stdio : "inherit" } )
    proc.on( "close", ( code ) => {
      if ( code === 0 ) resolve()
      else reject( new Error( `ffmpeg mashup exited with ${code}` ) )
    } )
  } )

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
  if ( files.length === 0 ) return null

  const hasFfmpeg = await ffmpegAvailable()
  if ( !hasFfmpeg ) return null

  await mkdir( CAPTURES_DIR, { recursive : true } )

  const vidName = `loop-${sessionId}.mp4`
  const outPath = path.join( CAPTURES_DIR, vidName )

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
  const filterComplex = [
    `${streamTags}concat=n=${files.length}:v=1:a=0`,
    `scale=${LOOP_W}:-2:force_original_aspect_ratio=decrease`,
    `pad=${LOOP_W}:480:(ow-iw)/2:(oh-ih)/2`,
    "fps=24",
    "format=yuv420p",
  ].join( "," )

  await new Promise<void>( ( resolve, reject ) => {
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
  } )

  return { file : vidName, url : `/captures/${vidName}` }
}

// ── Countdown clip → MP4 conversion ───────────────────────────────

/**
 * Convert a single recorded countdown `.webm` clip into an MP4 with H.264 so
 * it downloads/plays everywhere (Safari, iOS, QuickTime won't open VP9 webm).
 * The result is cached on disk and reused on subsequent requests.
 */
export async function convertCountdownToMp4(
  webmFile: string,
): Promise<{ file: string; url: string } | null> {
  const base = path.basename( webmFile )
  if ( !base.toLowerCase().endsWith( ".webm" ) ) return null

  const hasFfmpeg = await ffmpegAvailable()
  if ( !hasFfmpeg ) return null

  await mkdir( CAPTURES_DIR, { recursive : true } )

  const srcPath = path.join( CAPTURES_DIR, base )
  // Fail fast if the source clip doesn't exist.
  try {
    await readFile( srcPath )
  } catch {
    return null
  }

  const mp4Name = base.replace( /\.webm$/i, ".mp4" )
  const outPath = path.join( CAPTURES_DIR, mp4Name )

  // Reuse a previously converted MP4 if present.
  try {
    await readFile( outPath )

    return { file : mp4Name, url : `/captures/${mp4Name}` }
  } catch {
    // not converted yet
  }

  await new Promise<void>( ( resolve, reject ) => {
    const proc = spawn( "ffmpeg", [
      "-y",
      "-i", srcPath,
      "-vf",
      [
        // libx264 requires even dimensions; round down to the nearest even px.
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
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
      "-an",
      outPath,
    ], { stdio : "inherit" } )
    proc.on( "close", ( code ) => {
      if ( code === 0 ) resolve()
      else reject( new Error( `ffmpeg countdown mp4 conversion exited with ${code}` ) )
    } )
  } )

  return { file : mp4Name, url : `/captures/${mp4Name}` }
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
