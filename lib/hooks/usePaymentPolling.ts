'use client'

import { useEffect, useState } from 'react'

// ── Types ──────────────────────────────────────────────────────────

export type PollResult =
  | { status : 'settlement' }
  | { status : 'terminal'; reason : string }
  | { status : 'polling' }

const POLL_INTERVAL = 3_000
const POLL_TIMEOUT = 300_000

// ── Hook ───────────────────────────────────────────────────────────

export function usePaymentPolling( orderId: string | null ): PollResult {
  const [result, setResult] = useState<PollResult>( { status : 'polling' } )

  useEffect( () => {
    if ( !orderId ) return

    // Reset to 'polling' when the orderId changes so a stale result from
    // a previous charge doesn't leak into the new one.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResult( { status : 'polling' } )

    let alive = true
    let interval: ReturnType<typeof setInterval> | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/booth/payment/status?orderId=${orderId}`,
        )
        const data = await res.json()
        if ( !alive || !res.ok ) return

        if ( data.transactionStatus === 'settlement' ) {
          setResult( { status : 'settlement' } )
        } else if ( ['expire', 'cancel', 'deny', 'failure'].includes( data.transactionStatus ) ) {
          setResult( { status : 'terminal', reason : data.transactionStatus } )
        }
      } catch { /* network hiccup — keep polling */ }
    }

    poll()
    interval = setInterval( poll, POLL_INTERVAL )
    timeout = setTimeout( () => {
      if ( alive ) setResult( { status : 'terminal', reason : 'expire' } )
    }, POLL_TIMEOUT )

    return () => {
      alive = false
      if ( interval ) clearInterval( interval )
      if ( timeout ) clearTimeout( timeout )
    }
  }, [orderId] )

  return result
}
