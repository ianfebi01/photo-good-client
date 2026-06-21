'use client'

import { useRef, useCallback } from 'react'
import { QrCode, X } from 'lucide-react'
import gsap from 'gsap'
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogClose,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { BoothQR } from './BoothQR'

export function QRModal() {
  const popupRef = useRef<HTMLDivElement>( null )
  const overlayRef = useRef<HTMLDivElement>( null )
  const actionsRef = useRef<{ unmount: () => void; close: () => void } | null>( null )
  const isAnimatingRef = useRef( false )

  const handlePopupRef = useCallback( ( node: HTMLDivElement | null ) => {
    popupRef.current = node
    if ( !node ) return

    gsap.set( node, { scale : 0.9, opacity : 0 } )
    if ( overlayRef.current ) gsap.set( overlayRef.current, { opacity : 0 } )

    const tl = gsap.timeline()
    if ( overlayRef.current ) {
      tl.to( overlayRef.current, { opacity : 1, duration : 0.2, ease : 'power2.out' }, 0 )
    }
    tl.to( node, { scale : 1, opacity : 1, duration : 0.35, ease : 'back.out(1.7)' }, 0 )
  }, [] )

  const handleOpenChange = useCallback( ( nextOpen: boolean, event: { preventUnmountOnClose: () => void } ) => {
    if ( nextOpen ) return
    if ( isAnimatingRef.current ) return
    isAnimatingRef.current = true
    event.preventUnmountOnClose()

    const tl = gsap.timeline( {
      onComplete : () => {
        isAnimatingRef.current = false
        actionsRef.current?.unmount()
      },
    } )

    if ( popupRef.current ) {
      tl.to( popupRef.current, { scale : 0.9, opacity : 0, duration : 0.25, ease : 'power3.in' } )
    }
    if ( overlayRef.current ) {
      tl.to( overlayRef.current, { opacity : 0, duration : 0.15 }, '-=0.1' )
    }
  }, [] )

  return (
    <Dialog
      onOpenChange={handleOpenChange}
      actionsRef={actionsRef}
    >
      <DialogTrigger
        render={
          <Button variant="outline"
            size="sm"
            className="gap-1.5"
          >
            <QrCode className="size-4" />
            <span className="hidden sm:inline">Open on phone</span>
          </Button>
        }
      />
      <DialogContent
        ref={handlePopupRef}
        overlayRef={overlayRef}
        className="w-auto max-w-sm rounded-3xl bg-white p-6 shadow-2xl border border-neutral-100"
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-bold text-neutral-900 font-sans">Scan QR Code</h3>
          <DialogClose
            render={
              <button
                type="button"
                className="flex items-center justify-center p-1.5 rounded-lg border border-neutral-200 hover:bg-neutral-50 transition cursor-pointer text-neutral-500 hover:text-neutral-950 focus:outline-none"
              >
                <X className="size-3.5" />
              </button>
            }
          />
        </div>
        <BoothQR page="/booth" />
      </DialogContent>
    </Dialog>
  )
}
