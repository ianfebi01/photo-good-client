import path from "node:path";

/** Error thrown by externalFetch when the upstream API returns a non-2xx status. */
export class FetchError extends Error {
  status: number
  constructor( message: string, status: number ) {
    super( message )
    this.name = 'FetchError'
    this.status = status
  }
}

/** The base URL of the external frames/booth API. */
export const EXTERNAL_BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

/**
 * A global authorized fetcher that prepends the EXTERNAL_BASE_URL to relative paths
 * and automatically attaches the BOOTH_API_KEY authorization header.
 *
 * Automatically throws {@link FetchError} on 401 responses so every caller
 * propagates the correct status code without duplicating the check.
 */
export async function externalFetch( pathOrUrl: string, init?: RequestInit ): Promise<Response> {
  const url = pathOrUrl.startsWith( 'http' )
    ? pathOrUrl
    : `${EXTERNAL_BASE_URL.replace( /\/$/, '' )}/${pathOrUrl.replace( /^\//, '' )}`;

  const apiKey = process.env.BOOTH_API_KEY || '';

  const headers = new Headers( init?.headers );
  if ( apiKey && !headers.has( 'Authorization' ) ) {
    headers.set( 'Authorization', `Bearer ${apiKey}` );
  }

  const res = await fetch( url, {
    ...init,
    headers,
  } );

  // Central 401 interceptor — throw so every caller forwards the right status.
  if ( res.status === 401 ) {
    const body = await res.text().catch( () => '' )
    throw new FetchError( body || res.statusText, 401 )
  }

  return res
}

/** Absolute directory where captures and composed strips are written. */
export const CAPTURES_DIR = process.env.CAPTURES_DIR
  ? path.resolve( process.env.CAPTURES_DIR )
  : path.join( process.cwd(), "public", "captures" );

/**
 * Set PHOTOBOOTH_MOCK=1 to force the simulated camera even when a real one is
 * attached. Useful for development and demos.
 */
export const FORCE_MOCK = process.env.PHOTOBOOTH_MOCK === "1";

/** Single source photo aspect (3:2, typical of DSLR/mirrorless). */
export const PHOTO_WIDTH = 1200;
export const PHOTO_HEIGHT = 800;

/**
 * DNP RX1 printer standard: 4×6 inch paper at 300 dpi.
 * Printed strip is 2×6 (auto-cut), but the frame template must be the full 4×6.
 */
export const STRIP_WIDTH = 1200;
export const STRIP_HEIGHT = 1800;
export const STRIP_ASPECT_RATIO = 2 / 3; // width / height = 1200 / 1800

/**
 * Validate that an image matches the exact 4×6 aspect ratio (2:3).
 * Returns null if valid, or an error message string if invalid.
 */
export function validateFrameDimensions(
  width: number,
  height: number,
): string | null {
  const ratio = width / height;
  const expected = STRIP_ASPECT_RATIO;
  if ( Math.abs( ratio - expected ) > 0.001 ) {
    return `Frame must be exactly 4×6 aspect ratio (2:3, e.g. 1200×1800px). Got ${width}×${height} (ratio ${ratio.toFixed( 4 )})`;
  }

  return null;
}

export type FrameSlot = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type FrameDef = {
  key: string;
  label: string;
  /** Absolute path on disk to the frame image used during compose. */
  image: string;
  /** Public URL of the frame, served from /public for browser previews. */
  publicUrl: string;
  width: number;
  height: number;
  slots: FrameSlot[];
  /** True for frames bundled with the app. User uploads are false. */
  builtIn: boolean;
};

export async function getFrame( key: string ): Promise<FrameDef | null> {
  try {
    const res = await externalFetch( "/api/booth/frames", { cache : 'force-cache' } )
    if ( !res.ok ) return null
    const data = await res.json() as {
      frames: Array<{
        key: string
        label: string
        imageUrl: string
        width: number
        height: number
        slots: FrameSlot[]
        builtIn: boolean
      }>
    }
    const found = data.frames?.find( ( f ) => f.key === key )
    if ( !found ) return null

    return {
      key       : found.key,
      label     : found.label,
      image     : "",
      publicUrl : found.imageUrl,
      width     : found.width,
      height    : found.height,
      slots     : found.slots,
      builtIn   : found.builtIn,
    }
  } catch ( err ) {
    // eslint-disable-next-line no-console
    console.error( `Error fetching frame ${key}:`, err )

    return null
  }
}

export const DEFAULT_FRAME = "summer-day";

/** Upper bound on slots-per-frame; keeps file/payload validation cheap. */
export const MAX_SLOTS_PER_FRAME = 8;

/** Visual + branding tokens kept here so mock photos and styling stay in sync. */
export const FRAME = {
  accent     : "#EB4C4C",
  accentSoft : "#FFA6A6",
  textDark   : "#3a2222",
} as const;
