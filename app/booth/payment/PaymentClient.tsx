'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, AlertCircle, CheckCircle2, ExternalLink, X, Camera } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useBoothStore } from '@/store/boothStore'

// ── Types ──────────────────────────────────────────────────────────

type Phase = 'loading' | 'idle' | 'creating' | 'pending' | 'settled' | 'paid' | 'expired' | 'error'

type Charge = {
  orderId: string
  qrCodeUrl: string
  deeplinkUrl: string | null
  boothName: string
}

type PollResult =
  | { status: 'settlement' }
  | { status: 'terminal'; reason: string }
  | { status: 'polling' }

const POLL_INTERVAL = 3_000
const POLL_TIMEOUT = 300_000

// ── Hook: polling ─────────────────────────────────────────────────

function usePaymentPolling( orderId: string | null ): PollResult {
  const [result, setResult] = useState<PollResult>( { status : 'polling' } )

  useEffect( () => {
    if ( !orderId ) return

    // Reset to 'polling' so stale results from a previous charge
    // don't leak into a new one.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResult( { status : 'polling' } )

    let alive = true
    let interval: ReturnType<typeof setInterval> | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/booth/payment/status?orderId=${orderId}`,
          { headers : { 'x-booth-key' : process.env.NEXT_PUBLIC_BOOTH_API_KEY || '' } },
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

// ── Helpers ────────────────────────────────────────────────────────

/** Determine the resolved phase from the persisted store state. */
function resolveInitialPhase(): { phase: Phase; charge: Charge | null } {
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

  // Start in 'loading' — we don't trust synchronous store reads on first
  // paint because persisted (e.g. Zustand `persist`) state may not have
  // rehydrated from localStorage yet. Resolving in an effect (below)
  // guarantees we only render the real phase once hydration is done,
  // which removes the idle/pending flash on reload.
  const [phase, setPhase] = useState<Phase>( 'loading' )
  const [charge, setCharge] = useState<Charge | null>( null )
  const [errorMsg, setErrorMsg] = useState<string | null>( null )
  const [countdown, setCountdown] = useState( 5 )

  // ── Resolve real phase once, after mount/hydration ────────────────
  useEffect( () => {
    const resolved = resolveInitialPhase()
    if ( resolved.charge ) setCharge( resolved.charge )
    setPhase( resolved.phase )
     
  }, [] )

  // ── Create charge ────────────────────────────────────────────────
  const creatingRef = useRef( false )

  const createCharge = useCallback( async () => {
    if ( creatingRef.current ) return
    creatingRef.current = true

    setPhase( 'creating' )
    setErrorMsg( null )
    const paySessionId = sessionId || Math.random().toString( 36 ).slice( 2, 10 )

    try {
      const res = await fetch( '/api/booth/payment/charge', {
        method  : 'POST',
        headers : {
          'Content-Type' : 'application/json',
          'x-booth-key'  : process.env.NEXT_PUBLIC_BOOTH_API_KEY || '',
        },
        body : JSON.stringify( { sessionId : paySessionId } ),
      } )
      const data = await res.json()

      if ( !res.ok ) throw new Error( data.error || 'Failed to create payment' )

      useBoothStore.setState( { sessionId : paySessionId } )

      setCharge( {
        orderId     : data.orderId,
        qrCodeUrl   : data.qrCodeUrl,
        deeplinkUrl : data.deeplinkUrl ?? null,
        boothName   : data.booth?.name || '',
      } )
      setPhase( 'pending' )
      setPayment( {
        paymentStatus      : 'pending',
        paymentOrderId     : data.orderId,
        paymentQrCodeUrl   : data.qrCodeUrl,
        paymentDeeplinkUrl : data.deeplinkUrl,
      } )
    } catch ( err ) {
      setPhase( 'error' )
      setErrorMsg( err instanceof Error ? err.message : 'Unknown error' )
    } finally {
      creatingRef.current = false
    }
  }, [sessionId, setPayment] )

  // ── Poll while pending ───────────────────────────────────────────
  const pollResult = usePaymentPolling( phase === 'pending' ? charge?.orderId ?? null : null )

  // ── React to poll result ─────────────────────────────────────────
  const prevPollStatusRef = useRef<string>( pollResult.status )
  const prevPollReasonRef = useRef<string | undefined>(
    pollResult.status === 'terminal' ? pollResult.reason : undefined,
  )
  useEffect( () => {
    const currentReason = pollResult.status === 'terminal' ? pollResult.reason : undefined
    if (
      pollResult.status === prevPollStatusRef.current &&
      currentReason === prevPollReasonRef.current
    ) {
      return
    }
    prevPollStatusRef.current = pollResult.status
    prevPollReasonRef.current = currentReason

    if ( pollResult.status === 'settlement' ) {
      // Transition to 'settled' first — countdown runs here.
      // We only promote to 'paid' (and persist) after the countdown
      // finishes, so that revisiting the page sees 'paid' and
      // redirects instantly with no countdown.
      setPhase( 'settled' )
    } else if ( pollResult.status === 'terminal' ) {
      setPhase( pollResult.reason === 'expire' ? 'expired' : 'error' )
      setErrorMsg( `Payment ${pollResult.reason}` )
      setPayment( { paymentStatus : pollResult.reason as 'expired' | 'error' } )
    }
  }, [pollResult, setPayment] )

  // ── Redirect immediately if re-entering after payment ─────────────
  useEffect( () => {
    if ( phase === 'paid' ) {
      router.replace( '/booth' )
    }
  }, [phase, router] )

  // ── Countdown after settlement, then promote to paid & navigate ──
  useEffect( () => {
    if ( phase !== 'settled' ) return
    setCountdown( 5 )

    const id = setInterval( () => {
      setCountdown( ( prev ) => Math.max( 0, prev - 1 ) )
    }, 1000 )

    return () => clearInterval( id )
  }, [phase] )

  useEffect( () => {
    if ( phase === 'settled' && countdown === 0 ) {
      setPhase( 'paid' )
      setPayment( { paymentStatus : 'paid' } )
      router.push( '/booth' )
    }
  }, [phase, countdown, router, setPayment] )

  // ── Handlers ─────────────────────────────────────────────────────
  const handleStartPayment = useCallback( () => {
    createCharge()
  }, [createCharge] )

  const handleRetry = useCallback( () => {
    useBoothStore.setState( {
      paymentStatus      : 'idle',
      paymentOrderId     : null,
      paymentQrCodeUrl   : null,
      paymentDeeplinkUrl : null,
    } )

    setCharge( null )
    setErrorMsg( null )
    createCharge()
  }, [createCharge] )

  // ── Render ───────────────────────────────────────────────────────

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

  if ( phase === 'idle' ) {
    return (
      <main className="flex items-center justify-center h-screen bg-neutral-100">
        <div className="flex flex-col items-center gap-8 px-4">
          <div className="flex flex-col items-center gap-4">
            <div className="flex items-center justify-center size-20 rounded-full bg-primary/10">
              <Camera className="size-10 text-primary" />
            </div>
            <div className="text-center">
              <h2 className="text-3xl font-bold tracking-tight lg:text-4xl text-foreground">
                Photo Booth
              </h2>
              <p className="max-w-md mx-auto mt-2 text-sm text-muted-foreground lg:text-base">
                Tap below to start your photo session!
              </p>
            </div>
          </div>
          <Button
            size="lg"
            onClick={handleStartPayment}
          >
            Start Session
          </Button>
        </div>
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
            <p className="max-w-md mx-auto text-sm text-muted-foreground lg:text-base">
              Pay with QRIS via GoPay or any e-wallet to begin your photo session.
            </p>
          </div>

          <div className="flex flex-col items-center gap-6">
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
          <p className="text-sm text-muted-foreground mt-1">
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
