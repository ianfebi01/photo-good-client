import { normalizeSettings } from './settings.client'
import type { BoothClientSettings, BoothSettingsResponse } from '@/types/booth'

export const SETTINGS_QUERY_KEY = ['booth-settings'] as const

/**
 * Fetch this booth's client settings (GET /api/booth/settings).
 *
 * Throws on a non-2xx response so React Query surfaces the error; callers
 * keep their last known (or default) settings in that case.
 */
export async function getBoothSettings(): Promise<BoothClientSettings> {
  const response = await fetch( '/api/booth/settings', { cache : 'no-store' } )
  const data = await response.json().catch( () => null )

  if ( !response.ok ) {
    throw new Error( data?.error ?? 'Failed to load booth settings' )
  }

  return normalizeSettings( ( data as BoothSettingsResponse | null )?.settings )
}
