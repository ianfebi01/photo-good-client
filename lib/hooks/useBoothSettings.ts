'use client'

import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'

import { useBoothStore } from '@/store/boothStore'
import { SETTINGS_QUERY_KEY, getBoothSettings } from '@/lib/photobooth/settings.query'
import { DEFAULT_BOOTH_SETTINGS } from '@/lib/photobooth/settings.client'
import type { BoothClientSettings } from '@/types/booth'

/**
 * Load this booth's client settings into the booth store.
 *
 * The store starts at `null` ("not resolved yet") so the payment guard can
 * wait instead of guessing. Once the request settles — success *or* failure —
 * a complete settings object is written, falling back to
 * {@link DEFAULT_BOOTH_SETTINGS} when the API is unreachable.
 *
 * Settings decide which steps the kiosk renders, so they are fetched once per
 * app load — same as the frames query. The QueryClient is rebuilt on every
 * reload, so an empty cache guarantees the fetch happens on each load, while
 * client-side navigation reuses the value instead of asking the API again.
 * React Query also dedupes concurrent requests by query key, so mounting this
 * in several components at once still issues a single call.
 */
export function useBoothSettings() {
  const setSettings = useBoothStore( ( state ) => state.setSettings )

  const query = useQuery( {
    queryKey  : SETTINGS_QUERY_KEY,
    queryFn   : getBoothSettings,
    staleTime : 1000 * 60,
  } )

  const lastAppliedRef = useRef<BoothClientSettings | null>( null )

  useEffect( () => {
    if ( query.isPending ) return

    const resolved = query.data ?? DEFAULT_BOOTH_SETTINGS
    if ( lastAppliedRef.current === resolved ) return
    lastAppliedRef.current = resolved
    setSettings( resolved )
  }, [query.isPending, query.data, setSettings] )

  return query
}
