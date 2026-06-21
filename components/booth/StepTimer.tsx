'use client'

import { useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useBoothStore, STEP_TIMEOUTS, TIMEOUT_WARNING_SECONDS } from '@/store/boothStore'
import { cn } from '@/lib/utils'

/**
 * Idle timer for the photobooth kiosk mode.
 * Resets to the configured timeout for the current step whenever the user
 * interacts (click, touch, keydown). When time runs out, auto-resets to step 0.
 * Shows a warning overlay 5 seconds before auto-reset.
 */
export function StepTimer() {
  const {
    step,
    timerEnabled,
    timerSecondsLeft,
    setTimerSecondsLeft,
    reset,
  } = useBoothStore()

  const router = useRouter()
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>( null )

  const resetTimer = useCallback( () => {
    const timeout = STEP_TIMEOUTS[step] ?? 30
    setTimerSecondsLeft( timeout )
  }, [step, setTimerSecondsLeft] )

  // Start / restart timer when step changes
  useEffect( () => {
    if ( !timerEnabled ) return
    resetTimer()
  }, [step, timerEnabled, resetTimer] )

  // Tick the timer every second
  useEffect( () => {
    if ( !timerEnabled || timerSecondsLeft === null ) return

    intervalRef.current = setInterval( () => {
      const current = useBoothStore.getState().timerSecondsLeft
      if ( current === null ) return

      if ( current <= 1 ) {
        // Time's up — auto-reset and go to payment
        reset()
        router.replace( '/booth/payment' )
      } else {
        setTimerSecondsLeft( current - 1 )
      }
    }, 1000 )

    return () => {
      if ( intervalRef.current ) clearInterval( intervalRef.current )
    }
  }, [timerEnabled, timerSecondsLeft, setTimerSecondsLeft, reset, router] )

  // Reset timer on user interaction
  useEffect( () => {
    if ( !timerEnabled ) return

    const onInteraction = () => resetTimer()

    window.addEventListener( 'click', onInteraction )
    window.addEventListener( 'touchstart', onInteraction )
    window.addEventListener( 'keydown', onInteraction )
    window.addEventListener( 'mousemove', onInteraction )

    return () => {
      window.removeEventListener( 'click', onInteraction )
      window.removeEventListener( 'touchstart', onInteraction )
      window.removeEventListener( 'keydown', onInteraction )
      window.removeEventListener( 'mousemove', onInteraction )
    }
  }, [timerEnabled, resetTimer] )

  if ( !timerEnabled || timerSecondsLeft === null ) return null

  const totalTime = STEP_TIMEOUTS[step] ?? 30
  const progress = timerSecondsLeft / totalTime
  const showWarning = timerSecondsLeft <= TIMEOUT_WARNING_SECONDS
  const circumference = 2 * Math.PI * 14 // radius = 14

  return (
    <>
      {/* Timer indicator — compact circle in the header area */}
      <div
        className={cn(
          'relative flex items-center gap-2 shrink-0 transition-opacity duration-300',
          timerSecondsLeft > TIMEOUT_WARNING_SECONDS + 10 ? 'opacity-30' : 'opacity-100',
        )}
      >
        <svg
          className="size-8 -rotate-90"
          viewBox="0 0 32 32"
        >
          <circle
            cx="16"
            cy="16"
            r="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-neutral-200"
          />
          <circle
            cx="16"
            cy="16"
            r="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            className={cn(
              'transition-all duration-1000 ease-linear',
              showWarning ? 'text-red-500' : 'text-primary',
            )}
            strokeDasharray={circumference}
            strokeDashoffset={circumference * ( 1 - progress )}
          />
        </svg>
        <span
          className={cn(
            'text-xs font-bold tabular-nums font-sans',
            showWarning ? 'text-red-500' : 'text-neutral-500',
          )}
        >
          {timerSecondsLeft}s
        </span>
      </div>

      {/* Warning overlay */}
      {showWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200 pointer-events-none">
          <div className="flex flex-col items-center gap-4 bg-white rounded-3xl px-10 py-8 shadow-2xl pointer-events-auto animate-in zoom-in-95 duration-300">
            <div className="relative size-20 flex items-center justify-center">
              <svg
                className="size-20 -rotate-90"
                viewBox="0 0 80 80"
              >
                <circle
                  cx="40"
                  cy="40"
                  r="36"
                  fill="none"
                  stroke="#fee2e2"
                  strokeWidth="4"
                />
                <circle
                  cx="40"
                  cy="40"
                  r="36"
                  fill="none"
                  stroke="#ef4444"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 36}
                  strokeDashoffset={2 * Math.PI * 36 * ( 1 - timerSecondsLeft / TIMEOUT_WARNING_SECONDS )}
                  className="transition-all duration-1000 ease-linear"
                />
              </svg>
              <span className="absolute text-2xl font-black text-red-500 tabular-nums">
                {timerSecondsLeft}
              </span>
            </div>
            <div className="text-center">
              <h3 className="text-lg font-bold text-neutral-900">Are you still there?</h3>
              <p className="text-sm text-neutral-500 mt-1">
                Session will reset in {timerSecondsLeft} second{timerSecondsLeft !== 1 ? 's' : ''}
              </p>
            </div>
            <p className="text-xs text-neutral-400">
              Touch anywhere to continue
            </p>
          </div>
        </div>
      )}
    </>
  )
}
