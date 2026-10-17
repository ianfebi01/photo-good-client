'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useShallow } from 'zustand/react/shallow'

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
} from '@/components/payment'

export type { PaymentChargeState } from '@/types/payment'

const SETTLED_COUNTDOWN = 5

const CLEARED_PAYMENT = {
  paymentStatus      : 'idle',
  paymentOrderId     : null,
  paymentQrCodeUrl   : null,
  paymentDeeplinkUrl : null,
  paymentGrossAmount : null,
  paymentGateway     : null,
  paymentType        : null,
  paymentExpiryTime  : null,
} as const

/**
 * The charge lives in the booth store, so this component only keeps what is
 * local to the screen: a create error, the booth name from the charge
 * response, and the post-settlement countdown. Everything else is derived.
 */
export function PaymentClient() {
  const router = useRouter()
  const settingsQuery = useBoothSettings()
  const payment = useBoothStore( useShallow( ( s ) => ( {
    status      : s.paymentStatus,
    orderId     : s.paymentOrderId,
    qrCodeUrl   : s.paymentQrCodeUrl,
    deeplinkUrl : s.paymentDeeplinkUrl,
    grossAmount : s.paymentGrossAmount,
    gateway     : s.paymentGateway,
    type        : s.paymentType,
    expiryTime  : s.paymentExpiryTime,
  } ) ) )
  const setPayment = useBoothStore( ( s ) => s.setPayment )

  const [createError, setCreateError] = useState<string | null>( null )
  const [boothName, setBoothName] = useState( '' )
  const [countdown, setCountdown] = useState( SETTLED_COUNTDOWN )
  const creatingRef = useRef( false )

  const paymentDisabled = settingsQuery.data?.paymentEnabled === false
  const hasCharge = Boolean( payment.orderId && payment.qrCodeUrl )
  const failed = payment.status === 'expired' || payment.status === 'error' || createError !== null
  const needsCharge = !settingsQuery.isPending && !paymentDisabled
    && payment.status !== 'paid' && !hasCharge && !failed

  const pollResult = usePaymentPolling( hasCharge && !failed ? payment.orderId : null )
  const settled = pollResult.status === 'settlement'

  // ── Leave when payment is off for this booth or already done ───
  useEffect( () => {
    if ( paymentDisabled || payment.status === 'paid' ) router.replace( '/booth' )
  }, [paymentDisabled, payment.status, router] )

  // ── Create a charge whenever there isn't one ───────────────────
  useEffect( () => {
    if ( !needsCharge || creatingRef.current ) return
    creatingRef.current = true

    const sessionId = useBoothStore.getState().sessionId || Math.random().toString( 36 ).slice( 2, 10 )

    createPaymentCharge( sessionId )
      .then( ( data ) => {
        setBoothName( data.booth?.name ?? '' )
        useBoothStore.setState( { sessionId } )
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
      } )
      .catch( ( err ) => setCreateError( err instanceof Error ? err.message : 'Unknown error' ) )
      .finally( () => {
        creatingRef.current = false
      } )
  }, [needsCharge, setPayment] )

  // ── Persist a failed charge so retry starts fresh ──────────────
  useEffect( () => {
    if ( pollResult.status !== 'terminal' ) return
    setPayment( { paymentStatus : pollResult.reason === 'expire' ? 'expired' : 'error' } )
  }, [pollResult, setPayment] )

  // ── Count down after settlement, then mark paid ────────────────
  useEffect( () => {
    if ( !settled ) return
    const id = setInterval( () => setCountdown( ( c ) => Math.max( 0, c - 1 ) ), 1000 )

    return () => clearInterval( id )
  }, [settled] )

  useEffect( () => {
    if ( countdown === 0 ) setPayment( { paymentStatus : 'paid' } )
  }, [countdown, setPayment] )

  const handleRetry = () => {
    setCreateError( null )
    setPayment( CLEARED_PAYMENT )
  }

  // ── Render ─────────────────────────────────────────────────────
  if ( settingsQuery.isPending || paymentDisabled || payment.status === 'paid' ) {
    return <PhaseLoading />
  }

  if ( settled ) return <PhaseSettled countdown={countdown} />

  if ( payment.status === 'expired' ) return <PhaseExpired onRetry={handleRetry} />

  if ( failed ) {
    return (
      <PhaseError
        errorMsg={createError ?? 'Payment failed'}
        onRetry={handleRetry}
      />
    )
  }

  if ( !hasCharge ) return <PhaseCreating />

  const charge: PaymentChargeState = {
    orderId           : payment.orderId!,
    transactionId     : null,
    transactionStatus : 'pending',
    qrCodeUrl         : payment.qrCodeUrl,
    deeplinkUrl       : payment.deeplinkUrl,
    grossAmount       : payment.grossAmount ?? 15000,
    paymentType       : payment.type ?? 'qris',
    gateway           : payment.gateway ?? 'doku',
    expiryTime        : payment.expiryTime,
    boothName,
  }

  return <PhasePending charge={charge} />
}
