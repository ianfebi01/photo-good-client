'use client'

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FRAMES_QUERY_KEY } from '@/lib/photobooth/frames.query'

/**
 * On first mount (homepage visit), triggers a background sync that
 * downloads all frame images to the local disk.  Once the sync finishes,
 * the React Query cache is invalidated so the UI picks up the new
 * local-frame URLs automatically.
 *
 * The sync is skipped when local frames already exist — the server-side
 * fetchBoothFrames() detects the manifest and returns instantly.
 */
export function FrameSyncTrigger() {
  const queryClient = useQueryClient()
  const ranRef = useRef( false )

  useEffect( () => {
    if ( ranRef.current ) return
    ranRef.current = true

    fetch( '/api/frames/sync', { method : 'POST' } )
      .then( ( res ) => res.json().catch( () => ( {} ) ) )
      .then( ( data ) => {
        if ( data.synced > 0 ) {
          // New frames were synced — invalidate so the UI re-fetches
          queryClient.invalidateQueries( { queryKey : FRAMES_QUERY_KEY } )
        }
      } )
      .catch( () => {
        // Sync is best-effort; the app still works with external URLs
      } )
  }, [queryClient] )

  return null
}
