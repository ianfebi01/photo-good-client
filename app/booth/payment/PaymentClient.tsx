'use client'

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { useRouter } from 'next/navigation'

import { useBoothStore } from '@/store/boothStore'
import { usePaymentPolling } from '@/lib/hooks/usePaymentPolling'
import { useBoothSettings } from '@/lib/hooks/useBoothSettings'
import { createPaymentCharge } from '@/lib/photobooth/payment.query'
import type { PaymentChargeState } from '@/types/payment'
import {
  PhaseLoading,
  PhaseCreating,
  PhasePending,
  PhaseSettled,
  PhaseError,
  PhaseExpired,
  PhaseFallback,
} from '@/components/payment'

// ── Types ──────────────────────────────────────────────────────────

type Phase = 'loading' | 'idle' | 'creating' | 'pending' | 'settled' | 'paid' | 'expired' | 'error'

export type { PaymentChargeState } from '@/types/payment'

// ── Reducer: payment state machine ─────────────────────────────────

type PaymentState = {
  phase : Phase
  charge : PaymentChargeState | null
  errorMsg : string | null
  countdown : number
}

type PaymentAction =
  | { type : 'HYDRATE'; phase : Phase; charge : PaymentChargeState | null }
  | { type : 'CREATE_START' }
  | { type : 'CREATE_OK'; charge : PaymentChargeState }
  | { type : 'CREATE_ERROR'; error : string }
  | { type : 'SETTLEMENT' }
  | { type : 'TERMINAL'; reason : string }
  | { type : 'TICK' }
  | { type : 'PAID' }
  | { type : 'RESET' }

const initialState: PaymentState = {
  phase     : 'loading',
  charge    : null,
  errorMsg  : null,
  countdown : 5,
}

