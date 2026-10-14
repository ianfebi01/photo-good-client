// ── Slot keying ─────────────────────────────────────────────────────
//
// Frame artwork marks each photo window with a flat green panel. These helpers
// find and clear it, and are shared by the server (sharp, see slots.ts) and the
// standalone build (canvas), so both key a frame identically.

// Slot marker color: #00bf63
const SLOT_R = 0;
const SLOT_G = 191;
const SLOT_B = 99;
// Squared Euclidean threshold — distance from the marker color counted as a slot
const SLOT_THRESHOLD_SQ = 60 * 60;
// How many pixels to expand the cleared region by — raise to eat more green fringe
const DILATE_PX = 1;

export function isGreen( r: number, g: number, b: number ): boolean {
  const dr = r - SLOT_R;
  const dg = g - SLOT_G;
  const db = b - SLOT_B;

  return ( dr * dr + dg * dg + db * db ) < SLOT_THRESHOLD_SQ;
}

/**
 * Make every slot-marker pixel transparent (alpha=0), then dilate the cleared
 * region by `DILATE_PX` so anti-aliased green fringe along slot edges is also
 * removed. Uses a separable box-dilation (horizontal then vertical pass) so the
 * cost stays O(width*height*radius). Mutates `pixels` in place. PNG only.
 */
export function clearGreenPixels(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
): void {
  const mask = new Uint8Array( width * height );
  for ( let p = 0; p < width * height; p++ ) {
    const i = p * channels;
    if ( isGreen( pixels[i], pixels[i + 1], pixels[i + 2] ) ) mask[p] = 1;
  }

  const r = DILATE_PX;
  if ( r > 0 ) {
    // Horizontal pass: a pixel is set if any pixel within r columns is set
    const hPass = new Uint8Array( width * height );
    for ( let y = 0; y < height; y++ ) {
      const row = y * width;
      for ( let x = 0; x < width; x++ ) {
        const lo = Math.max( 0, x - r );
        const hi = Math.min( width - 1, x + r );
        let hit = 0;
        for ( let xx = lo; xx <= hi; xx++ ) {
          if ( mask[row + xx] === 1 ) {
            hit = 1;
            break;
          }
        }
        hPass[row + x] = hit;
      }
    }

    // Vertical pass over the horizontal result → full box dilation
    for ( let y = 0; y < height; y++ ) {
      for ( let x = 0; x < width; x++ ) {
        const lo = Math.max( 0, y - r );
        const hi = Math.min( height - 1, y + r );
        let hit = 0;
        for ( let yy = lo; yy <= hi; yy++ ) {
          if ( hPass[yy * width + x] === 1 ) {
            hit = 1;
            break;
          }
        }
        if ( hit ) mask[y * width + x] = 1;
      }
    }
  }

  for ( let p = 0; p < width * height; p++ ) {
    if ( mask[p] === 1 ) pixels[p * channels + 3] = 0;
  }
}
