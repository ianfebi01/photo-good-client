import { NextResponse } from 'next/server'
import { externalFetch } from '@/lib/photobooth/config'

export const runtime = 'nodejs'

/**
 * GET /api/booth/payment/status?orderId=...
 *
 * Proxies the status check to the external booth server, which handles
 * Midtrans integration.  The local client never touches Midtrans directly.
 */
export async function GET( request: Request ) {
  const { searchParams } = new URL( request.url )
  const orderId = searchParams.get( 'orderId' )

  if ( !orderId ) {
    return NextResponse.json(
      { error : 'Missing orderId' },
      { status : 400 },
    )
  }

  try {
    const res = await externalFetch(
      `/api/booth/payment/status?orderId=${encodeURIComponent( orderId )}`,
    )

    const data = await res.json().catch( () => ( {} ) )

    if ( !res.ok ) {
      return NextResponse.json(
        { error : ( data as { error?: string } ).error || 'Status check failed' },
        { status : res.status },
      )
    }

    return NextResponse.json( data )
  } catch ( err ) {
    return NextResponse.json(
      { error : err instanceof Error ? err.message : 'Status check failed' },
      { status : 500 },
    )
  }
}
