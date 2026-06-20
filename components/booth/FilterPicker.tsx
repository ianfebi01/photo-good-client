import { useCallback, useEffect, useRef, useState } from 'react'
import type { Shot } from '@/store/boothStore'
import { cn } from '@/lib/utils'
import { filtersList, getCSSFilter } from './filters'

interface FilterPickerProps {
  photos: Shot[]
  pending: Shot | null
  activePhoto: Shot | null
  globalFilter: string
  onFilterChange: ( filter: string ) => void
}

export function FilterPicker( {
  photos,
  pending,
  activePhoto,
  globalFilter,
  onFilterChange,
}: FilterPickerProps ) {
  const previewUrl = activePhoto?.url ?? photos[0]?.url ?? pending?.url
  const hasPhoto = photos.length > 0 || !!pending
  const scrollRef = useRef<HTMLDivElement>( null )
  const [ canScrollRight, setCanScrollRight ] = useState( false )

  const checkScroll = useCallback( () => {
    const el = scrollRef.current
    if ( !el ) return
    setCanScrollRight( el.scrollLeft + el.clientWidth < el.scrollWidth - 1 )
  }, [] )

  useEffect( () => {
    checkScroll()
    const el = scrollRef.current
    if ( !el ) return
    const observer = new ResizeObserver( checkScroll )
    observer.observe( el )
    el.addEventListener( 'scroll', checkScroll, { passive : true } )
    
    return () => {
      observer.disconnect()
      el.removeEventListener( 'scroll', checkScroll )
    }
  }, [ checkScroll, photos ] )

  const scrollRight = () => {
    const el = scrollRef.current
    if ( !el ) return
    el.scrollBy( { left : el.clientWidth * 0.7, behavior : 'smooth' } )
  }

  return (
    <div className="flex flex-row items-center gap-6 w-full h-full">
      <div className="flex flex-col gap-1.5 flex-2 justify-center h-full overflow-hidden relative">
        <div
          ref={scrollRef}
          className="flex flex-row gap-2 overflow-auto scrollbar-none h-full xl:items-center pb-5 relative"
        >
          {filtersList.map( ( f ) => (
            <button
              key={f.name}
              type="button"
              onClick={() => onFilterChange( f.name )}
              className={cn(
                'flex flex-col gap-1 text-center transition cursor-pointer select-none h-full w-fit! relative',
                globalFilter === f.name ? 'bg-primary/2 text-black' : 'text-neutral-500',
              )}
            >
              {hasPhoto ? (
                <div className="aspect-3/2 h-full overflow-hidden rounded-xs xl:rounded-xl bg-accent relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewUrl}
                    alt={f.label}
                    className="absolute inset-0 h-full w-full object-cover"
                    style={{ filter : getCSSFilter( f.name ) }}
                  />
                </div>
              ) : (
                <div className="aspect-3/2 h-full overflow-hidden rounded-md bg-accent relative flex items-center justify-center text-white">
                  {f.label}
                </div>
              )}
              <span className="text-[9px] xl:text-xs font-bold truncate w-full absolute bottom-0 inset-x-0 -mb-4 xl:-mb-6">
                {f.label}
              </span>
            </button>
          ) )}
        </div>

        {canScrollRight && (
          <button
            type="button"
            onClick={scrollRight}
            className="absolute right-0 top-1/2 -translate-y-1/2 z-10 flex items-center justify-center w-8 h-8 rounded-full bg-white/80 shadow-md hover:bg-white transition"
            aria-label="Scroll right"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-4 h-4"
            >
              <path
                fillRule="evenodd"
                d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
