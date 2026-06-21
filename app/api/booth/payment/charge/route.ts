import { NextResponse } from 'next/server'
import { externalFetch } from '@/lib/photobooth/config'

export const runtime = 'nodejs'

/**
 * POST /api/booth/payment/charge
 *
 * Proxies the charge request to the external booth server, which handles
 * Midtrans integration.  The local client never touches Midtrans directly.
 */
export async function POST( request: Request ) {
  let body: { sessionId?: string; grossAmount?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error : 'Invalid JSON body' },
      { status : 400 },
    )
  }

  if ( !body.sessionId ) {
    return NextResponse.json(
      { error : 'Missing sessionId' },
      { status : 400 },
    )
  }

  try {
    const res = await externalFetch( '/api/booth/payment/charge', {
      method  : 'POST',
      headers : { 'Content-Type' : 'application/json' },
      body    : JSON.stringify( body ),
    } )

    const data = await res.json().catch( () => ( {} ) )

    if ( !res.ok ) {
      return NextResponse.json(
        { error : ( data as { error?: string } ).error || 'Charge failed' },
        { status : res.status },
      )
    }

    return NextResponse.json( data, { status : 201 } )
  } catch ( err ) {
    return NextResponse.json(
      { error : err instanceof Error ? err.message : 'Charge failed' },
      { status : 500 },
    )
  }
}
