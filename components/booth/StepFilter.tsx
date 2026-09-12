'use client'

import { useState, useRef, useCallback, type CSSProperties } from 'react'
import { Button } from '@/components/ui/button'
import { useBoothStore } from '@/store/boothStore'
import { FilterPicker } from './FilterPicker'
import { FramePreview } from './FramePreview'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export function StepFilter() {
  const {
    frameKey,
    photos,
    frames,
    composeStripWithAdjustments,
    phase,
    globalFilter,
    setGlobalFilter,
  } = useBoothStore()

  const frame = frames.find( ( f ) => f.key === frameKey ) ?? frames[0]
  const photoCount = frame?.photoCount ?? 0
  const busy = phase === 'composing'

  const [cacheBuster] = useState( () => String( Date.now() ) )

  const [adjustments] = useState<
    { x: number; y: number; zoom: number; filter: string }[]
  >( () =>
    Array.from( { length : 10 } ).map( () => ( {
      x      : 0,
      y      : 0,
      zoom   : 1.0,
      filter : 'none',
    } ) ),
  )

  const frameContainerRef = useRef<HTMLDivElement>( null )

  const getScale = useCallback( () => {
    if ( !frameContainerRef.current ) return 1
    const el = frameContainerRef.current

    return Math.min(
      el.clientHeight / frame.height,
      ( el.parentElement?.clientWidth ?? el.clientWidth ) / frame.width,
    )
  }, [frame] )

  const handleCompose = () => {
    const scale = getScale()
    const finalAdjustments = adjustments.slice( 0, photoCount ).map( ( adj ) => ( {
      ...adj,
      filter : globalFilter,
      x      : adj.x / scale,
      y      : adj.y / scale,
    } ) )
    composeStripWithAdjustments( finalAdjustments )
  }

  const goBack = () => {
    useBoothStore.getState().start() // go back to step 1 (capture)
  }

  const pending = null
  const activeSlotIdx = null
  const reviewing = false

  const isSlotInteractive = useCallback( () => false, [] )
  const noop = useCallback( () => {}, [] )
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const noopMouse = useCallback( ( _e: React.MouseEvent, _i: number ) => {}, [] )
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const noopTouch = useCallback( ( _e: React.TouchEvent, _i: number ) => {}, [] )

  if ( !frame ) return null

  return (
    <div className="container flex flex-col gap-6 px-4 py-8 mx-auto overflow-hidden lg:py-16 grow">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={goBack}
            disabled={busy}
            className="gap-1"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <div className="flex flex-col">
            <span className="font-sans text-sm font-bold text-neutral-800">
              Apply Filter
            </span>
            <span className="font-sans text-xs text-neutral-400 font-jakarta">
              Choose a filter style for your photos
            </span>
          </div>
        </div>
        <Button
          size="lg"
          onClick={handleCompose}
          disabled={busy}
        >
          {busy ? 'Composing...' : 'Finish'} <ChevronRight />
        </Button>
      </div>

      {/* 2-column: preview + filters */}
      <div className="flex flex-col lg:grid lg:grid-cols-[1fr_1.2fr] gap-6 grow min-h-0 overflow-hidden">
        {/* Left: Frame preview with filter */}
        <div className="flex items-center justify-center w-full h-full min-h-0 overflow-hidden">
          <FramePreview
            className="flex flex-col w-full h-full"
            style={
              {
                '--frame-ar' : `${frame.width} / ${frame.height}`,
              } as CSSProperties
            }
            frame={frame}
            photos={photos}
            pending={pending}
            adjustments={adjustments}
            activeSlotIdx={activeSlotIdx}
            reviewing={reviewing}
            globalFilter={globalFilter}
            cacheBuster={cacheBuster}
            isSlotInteractive={isSlotInteractive}
            onSlotClick={noop}
            onMouseDown={noopMouse}
            onTouchStart={noopTouch}
            containerRef={frameContainerRef}
          />
        </div>

        {/* Right: Filter picker */}
        <div className="flex flex-col h-full min-h-0 gap-4 overflow-hidden max-h-50 xl:max-h-75 xl:my-auto">
          <div className="flex flex-col gap-4 p-6 overflow-hidden bg-white rounded-3xl grow">
            <div className="space-y-1">
              <p className="text-xs font-bold tracking-widest uppercase text-primary">
                Choose your style
              </p>
              <h2 className="text-2xl font-bold text-foreground">
                Filters
              </h2>
            </div>
            <div className="overflow-hidden grow">
              <FilterPicker
                photos={photos}
                pending={pending}
                activePhoto={photos[0] ?? null}
                globalFilter={globalFilter}
                onFilterChange={setGlobalFilter}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
