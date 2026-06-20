import 'server-only'

import fs from 'node:fs/promises'
import path from 'node:path'
import { FRAMES_DIR, FRAMES_MANIFEST_PATH, externalFetch } from './config'
import type { ClientFrame } from './frames.client'

// ── Types ──────────────────────────────────────────────────────────

type ManifestFrame = ClientFrame & { localFile: string }

type FrameManifest = {
  syncedAt: string
  frames: ManifestFrame[]
}

// ── Helpers ────────────────────────────────────────────────────────

/** Strip the internal `localFile` field before returning to callers. */
function toClientFrame( f: ManifestFrame ): ClientFrame {
  return {
    key        : f.key,
    label      : f.label,
    publicUrl  : f.publicUrl,
    width      : f.width,
    height     : f.height,
    photoCount : f.photoCount,
    slots      : f.slots,
    builtIn    : f.builtIn,
  }
}

// ── Sync: download all frames from external API to local disk ──────

/**
 * Fetch all frames from the external API, download each image to the
 * local `public/frames/` directory, and persist a manifest so future
 * reads skip the network entirely.
 */
export async function syncAllFrames(): Promise<ClientFrame[]> {
  // 1. Fetch frame metadata from external API
  const res = await externalFetch( '/api/booth/frames', { cache : 'no-store' } )
  if ( !res.ok ) {
    throw new Error( `Failed to fetch frames from external API: ${res.statusText}` )
  }

  const data = await res.json()
  const externalFrames: Array<{
    key: string
    label: string
    imageUrl: string
    width: number
    height: number
    slots: Array<{ left: number; top: number; width: number; height: number }>
    builtIn: boolean
  }> = data.frames ?? []

  if ( !Array.isArray( externalFrames ) || externalFrames.length === 0 ) {
    return []
  }

  // 2. Ensure the frames directory exists
  await fs.mkdir( FRAMES_DIR, { recursive : true } )

  // 3. Download each frame image to local disk
  const manifestFrames: ManifestFrame[] = []

  for ( const f of externalFrames ) {
    const ext = f.imageUrl.split( '.' ).pop()?.split( '?' )[0] || 'jpg'
    const localFile = `${f.key}.${ext}`
    const localPath = path.join( FRAMES_DIR, localFile )

    try {
      const imgRes = await fetch( f.imageUrl )
      if ( imgRes.ok ) {
        const buffer = Buffer.from( await imgRes.arrayBuffer() )
        await fs.writeFile( localPath, buffer )
      }
    } catch {
      // eslint-disable-next-line no-console
      console.warn( `Failed to download frame image: ${f.key}` )
      continue
    }

    manifestFrames.push( {
      key        : f.key,
      label      : f.label,
      publicUrl  : `/frames/${localFile}`,
      width      : f.width,
      height     : f.height,
      photoCount : f.slots.length,
      slots      : f.slots,
      builtIn    : f.builtIn,
      localFile,
    } )
  }

  // 4. Persist the manifest
  const manifest: FrameManifest = {
    syncedAt : new Date().toISOString(),
    frames   : manifestFrames,
  }
  await fs.writeFile( FRAMES_MANIFEST_PATH, JSON.stringify( manifest, null, 2 ) )

  // Return clean ClientFrame array (without localFile)
  // eslint-disable-next-line no-console
  console.log( `Synced ${manifestFrames.length} frames to local disk` )

  return manifestFrames.map( toClientFrame )
}

// ── Load: read frames from local disk (zero network) ────���─────────

/**
 * Load frames from the locally-synced manifest. Returns `null` when no
 * sync has been performed yet, so callers can fall back to the network.
 */
export async function loadLocalFrames(): Promise<ClientFrame[] | null> {
  try {
    const raw = await fs.readFile( FRAMES_MANIFEST_PATH, 'utf-8' )
    const manifest = JSON.parse( raw ) as FrameManifest

    if ( !manifest.frames || !Array.isArray( manifest.frames ) ) return null

    // Strip the localFile field before returning
    return manifest.frames.map( ( f ) => ( {
      key        : f.key,
      label      : f.label,
      publicUrl  : f.publicUrl,
      width      : f.width,
      height     : f.height,
      photoCount : f.photoCount,
      slots      : f.slots,
      builtIn    : f.builtIn,
    } ) )
  } catch {
    return null
  }
}

/**
 * Check whether a local copy of a frame image exists on disk.
 * If true, getFrame() / frame preview can use the local file directly.
 */
export async function hasLocalFrame( key: string ): Promise<boolean> {
  try {
    const manifest = await loadLocalFrames()

    return manifest?.some( ( f ) => f.key === key ) ?? false
  } catch {
    return false
  }
}

/**
 * Resolve the absolute path to a locally-synced frame image.
 * Returns null when the frame hasn't been synced yet.
 */
export async function getLocalFramePath( key: string ): Promise<string | null> {
  try {
    const raw = await fs.readFile( FRAMES_MANIFEST_PATH, 'utf-8' )
    const manifest = JSON.parse( raw ) as FrameManifest
    const found = manifest.frames.find( ( f ) => f.key === key )

    if ( !found ) return null

    return path.join( FRAMES_DIR, found.localFile )
  } catch {
    return null
  }
}
