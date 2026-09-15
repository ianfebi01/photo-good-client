import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { CAPTURES_DIR, externalFetch } from '@/lib/photobooth/config'
import type { BoothResultCreateRequest, BoothResultCreateResponse, BoothResultItem, BoothMediaType } from '@/types/booth'

export const runtime = 'nodejs'

export async function POST( request: Request ) {
  try {
    const body = await request.json() as {
      sessionId: string
      frameKey?: string
      items: Array<{ filename: string; type: BoothMediaType }>
    }

    const { sessionId, frameKey, items } = body
    if ( !sessionId || !items || !Array.isArray( items ) || items.length === 0 ) {
      return NextResponse.json( { error : 'Missing required fields' }, { status : 400 } )
    }

    const syncedItems: BoothResultItem[] = []

    for ( const item of items ) {
      const filename = path.basename( item.filename )
      const filePath = path.join( CAPTURES_DIR, filename )

      try {
        const buffer = await readFile( filePath )
        
        // Determine mime-type. Only the formats this booth produces are
        // synced: anything else (a legacy .webm clip, say) would be labelled
        // from a guess and stored as the wrong format.
        let mimeType = 'image/jpeg'
        if ( filename.endsWith( '.mp4' ) ) {
          mimeType = 'video/mp4'
        } else if ( filename.endsWith( '.gif' ) ) {
          mimeType = 'image/gif'
        } else if ( !filename.endsWith( '.jpg' ) && !filename.endsWith( '.jpeg' ) ) {
          // eslint-disable-next-line no-console
          console.error( `Skipping unsupported media file: ${filename}` )
          continue
        }

        const blob = new Blob( [buffer], { type : mimeType } )
        const formData = new FormData()
        formData.append( 'file', blob, filename )

        const mediaRes = await externalFetch( '/api/booth/media', {
          method : 'POST',
          body   : formData,
        } )

        if ( !mediaRes.ok ) {
          const errMsg = await mediaRes.text()
          // eslint-disable-next-line no-console
          console.error( `Failed to upload media ${filename} to external API:`, errMsg )
          continue
        }

        const mediaData = await mediaRes.json() as any
        // eslint-disable-next-line no-console
        console.log( `Upload response for ${filename}:`, mediaData )

        const mediaId = mediaData.id || mediaData.mediaId || mediaData.media_id || mediaData.media?.id || mediaData.media?.media_id

        if ( !mediaId ) {
          // eslint-disable-next-line no-console
          console.error( `Could not find media ID in response for ${filename}:`, mediaData )
          continue
        }

        syncedItems.push( {
          mediaId  : mediaId,
          media_id : mediaId, // Send both cases just in case
          type     : item.type,
        } as any )
      } catch ( err ) {
        // eslint-disable-next-line no-console
        console.error( `Error uploading file ${filename}:`, err )
      }
    }

    if ( syncedItems.length === 0 ) {
      return NextResponse.json( { error : 'No media was successfully uploaded' }, { status : 500 } )
    }

    // Post results to the external API
    const resultPayload: BoothResultCreateRequest = {
      sessionId,
      frameKey,
      items : syncedItems,
    }

    const resultRes = await externalFetch( '/api/booth/results', {
      method  : 'POST',
      headers : { 'Content-Type' : 'application/json' },
      body    : JSON.stringify( resultPayload ),
    } )

    if ( !resultRes.ok ) {
      const errMsg = await resultRes.text()

      return NextResponse.json( { error : `Failed to create result on external API: ${errMsg}` }, { status : resultRes.status } )
    }

    const resultData = await resultRes.json() as BoothResultCreateResponse

    return NextResponse.json( resultData, { status : 201 } )
  } catch ( err ) {
    // eslint-disable-next-line no-console
    console.error( 'Error syncing media:', err )
    
    return NextResponse.json( { error : err instanceof Error ? err.message : 'Internal Server Error' }, { status : 500 } )
  }
}
