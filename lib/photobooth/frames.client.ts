/**
 * Client-safe frame metadata for the booth UI.
 *
 * The full catalog is fetched from /api/frames at runtime (user uploads only).
 * These constants provide the initial selection key and a tiny fallback list
 * so the selector renders before the fetch resolves.
 */

export type ClientFrame = {
  key: string;
  label: string;
  publicUrl: string;
  width: number;
  height: number;
  photoCount: number;
  slots: Array<{ left: number; top: number; width: number; height: number }>;
  builtIn: boolean;
};

/**
 * DNP RX1 printer standard: 4×6 inch paper at 300 dpi.
 * Client-side mirror of server constants for validation.
 */
export const STRIP_WIDTH = 1200;
export const STRIP_HEIGHT = 1800;
export const STRIP_ASPECT_RATIO = 2 / 3; // width / height

/**
 * Validate that an image matches the exact 4×6 aspect ratio (2:3).
 * Client-side validation — mirrors the server check.
 */
export function validateFrameDimensions(
  width: number,
  height: number,
): string | null {
  const ratio = width / height;
  if ( Math.abs( ratio - STRIP_ASPECT_RATIO ) > 0.001 ) {
    return `Frame must be exactly 4×6 aspect ratio (2:3, e.g. 1200×1800px). Got ${width}×${height}`;
  }

  return null;
}

/** No default frame key — the first available frame will be selected. */
export const DEFAULT_FRAME_KEY = "";

/** No built-in fallback frames — all frames come from the server. */
export const FALLBACK_FRAMES: ClientFrame[] = [];