function paymentReducer( state: PaymentState, action: PaymentAction ): PaymentState {
  switch ( action.type ) {
  case 'HYDRATE':
    return { ...state, phase : action.phase, charge : action.charge }

  case 'CREATE_START':
    return { ...state, phase : 'creating', errorMsg : null }

  case 'CREATE_OK':
    return { ...state, phase : 'pending', charge : action.charge }

  case 'CREATE_ERROR':
    return { ...state, phase : 'error', errorMsg : action.error }

  case 'SETTLEMENT':
    return { ...state, phase : 'settled', countdown : 5 }

  case 'TERMINAL': {
    const phase = action.reason === 'expire' ? 'expired' as const : 'error' as const

    return { ...state, phase, errorMsg : `Payment ${action.reason}` }
  }

  case 'TICK':
    return { ...state, countdown : Math.max( 0, state.countdown - 1 ) }

  case 'PAID':
    return { ...state, phase : 'paid' }

  case 'RESET':
    return { ...initialState, phase : 'idle' }

  default:
    return state
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/** Determine the initial phase from persisted store state.
 *  Called inside useEffect so Zustand `persist` hydration is complete. */
function resolveInitialPhase(): { phase : Phase; charge : PaymentChargeState | null } {
  const s = useBoothStore.getState()

  // Payment already completed — block re-entry to this page.
  if ( s.paymentStatus === 'paid' ) {
    return { phase : 'paid', charge : null }
  }

  if ( s.paymentOrderId && s.paymentQrCodeUrl ) {
    return {
      phase  : 'pending',
      charge : {
        orderId           : s.paymentOrderId,
        transactionId     : null,
        transactionStatus : 'pending',
        qrCodeUrl         : s.paymentQrCodeUrl,
        deeplinkUrl       : s.paymentDeeplinkUrl ?? null,
        grossAmount       : s.paymentGrossAmount ?? 15000,
        paymentType       : s.paymentType ?? 'qris',
        gateway           : s.paymentGateway ?? 'doku',
        expiryTime        : s.paymentExpiryTime ?? null,
        boothName         : '',
      },
    }
  }

  return { phase : 'idle', charge : null }
}

// ── Component ──────────────────────────────────────────────────────

export function PaymentClient() {
  const router = useRouter()
  const { sessionId, setPayment } = useBoothStore()
  const [state, dispatch] = useReducer( paymentReducer, initialState )
  const { phase, charge, errorMsg, countdown } = state

  const creatingRef = useRef( false )

  // ── Per-booth settings ─────────────────────────────────────────
  const settingsQuery = useBoothSettings()

  // ── Hydrate from persisted store after mount ───────────────────
  // Gated on settings: reaching the 'idle' phase auto-creates a charge, so a
  // booth with payment turned off must bail out before that happens.
  useEffect( () => {
    if ( settingsQuery.isPending ) return

    if ( settingsQuery.data && !settingsQuery.data.paymentEnabled ) {
      router.replace( '/booth' )

      return
    }

    const resolved = resolveInitialPhase()
    dispatch( { type : 'HYDRATE', phase : resolved.phase, charge : resolved.charge } )
  }, [settingsQuery.isPending, settingsQuery.data, router] )

  // ── Poll while pending ─────────────────────────────────────────
  const pollResult = usePaymentPolling(
    phase === 'pending' ? charge?.orderId ?? null : null,
  )

  // ── React to poll result ───────────────────────────────────────
  useEffect( () => {
    if ( pollResult.status === 'settlement' ) {
      dispatch( { type : 'SETTLEMENT' } )
    } else if ( pollResult.status === 'terminal' ) {
      dispatch( { type : 'TERMINAL', reason : pollResult.reason } )
      setPayment( { paymentStatus : pollResult.reason as 'expired' | 'error' } )
    }
    // 'polling' is intentionally ignored
  }, [pollResult, setPayment] )

  // ── Redirect immediately if re-entering after payment ───────────
  useEffect( () => {
    if ( phase === 'paid' ) {
      router.replace( '/booth' )
    }
  }, [phase, router] )

  // ── Countdown after settlement ─────────────────────────────────
  useEffect( () => {
    if ( phase !== 'settled' ) return

    const id = setInterval( () => dispatch( { type : 'TICK' } ), 1000 )

    return () => clearInterval( id )
  }, [phase] )

  // ── Countdown complete → promote to paid & navigate ────────────
  useEffect( () => {
    if ( phase === 'settled' && countdown === 0 ) {
      dispatch( { type : 'PAID' } )
      setPayment( { paymentStatus : 'paid' } )
      router.replace( '/booth' )
    }
  }, [phase, countdown, router, setPayment] )

  // ── Create charge ──────────────────────────────────────────────
  const createCharge = useCallback( async () => {
    if ( creatingRef.current ) return
    creatingRef.current = true

    dispatch( { type : 'CREATE_START' } )
    const paySessionId = sessionId || Math.random().toString( 36 ).slice( 2, 10 )

    try {
      const data = await createPaymentCharge( paySessionId )

      useBoothStore.setState( { sessionId : paySessionId } )

      const chargeState: PaymentChargeState = {
        orderId           : data.orderId,
        transactionId     : data.transactionId ?? null,
        transactionStatus : data.transactionStatus ?? 'pending',
        qrCodeUrl         : data.qrCodeUrl,
        deeplinkUrl       : data.deeplinkUrl ?? null,
        grossAmount       : data.grossAmount,
        paymentType       : data.paymentType ?? 'qris',
        gateway           : data.gateway ?? 'doku',
        expiryTime        : data.expiryTime ?? null,
        boothName         : data.booth?.name || '',
      }

      dispatch( {
        type   : 'CREATE_OK',
        charge : chargeState,
      } )
      setPayment( {
        paymentStatus      : 'pending',
        paymentOrderId     : data.orderId,
        paymentQrCodeUrl   : data.qrCodeUrl,
        paymentDeeplinkUrl : data.deeplinkUrl ?? null,
        paymentGrossAmount : data.grossAmount,
        paymentGateway     : data.gateway ?? null,
        paymentType        : data.paymentType ?? null,
        paymentExpiryTime  : data.expiryTime ?? null,
      } )
    } catch ( err ) {
      dispatch( {
        type  : 'CREATE_ERROR',
        error : err instanceof Error ? err.message : 'Unknown error',
      } )
    } finally {
      creatingRef.current = false
    }
  }, [sessionId, setPayment] )

  // ── Auto-create charge when idle (no manual "Start" step) ──────
  useEffect( () => {
    if ( phase === 'idle' ) {
      createCharge()
    }
  }, [phase, createCharge] )

  // ── Retry handler ──────────────────────────────────────────────
  const handleRetry = useCallback( () => {
    setPayment( {
      paymentStatus      : 'idle',
      paymentOrderId     : null,
      paymentQrCodeUrl   : null,
      paymentDeeplinkUrl : null,
      paymentGrossAmount : null,
      paymentGateway     : null,
      paymentType        : null,
      paymentExpiryTime  : null,
    } )
    dispatch( { type : 'RESET' } )
    createCharge()
  }, [createCharge, setPayment] )

  // ── Render ─────────────────────────────────────────────────────

  // Still resolving store hydration — show a neutral loader so we never
  // flash 'idle' or stale UI before snapping to the real phase.
  if ( phase === 'loading' || phase === 'paid' ) {
    return <PhaseLoading />
  }

  // Fresh settlement: show countdown, then promote to 'paid' & persist.
  if ( phase === 'settled' ) {
    return <PhaseSettled countdown={countdown} />
  }

  if ( phase === 'creating' ) {
    return <PhaseCreating />
  }

  if ( phase === 'pending' && charge ) {
    return <PhasePending charge={charge} />
  }

  if ( phase === 'error' ) {
    return (
      <PhaseError
        errorMsg={errorMsg}
        onRetry={handleRetry}
      />
    )
  }

  if ( phase === 'expired' ) {
    return <PhaseExpired onRetry={handleRetry} />
  }

  // Fallback
  return <PhaseFallback onRetry={handleRetry} />
}
