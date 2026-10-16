import { boothApiJson, isStandalone } from './boothApi'

/** POST /api/booth/payment/charge response (the fields the kiosk reads). */
export type PaymentCharge = {
  orderId: string
  qrCodeUrl: string
  deeplinkUrl?: string | null
  booth?: { id: string; name: string }
}

/** GET /api/booth/payment/status response (the fields the kiosk reads). */
export type PaymentStatus = {
  transactionStatus: string
}

/**
 * Create a QRIS charge for this session — through this app's proxy, or straight
 * to the booth API in the standalone build. Throws with the API's message.
 */
export async function createPaymentCharge( sessionId: string ): Promise<PaymentCharge> {
  if ( isStandalone() ) {
    return boothApiJson<PaymentCharge>( '/api/booth/payment/charge', {
      method        : 'POST',
      body          : { sessionId },
      fallbackError : 'Failed to create payment',
    } )
  }

  const res = await fetch( '/api/booth/payment/charge', {
    method  : 'POST',
    headers : { 'Content-Type' : 'application/json' },
    body    : JSON.stringify( { sessionId } ),
  } )
  const data = await res.json()
  if ( !res.ok ) throw new Error( data.error || 'Failed to create payment' )

  return data as PaymentCharge
}

/** Current state of a charge. Throws when the status can't be read. */
export async function getPaymentStatus( orderId: string ): Promise<PaymentStatus> {
  const path = `/api/booth/payment/status?orderId=${encodeURIComponent( orderId )}`
  if ( isStandalone() ) {
    return boothApiJson<PaymentStatus>( path, { fallbackError : 'Status check failed' } )
  }

  const res = await fetch( path )
  const data = await res.json()
  if ( !res.ok ) throw new Error( data.error || 'Status check failed' )

  return data as PaymentStatus
}
