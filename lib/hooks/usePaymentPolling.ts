'use client'

import { useEffect, useState } from 'react'

import { getPaymentStatus } from '@/lib/photobooth/payment.query'

// ── Types ──────────────────────────────────────────────────────────

export type PollResult =
  | { status : 'settlement' }
  | { status : 'terminal'; reason : string }
  | { status : 'polling' }

const POLL_INTERVAL = 3_000
const POLL_TIMEOUT = 300_000
const POLLING: PollResult = { status : 'polling' }

// ── Hook ───────────────────────────────────────────────────────────

export function usePaymentPolling( orderId: string | null ): PollResult {
  // Results are tagged with their orderId so a stale result from a previous
  // charge never leaks into the next one.
  const [tagged, setTagged] = useState<{ orderId : string; result : PollResult } | null>( null )

  useEffect( () => {
    if ( !orderId ) return

    const setResult = ( result: PollResult ) => setTagged( { orderId, result } )
    let alive = true
    let interval: ReturnType<typeof setInterval> | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        const data = await getPaymentStatus( orderId )
        if ( !alive ) return

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

  return tagged && tagged.orderId === orderId ? tagged.result : POLLING
}
