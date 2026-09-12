import type { BoothClientSettings } from '@/types/booth'

/**
 * Client-safe booth settings defaults.
 *
 * These mirror today's hard-coded behaviour, so a settings outage never
 * changes what the kiosk renders — it just falls back to the pre-settings
 * behaviour (payment required, idle timer off, capture counter visible).
 */
export const DEFAULT_BOOTH_SETTINGS: BoothClientSettings = {
  paymentEnabled        : true,
  disabledFrameKeys     : [],
  timerEnabled          : false,
  captureCounterEnabled : true,
}

/**
 * Coerce a raw `settings` payload into a complete {@link BoothClientSettings}.
 *
 * Missing or malformed fields fall back to {@link DEFAULT_BOOTH_SETTINGS} so
 * a partial backend response can never leave a flag `undefined`.
 */
export function normalizeSettings(
  raw : Partial<BoothClientSettings> | null | undefined,
): BoothClientSettings {
  if ( !raw || typeof raw !== 'object' ) return DEFAULT_BOOTH_SETTINGS

  return {
    paymentEnabled :
      typeof raw.paymentEnabled === 'boolean'
        ? raw.paymentEnabled
        : DEFAULT_BOOTH_SETTINGS.paymentEnabled,
    disabledFrameKeys :
      Array.isArray( raw.disabledFrameKeys )
        ? raw.disabledFrameKeys.map( String )
        : DEFAULT_BOOTH_SETTINGS.disabledFrameKeys,
    timerEnabled :
      typeof raw.timerEnabled === 'boolean'
        ? raw.timerEnabled
        : DEFAULT_BOOTH_SETTINGS.timerEnabled,
    captureCounterEnabled :
      typeof raw.captureCounterEnabled === 'boolean'
        ? raw.captureCounterEnabled
        : DEFAULT_BOOTH_SETTINGS.captureCounterEnabled,
  }
}
