import { CheckIcon, RotateCcw } from 'lucide-react'

import { cn } from '@/lib/utils'

interface ShutterControlsProps {
  reviewing: boolean
  adjusting: boolean
  canCapture: boolean
  photosTaken: number
  photoCount: number
  countdown: number | null
  /** Booth setting — hide the "photo X of Y" counter above the shutter. */
  captureCounterEnabled: boolean
  onRetake: () => void
  onAccept: () => void
  onCompose: () => void
  onSnap: () => void
}

export function ShutterControls( {
  reviewing,
  adjusting,
  canCapture,
  photosTaken,
  photoCount,
  countdown,
  captureCounterEnabled,
  onRetake,
  onAccept,
  onCompose,
  onSnap,
}: ShutterControlsProps ) {
  return (
    <div className="relative xl:grow">
      <div className="pointer-events-none absolute -top-10 -right-10 h-20 w-20 rounded-full bg-primary/5 blur-xl" />

      {reviewing ? (
        <div
          key="reviewing"
          className="flex flex-col items-center justify-center h-full w-full relative z-10 gap-4 animate-in fade-in zoom-in-95 duration-300"
        >
          <span className="text-[10px] font-black text-primary uppercase tracking-wider font-sans invisible">
            Accept?
          </span>
          <div className="flex gap-2 relative">
            <button
              onClick={onAccept}
              className="group relative h-20 w-20 items-center justify-center cursor-pointer select-none rounded-full focus:outline-none flex"
              title="Accept"
            >
              <span className="absolute inset-0 rounded-full border-[3px] border-emerald-500" />
              <span className="absolute inset-1.5 rounded-full bg-emerald-500 transition-transform duration-150 group-hover:scale-105 group-active:scale-90" />
              <CheckIcon className="size-8 relative text-white" />
            </button>
            <button
              onClick={onRetake}
              className="p-2.5 aspect-square w-fit h-fit rounded-full bg-transparent group hover:bg-white text-neutral-500 cursor-pointer flex items-center justify-center transition focus:outline-none absolute left-full inset-y-0 my-auto ml-2"
              title="Retake"
            >
              <RotateCcw className="size-6 group-hover:-rotate-45 transition-all duration-200 ease-in-out" />
            </button>
          </div>
        </div>
      ) : adjusting ? (
        <div
          key="adjusting"
          className="flex flex-col items-center justify-center h-full w-full relative z-10 gap-4 animate-in fade-in zoom-in-95 duration-300 font-jakarta"
        >
          <span className="text-[10px] font-black text-emerald-500 uppercase tracking-wider font-sans">
            Complete!
          </span>
          {/* xl: compose here. Below xl composing is handled by the stepper's
              "Finish" button, so the shutter is just shown disabled. */}
          <button
            onClick={onCompose}
            className="group relative hidden h-20 w-20 items-center justify-center cursor-pointer select-none rounded-full focus:outline-none xl:flex"
            title="Compose"
          >
            <span className="absolute inset-0 rounded-full border-[3px] border-emerald-500" />
            <span className="absolute inset-1.5 rounded-full bg-emerald-500 transition-transform duration-150 group-hover:scale-105 group-active:scale-90" />
          </button>
          <button
            type="button"
            disabled
            className="relative flex h-20 w-20 items-center justify-center cursor-not-allowed select-none rounded-full opacity-50 focus:outline-none xl:hidden"
            title="Complete"
          >
            <span className="absolute inset-0 rounded-full border-[3px] border-emerald-500" />
            <span className="absolute inset-1.5 rounded-full bg-emerald-500" />
          </button>
        </div>
      ) : (
        <div
          key="capture"
          className="flex flex-col items-center justify-center h-full w-full relative z-10 gap-4 animate-in fade-in zoom-in-95 duration-300 font-jakarta"
        >
          <span
            className={cn(
              'text-[9px] font-bold text-neutral-400 uppercase tracking-widest',
              // Keep the slot so hiding the counter doesn't shift the shutter.
              !captureCounterEnabled && 'invisible',
            )}
          >
            {photosTaken}/{photoCount} Shots
          </span>

          {countdown !== null ? (
            <div className="relative flex h-20 w-20 items-center justify-center rounded-full">
              <span className="absolute inset-0 rounded-full border-[3px] border-primary animate-ping opacity-40" />
              <span className="absolute inset-0 rounded-full border-[3px] border-primary" />
              <span className="relative text-3xl font-black text-primary tabular-nums">
                {countdown}
              </span>
            </div>
          ) : (
            <button
              onClick={onSnap}
              disabled={!canCapture}
              className="group relative flex h-20 w-20 items-center justify-center cursor-pointer disabled:cursor-not-allowed select-none rounded-full focus:outline-none disabled:opacity-50"
              title="Snap"
            >
              <span className="absolute inset-0 rounded-full border-[3px] border-primary" />
              <span className="absolute inset-1.5 rounded-full bg-primary transition-transform duration-150 group-hover:scale-105 group-active:scale-90 group-disabled:scale-100" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
