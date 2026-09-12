import { fetchBoothSettings } from '@/lib/photobooth/settings.query.server'
import { FetchError } from '@/lib/photobooth/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Proxy: fetch this booth's client settings from the external booth API. */
export async function GET() {
  try {
    const settings = await fetchBoothSettings()

    return Response.json( { settings } )
  } catch ( err ) {
    if ( err instanceof FetchError ) {
      return Response.json( { error : err.message }, { status : err.status } )
    }

    return Response.json( { error : 'Failed to fetch booth settings' }, { status : 502 } )
  }
}
