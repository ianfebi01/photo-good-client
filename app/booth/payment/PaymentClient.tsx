'use client'

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, AlertCircle, CheckCircle2, ExternalLink, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useBoothStore } from '@/store/boothStore'
import { usePaymentPolling } from '@/lib/hooks/usePaymentPolling'

// ── Types ──────────────────────────────────────────────────────────

type Phase = 'loading' | 'idle' | 'creating' | 'pending' | 'settled' | 'paid' | 'expired' | 'error'

type Charge = {
  orderId : string
  qrCodeUrl : string
  deeplinkUrl : string | null
  boothName : string
}

// ── Reducer: payment state machine ─────────────────────────────────

type PaymentState = {
  phase : Phase
  charge : Charge | null
  errorMsg : string | null
  countdown : number
}

type PaymentAction =
  | { type : 'HYDRATE'; phase : Phase; charge : Charge | null }
  | { type : 'CREATE_START' }
  | { type : 'CREATE_OK'; charge : Charge }
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
function resolveInitialPhase(): { phase : Phase; charge : Charge | null } {
  const s = useBoothStore.getState()

  // Payment already completed — block re-entry to this page.
  if ( s.paymentStatus === 'paid' ) {
    return { phase : 'paid', charge : null }
  }

  if ( s.paymentOrderId && s.paymentQrCodeUrl ) {
    return {
      phase  : 'pending',
      charge : {
        orderId     : s.paymentOrderId,
        qrCodeUrl   : s.paymentQrCodeUrl,
        deeplinkUrl : s.paymentDeeplinkUrl ?? null,
        boothName   : '',
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

  // ── Hydrate from persisted store after mount ───────────────────
  useEffect( () => {
    const resolved = resolveInitialPhase()
    dispatch( { type : 'HYDRATE', phase : resolved.phase, charge : resolved.charge } )
  }, [] )

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
      const res = await fetch( '/api/booth/payment/charge', {
        method  : 'POST',
        headers : { 'Content-Type' : 'application/json' },
        body    : JSON.stringify( { sessionId : paySessionId } ),
      } )
      const data = await res.json()

      if ( !res.ok ) throw new Error( data.error || 'Failed to create payment' )

      useBoothStore.setState( { sessionId : paySessionId } )

      dispatch( {
        type   : 'CREATE_OK',
        charge : {
          orderId     : data.orderId,
          qrCodeUrl   : data.qrCodeUrl,
          deeplinkUrl : data.deeplinkUrl ?? null,
          boothName   : data.booth?.name || '',
        },
      } )
      setPayment( {
        paymentStatus      : 'pending',
        paymentOrderId     : data.orderId,
        paymentQrCodeUrl   : data.qrCodeUrl,
        paymentDeeplinkUrl : data.deeplinkUrl,
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
    } )
    dispatch( { type : 'RESET' } )
    createCharge()
  }, [createCharge, setPayment] )

  // ── Render ─────────────────────────────────────────────────────

  // Still resolving store hydration — show a neutral loader so we never
  // flash 'idle' or stale UI before snapping to the real phase.
  if ( phase === 'loading' ) {
    return (
      <main className="flex items-center justify-center h-screen bg-neutral-100">
        <Loader2 className="size-10 animate-spin text-muted-foreground" />
      </main>
    )
  }

  // Fresh settlement: show countdown, then promote to 'paid' & persist.
  if ( phase === 'settled' ) {
    return (
      <main className="flex items-center justify-center h-screen bg-neutral-100">
        <div className="flex flex-col items-center gap-6 px-4 animate-in fade-in duration-500">
          <CheckCircle2 className="size-16 text-emerald-500" />
          <div className="text-center">
            <h3 className="text-xl font-bold text-emerald-600">Payment Successful!</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Get ready for your photo session!
            </p>
            <p className="text-3xl font-bold text-emerald-600 mt-4 tabular-nums">
              {countdown}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Starting in {countdown} second{countdown !== 1 ? 's' : ''}&hellip;
            </p>
          </div>
        </div>
      </main>
    )
  }

  // Revisit after payment: store already says 'paid', redirect instantly.
  if ( phase === 'paid' ) {
    return (
      <main className="flex items-center justify-center h-screen bg-neutral-100">
        <Loader2 className="size-10 animate-spin text-muted-foreground" />
      </main>
    )
  }

  if ( phase === 'creating' ) {
    return (
      <main className="flex items-center justify-center h-screen bg-neutral-100">
        <div className="flex flex-col items-center gap-6 px-4">
          <Loader2 className="size-12 animate-spin text-muted-foreground" />
          <p className="text-lg font-medium text-muted-foreground">
            Creating payment&hellip;
          </p>
        </div>
      </main>
    )
  }

  if ( phase === 'pending' && charge ) {
    return (
      <main className="flex items-center justify-center min-h-screen bg-neutral-100">
        <div className="container px-4 py-8 mx-auto">
          <div className="mb-8 space-y-3 text-center">
            <h2 className="text-3xl font-bold tracking-tight lg:text-4xl text-foreground">
              Scan to Start
            </h2>
            <p className="max-w-md mx-auto text-sm text-muted-foreground lg:text-base font-jakarta">
              Pay with QRIS via GoPay or any e-wallet to begin your photo session.
            </p>
          </div>

          <div className="flex flex-col items-center gap-6 font-jakarta">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={charge.qrCodeUrl}
              alt="QRIS payment QR code"
              className="w-64 h-64 border rounded-xl shadow-md"
            />
            <p className="text-sm text-muted-foreground text-center max-w-xs">
              Scan with your e-wallet app to pay{' '}
              <strong>Rp 15.000</strong>
            </p>
            {charge.deeplinkUrl && (
              <a
                href={charge.deeplinkUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-full hover:bg-blue-100 transition-colors"
              >
                <ExternalLink className="size-4" />
                Open GoPay
              </a>
            )}
            <p className="text-xs text-muted-foreground/60">
              Waiting for payment&hellip;
            </p>
          </div>

          {charge.boothName && (
            <p className="mt-8 text-xs text-center text-muted-foreground/40">
              {charge.boothName}
            </p>
          )}
        </div>
      </main>
    )
  }

  if ( phase === 'error' ) {
    return (
      <main className="flex items-center justify-center h-screen bg-neutral-100">
        <div className="flex flex-col items-center gap-6 px-4">
          <AlertCircle className="size-12 text-red-500" />
          <div className="text-center">
            <h3 className="text-lg font-bold text-red-600">Payment Error</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-xs">
              {errorMsg || 'Something went wrong. Please try again.'}
            </p>
          </div>
          <Button
            size="lg"
            variant="outline"
            onClick={handleRetry}
          >
            Try Again
          </Button>
        </div>
      </main>
    )
  }

  if ( phase === 'expired' ) {
    return (
      <main className="flex items-center justify-center h-screen bg-neutral-100">
        <div className="flex flex-col items-center gap-6 px-4">
          <AlertCircle className="size-12 text-amber-500" />
          <div className="text-center">
            <h3 className="text-lg font-bold text-amber-600">Payment Expired</h3>
            <p className="text-sm text-muted-foreground mt-1">
              The payment window has closed. Please try again.
            </p>
          </div>
          <Button
            size="lg"
            variant="outline"
            onClick={handleRetry}
          >
            Create New Payment
          </Button>
        </div>
      </main>
    )
  }

  // Fallback
  return (
    <main className="flex items-center justify-center h-screen bg-neutral-100">
      <div className="flex flex-col items-center gap-6 px-4">
        <X className="size-16 text-red-500" />
        <div className="text-center">
          <h3 className="text-xl font-bold text-red-600">No Payment Detected</h3>
          <p className="text-sm text-muted-foreground mt-1 font-jakarta">
            Please complete the payment to continue.
          </p>
        </div>
        <Button
          size="lg"
          variant="outline"
          onClick={handleRetry}
        >
          Try Again
        </Button>
      </div>
    </main>
  )
}
