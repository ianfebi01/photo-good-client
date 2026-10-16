import { Capacitor, CapacitorHttp } from '@capacitor/core'

// ── Standalone booth API client ─────────────────────────────────────
//
// The standalone build (the Android app) has no Next.js server of its own, so
// the calls the server used to proxy — frames, settings, payment, media upload,
// results — go from the device straight to the booth API.
//
// In the app they go through Capacitor's native HTTP stack rather than the
// WebView's fetch: the booth API's CORS headers only name the old proxy's
// origins, and the R2 bucket sends none at all, so a WebView request from
// `https://localhost` would be blocked on both. Native requests are not subject
// to CORS. A browser running the standalone build (for development) falls back
// to fetch and needs those CORS rules in place.
//
// The booth key is baked into the bundle (`NEXT_PUBLIC_BOOTH_API_KEY`): with no
// server there is nowhere else to keep it. It identifies this one booth.

/** True in the static, server-less build (`pnpm android:build`). */
export function isStandalone(): boolean {
  return process.env.NEXT_PUBLIC_STANDALONE === '1'
}

const BASE_URL = ( process.env.NEXT_PUBLIC_BASE_URL ?? '' ).replace( /\/$/, '' )
const API_KEY = process.env.NEXT_PUBLIC_BOOTH_API_KEY ?? ''

/** Resolve a booth-API path (or pass an absolute URL through). */
export function apiUrl( pathOrUrl: string ): string {
  return /^https?:/i.test( pathOrUrl )
    ? pathOrUrl
    : `${BASE_URL}/${pathOrUrl.replace( /^\//, '' )}`
}

function native(): boolean {
  return Capacitor.isNativePlatform()
}

function authHeaders( extra?: Record<string, string> ): Record<string, string> {
  return {
    ...( API_KEY ? { Authorization : `Bearer ${API_KEY}` } : {} ),
    ...extra,
  }
}

function errorFrom( status: number, data: unknown, fallback: string ): Error {
  const message =
    data && typeof data === 'object' && 'error' in data
      ? String( ( data as { error: unknown } ).error )
      : typeof data === 'string' && data
        ? data
        : `${fallback} (${status})`

  return new Error( message )
}

/**
 * Call the booth API with the booth key and parse JSON. Throws with the API's
 * own `error` message on a non-2xx status.
 */
export async function boothApiJson<T>(
  path: string,
  {
    method = 'GET',
    body,
    fallbackError = 'Booth API request failed',
  }: { method?: string; body?: unknown; fallbackError?: string } = {},
): Promise<T> {
  const url = apiUrl( path )
  const headers = authHeaders( body !== undefined ? { 'Content-Type' : 'application/json' } : {} )

  if ( native() ) {
    const res = await CapacitorHttp.request( {
      url,
      method,
      headers,
      data         : body,
      responseType : 'json',
    } )
    const data = parseMaybeJson( res.data )
    if ( res.status < 200 || res.status >= 300 ) throw errorFrom( res.status, data, fallbackError )

    return data as T
  }

  const res = await fetch( url, {
    method,
    headers,
    body  : body !== undefined ? JSON.stringify( body ) : undefined,
    cache : 'no-store',
  } )
  const data = await res.json().catch( () => null )
  if ( !res.ok ) throw errorFrom( res.status, data, fallbackError )

  return data as T
}

function parseMaybeJson( data: unknown ): unknown {
  if ( typeof data !== 'string' ) return data
  try {
    return JSON.parse( data )
  } catch {
    return data
  }
}

function base64ToBlob( base64: string, type: string ): Blob {
  const binary = atob( base64.replace( /\s/g, '' ) )
  const bytes = new Uint8Array( binary.length )
  for ( let i = 0; i < binary.length; i++ ) bytes[i] = binary.charCodeAt( i )

  return new Blob( [bytes], { type } )
}

async function blobToBase64( blob: Blob ): Promise<string> {
  const bytes = new Uint8Array( await blob.arrayBuffer() )
  let binary = ''
  // Chunked: String.fromCharCode over a whole video overflows the call stack.
  for ( let i = 0; i < bytes.length; i += 0x8000 ) {
    binary += String.fromCharCode( ...bytes.subarray( i, i + 0x8000 ) )
  }

  return btoa( binary )
}

/**
 * Download a file (e.g. frame artwork on R2) as a Blob. The booth key is only
 * sent to the booth API itself, never to a third-party host.
 */
export async function fetchBinary( pathOrUrl: string ): Promise<Blob> {
  const url = apiUrl( pathOrUrl )
  const headers = url.startsWith( BASE_URL ) && BASE_URL ? authHeaders() : {}

  if ( native() ) {
    const res = await CapacitorHttp.request( { url, method : 'GET', headers, responseType : 'blob' } )
    if ( res.status < 200 || res.status >= 300 ) {
      throw new Error( `Download failed (${res.status}): ${url}` )
    }
    const type = headerValue( res.headers, 'content-type' ) ?? 'application/octet-stream'

    return base64ToBlob( String( res.data ), type.split( ';' )[0] )
  }

  const res = await fetch( url, { headers } )
  if ( !res.ok ) throw new Error( `Download failed (${res.status}): ${url}` )

  return res.blob()
}

/** PUT raw bytes to a presigned storage URL — the URL is the credential. */
export async function putBinary( url: string, blob: Blob, contentType: string ): Promise<void> {
  if ( native() ) {
    const res = await CapacitorHttp.request( {
      url,
      method   : 'PUT',
      headers  : { 'Content-Type' : contentType },
      data     : await blobToBase64( blob ),
      dataType : 'file',
    } )
    if ( res.status < 200 || res.status >= 300 ) {
      throw new Error( `Upload rejected by storage (${res.status})` )
    }

    return
  }

  const res = await fetch( url, {
    method  : 'PUT',
    headers : { 'Content-Type' : contentType },
    body    : blob,
  } )
  if ( !res.ok ) throw new Error( `Upload rejected by storage (${res.status})` )
}

function headerValue( headers: Record<string, string> | undefined, name: string ): string | undefined {
  if ( !headers ) return undefined
  const key = Object.keys( headers ).find( ( k ) => k.toLowerCase() === name )

  return key ? headers[key] : undefined
}
