import "server-only";

import sharp from "sharp";

import type { FrameSlot } from "./config";
import { isGreen } from "./greenKey";

// The keying itself is shared with the standalone (on-device) build.
export { clearGreenPixels, isGreen } from "./greenKey";

export type DetectResult = {
  width: number;
  height: number;
  slots: FrameSlot[];
};

/**
 * Scan an image for vertically-stacked green panels and return each one's
 * pixel bounding box (left/top/width/height). Bands are found by counting
 * green pixels per row, then per column within each band. `rowMinPixels` and
 * `colMinPixels` filter out noise from anti-aliased edges and stray pixels.
 */
export async function detectGreenSlots(
  imageBuffer: Buffer,
  opts: { rowMinPixels?: number; colMinPixels?: number } = {},
): Promise<DetectResult> {
  const { data, info } = await sharp( imageBuffer )
    .ensureAlpha()
    .raw()
    .toBuffer( { resolveWithObject : true } );

  const { width, height, channels } = info;
  const rowMin = opts.rowMinPixels ?? Math.max( 30, Math.floor( width * 0.08 ) );
  const colMin = opts.colMinPixels ?? Math.max( 5, Math.floor( height * 0.01 ) );

  const rowCount = new Array<number>( height ).fill( 0 );
  for ( let y = 0; y < height; y++ ) {
    let count = 0;
    const rowStart = y * width * channels;
    for ( let x = 0; x < width; x++ ) {
      const i = rowStart + x * channels;
      if ( isGreen( data[i], data[i + 1], data[i + 2] ) ) count++;
    }
    rowCount[y] = count;
  }

  const bands: Array<[number, number]> = [];
  let start = -1;
  for ( let y = 0; y < height; y++ ) {
    if ( rowCount[y] > rowMin ) {
      if ( start === -1 ) start = y;
    } else if ( start !== -1 ) {
      bands.push( [start, y - 1] );
      start = -1;
    }
  }
  if ( start !== -1 ) bands.push( [start, height - 1] );

  const slots: FrameSlot[] = [];

  for ( const [top, bottom] of bands ) {
    const colCount = new Array<number>( width ).fill( 0 );
    for ( let x = 0; x < width; x++ ) {
      let count = 0;
      for ( let y = top; y <= bottom; y++ ) {
        const i = ( y * width + x ) * channels;
        if ( isGreen( data[i], data[i + 1], data[i + 2] ) ) count++;
      }
      colCount[x] = count;
    }

    let left = -1;
    for ( let x = 0; x < width; x++ ) {
      if ( colCount[x] > colMin ) {
        if ( left === -1 ) left = x;
      } else if ( left !== -1 ) {
        slots.push( {
          left,
          top,
          width  : x - left,
          height : bottom - top + 1,
        } );
        left = -1;
      }
    }
    if ( left !== -1 ) {
      slots.push( {
        left,
        top,
        width  : width - left,
        height : bottom - top + 1,
      } );
    }
  }

  const validSlots = slots.filter( ( s ) => s.left >= 0 && s.width > 10 && s.height > 10 );

  // Sort slots vertically (column-major order)
  // If difference in 'left' is significant (> 5% of width), they belong to different columns
  validSlots.sort( ( a, b ) => {
    if ( Math.abs( a.left - b.left ) > width * 0.05 ) {
      return a.left - b.left;
    }
    
    return a.top - b.top;
  } );

  return { width, height, slots : validSlots };
}
