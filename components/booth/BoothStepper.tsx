'use client'
import { cn } from '@/lib/utils'
import { useBoothStore } from '../../store/boothStore'

const STEPS = ['Select Frame', 'Capture', 'Filter', 'Your Strip'] as const

export function BoothStepper( ) {
  const { step } =
      useBoothStore()
  
  return (
    <div className="flex w-full items-start py-4">
      {STEPS.map( ( label, i ) => (
        <div
          key={i}
          className={cn( 'flex items-start', i < STEPS.length - 1 && 'flex-1' )}
        >
          <div className="flex shrink-0 flex-col items-center gap-1">
            <div
              className={cn(
                'flex size-8 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors',
                i < step
                  ? 'border-primary bg-primary text-primary-foreground'
                  : i === step
                    ? 'border-primary bg-background text-primary'
                    : 'border-border bg-background text-muted-foreground',
              )}
            >
              {i < step ? '✓' : i + 1}
            </div>
            <span
              className={cn(
                'text-xs font-medium',
                i === step ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
          </div>

          {i < STEPS.length - 1 && (
            <div
              className={cn(
                'mx-3 mt-4 h-px flex-1 transition-colors',
                i < step ? 'bg-primary' : 'bg-border',
              )}
            />
          )}
        </div>
      ) )}
    </div>
  )
}
