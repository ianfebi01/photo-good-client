'use client'

import { useEffect, useCallback, useRef } from 'react'
import { useBoothStore, STEP_TIMEOUTS, TIMEOUT_WARNING_SECONDS } from '@/store/boothStore'
import { cn } from '@/lib/utils'

export interface StepTimerProps {
  /** Called when the step timer reaches zero. */
  onTimesUp?: () => void
  /** Changing this value resets the timer (e.g. per-slot capture counter). */
  resetKey?: string | number
}

/**
 * Idle timer for the photobooth kiosk mode.
 * Resets to the configured timeout for the current step whenever the user
 * interacts (click, touch, keydown). When time runs out, calls onTimesUp.
 * Shows a warning overlay 5 seconds before auto-reset.
 */
export function StepTimer( { onTimesUp, resetKey }: StepTimerProps = {} ) {
  const {
    step,
    timerEnabled,
    timerSecondsLeft,
    setTimerSecondsLeft,
  } = useBoothStore()

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>( null )

  const resetTimer = useCallback( () => {
    const timeout = STEP_TIMEOUTS[step] ?? 30
    setTimerSecondsLeft( timeout )
  }, [step, setTimerSecondsLeft] )

  // Start / restart timer when step changes or resetKey changes
  useEffect( () => {
    if ( !timerEnabled ) return
    resetTimer()
  }, [step, resetKey, timerEnabled, resetTimer] )

  // Tick the timer every second
  useEffect( () => {
    if ( !timerEnabled || timerSecondsLeft === null ) return

    intervalRef.current = setInterval( () => {
      const current = useBoothStore.getState().timerSecondsLeft
      if ( current === null ) return

      if ( current <= 1 ) {
        // Time's up — stop timer and call the provided callback
        setTimerSecondsLeft( null )
        onTimesUp?.()
      } else {
        setTimerSecondsLeft( current - 1 )
      }
    }, 1000 )

    return () => {
      if ( intervalRef.current ) clearInterval( intervalRef.current )
    }
  }, [timerEnabled, timerSecondsLeft, setTimerSecondsLeft, onTimesUp] )

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
    </>
  )
}
