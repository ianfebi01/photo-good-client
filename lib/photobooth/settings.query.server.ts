import 'server-only'

import { externalFetch, FetchError } from './config'
import { normalizeSettings } from './settings.client'
import type { BoothClientSettings, BoothSettingsResponse } from '@/types/booth'

/**
 * Fetch this booth's settings from the external booth API.
 *
 * Server-only so `BOOTH_API_KEY` never reaches the browser — exposed to the
 * client through `GET /api/booth/settings`.
 */
export async function fetchBoothSettings(): Promise<BoothClientSettings> {
  const res = await externalFetch( '/api/booth/settings', { cache : 'no-store' } )

  if ( !res.ok ) {
    const body = await res.text().catch( () => '' )
    throw new FetchError( body || res.statusText, res.status )
  }

  const data = ( await res.json() ) as BoothSettingsResponse | null

  return normalizeSettings( data?.settings )
}
