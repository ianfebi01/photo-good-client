import { Button } from '@/components/ui/button'
import { type ClientFrame } from '@/lib/photobooth/frames.client'
import { useBoothStore } from '@/store/boothStore'
import { ChevronRight } from 'lucide-react'
import { QRModal } from './QRModal'
import { cn } from '@/lib/utils'

export function StepSelectFrame() {
  const {
    frames,
    frameKey,
    selectFrame,
    start,
  } = useBoothStore()

  const frame = frames.find( ( f ) => f.key === frameKey ) ?? frames[0]

  return (
    <div className="container mx-auto px-4 py-8 lg:py-16 flex flex-col gap-6 grow overflow-hidden">
      {/* Header */}
      <div className="flex justify-between items-center gap-4">
        <div className="flex flex-col">
          <span className="text-sm font-bold text-neutral-800 font-sans">
            Select Frame Template
          </span>
          <span className="text-xs text-neutral-400 font-jakarta">
            Choose a 4×6 frame to start your session
          </span>
        </div>
        <div className="flex items-center gap-2">
          <QRModal />
          <Button
            size="lg"
            onClick={start}
            disabled={!frame}
          >
            Start session <ChevronRight/>
          </Button>
        </div>
      </div>

      {/* 2-column layout: preview + grid */}
      {frames.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="mx-auto size-16 rounded-2xl bg-neutral-100 flex items-center justify-center">
              <svg
                className="size-8 text-neutral-300"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z"
                />
              </svg>
            </div>
            <h3 className="text-sm font-bold text-neutral-900">No frames available</h3>
            <p className="text-xs text-neutral-400 max-w-xs">
              Upload your first 4×6 frame template to get started.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col lg:grid lg:grid-cols-[1fr_1.5fr] gap-6 grow min-h-0 overflow-hidden font-jakarta">
          {/* Left: Selected frame preview */}
          <div className="flex flex-col items-center justify-center min-h-0 lg:h-full">
            {frame ? (
              <div className="relative h-full w-full flex items-center justify-center overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/frames/preview?key=${frame.key}`}
                  alt={frame.label}
                  className="max-h-full max-w-full object-contain drop-shadow-xl rounded-sm transition-all duration-300"
                />
                <div className="absolute bottom-4 inset-x-0 flex flex-col items-center gap-0.5">
                  <span className="text-sm font-bold text-neutral-800 font-sans bg-white/80 backdrop-blur-sm px-3 py-1 rounded-full">
                    {frame.label}
                  </span>
                  <span className="text-[10px] text-neutral-500 font-sans bg-white/60 backdrop-blur-sm px-2 py-0.5 rounded-full">
                    {frame.photoCount} slot{frame.photoCount !== 1 ? 's' : ''} · {frame.width} × {frame.height}px
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full w-full text-sm text-neutral-400">
                Select a frame
              </div>
            )}
          </div>

          {/* Right: Frame grid */}
          <div className="flex flex-col gap-3 min-h-0 overflow-hidden font-jakarta">
            <span className="text-xs font-bold text-neutral-500 uppercase tracking-wider shrink-0">
              Available frames ({frames.length})
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-3 overflow-y-auto scrollbar-thin scrollbar-thumb-neutral-200 pb-2">
              {frames.map( ( f ) => (
                <FrameCard
                  key={f.key}
                  frame={f}
                  active={f.key === frameKey}
                  onClick={() => selectFrame( f.key )}
                />
              ) )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function FrameCard( {
  frame,
  active,
  onClick,
}: {
  frame: ClientFrame
  active: boolean
  onClick: () => void
} ) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex flex-col items-center gap-2 rounded-xl p-3 transition-all duration-200 cursor-pointer text-left',
        active
          ? 'border border-primary shadow-sm'
          : 'bg-white hover:bg-neutral-50 border border-neutral-100 hover:border-neutral-200 hover:shadow-sm',
      )}
    >
      <div className="aspect-2/3 w-full overflow-hidden rounded-lg bg-neutral-50 flex items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/frames/preview?key=${frame.key}`}
          alt={frame.label}
          className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-105"
          loading="lazy"
        />
      </div>
      <div className="flex flex-col items-center gap-0.5 w-full">
        <span
          className={cn(
            'text-xs font-bold truncate w-full text-center',
            active ? 'text-primary' : 'text-neutral-700',
          )}
        >
          {frame.label}
        </span>
        <span className="text-[10px] text-neutral-400">
          {frame.photoCount} slot{frame.photoCount !== 1 ? 's' : ''}
        </span>
      </div>
      {active && (
        <div className="absolute top-1.5 right-1.5 size-5 rounded-full bg-primary flex items-center justify-center">
          <svg
            className="size-3 text-white"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={3}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5 13l4 4L19 7"
            />
          </svg>
        </div>
      )}
    </button>
  )
}
