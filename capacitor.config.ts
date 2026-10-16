import type { CapacitorConfig } from '@capacitor/cli'

/**
 * By default the app is standalone: the static booth build (`out/`, made by
 * `pnpm build:android`) ships inside the APK, the device camera does the
 * capturing, and strips and videos are made on the device. It needs nothing but
 * the booth API at NEXT_PUBLIC_BASE_URL.
 *
 * Set `CAPACITOR_SERVER_URL` at sync time to instead make the app a shell around
 * a running booth server (the Next.js app with its API routes). That URL must be
 * https, or http://localhost through `adb reverse`, for the camera to open.
 */
const serverUrl = process.env.CAPACITOR_SERVER_URL

const config: CapacitorConfig = {
  appId   : 'com.photogood.booth',
  appName : 'Photo Good Booth',
  webDir  : 'out',
  server  : serverUrl
    ? {
      url       : serverUrl,
      cleartext : serverUrl.startsWith( 'http:' ),
    }
    : undefined,
}

export default config
