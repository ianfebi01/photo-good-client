import { NextResponse } from 'next/server'
import { syncAllFrames } from '@/lib/photobooth/frames.sync'

export const runtime = 'nodejs'

/**
 * POST /api/frames/sync
 *
 * Downloads all frame metadata + images from the external API and caches
 * them locally in `public/frames/`.  Subsequent visits serve frames from
 * the local disk with zero network latency.
 */
export async function POST() {
  try {
    const frames = await syncAllFrames()

    return NextResponse.json( { synced : frames.length, frames } )
  } catch ( err ) {
    return NextResponse.json(
      { error : err instanceof Error ? err.message : 'Sync failed' },
      { status : 500 },
    )
  }
}
