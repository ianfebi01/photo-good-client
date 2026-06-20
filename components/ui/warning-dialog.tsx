'use client'

import { useRef, useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Trash2, Loader2, AlertCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog'
import gsap from 'gsap'

interface WarningDialogProps {
  title: string
  description: React.ReactNode
  confirmText?: string
  cancelText?: string
  onConfirm: () => Promise<void>
  trigger?: React.ReactElement
  isDestructive?: boolean
}

export function WarningDialog( {
  title,
  description,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  trigger,
  isDestructive = false,
}: WarningDialogProps ) {
  const [isConfirming, setIsConfirming] = useState( false )
  
  const popupRef = useRef<HTMLDivElement>( null )
  const contentRef = useRef<HTMLDivElement>( null )
  const overlayRef = useRef<HTMLDivElement>( null )
  const actionsRef = useRef<{ unmount: () => void; close: () => void } | null>( null )
  const tlRef = useRef<gsap.core.Timeline | null>( null )
  const isAnimatingRef = useRef( false )

  const handlePopupRef = useCallback( ( node: HTMLDivElement | null ) => {
    popupRef.current = node
    if ( !node ) return

    tlRef.current?.kill()

    const content = contentRef.current
    const overlay = overlayRef.current

    gsap.set( node, {
      scaleY          : 0,
      opacity         : 0,
      transformOrigin : 'center center',
    } )
    if ( overlay ) gsap.set( overlay, { opacity : 0 } )
    if ( content?.children ) {
      gsap.set( content.children, {
        x       : -30,
        opacity : 0,
      } )
    }

    const tl = gsap.timeline()

    if ( overlay ) {
      tl.to( overlay, {
        opacity  : 1,
        duration : 0.25,
        ease     : 'power2.out',
      }, 0 )
    }

    tl.to( node, {
      scaleY   : 1,
      opacity  : 1,
      duration : 0.4,
      ease     : 'power3.out',
    }, 0 )

    if ( content?.children ) {
      tl.to(
        content.children,
        {
          x        : 0,
          opacity  : 1,
          duration : 0.35,
          stagger  : 0.05,
          ease     : 'power2.out',
        },
        0.15
      )
    }

    tlRef.current = tl
  }, [] )

  const handleOpenChange = useCallback( ( nextOpen: boolean, event: { preventUnmountOnClose: () => void } ) => {
    if ( nextOpen ) {
      return
    }

    if ( isAnimatingRef.current ) return
    isAnimatingRef.current = true

    event.preventUnmountOnClose()
    tlRef.current?.kill()

    const tl = gsap.timeline( {
      onComplete : () => {
        isAnimatingRef.current = false
        actionsRef.current?.unmount()
      },
    } )

    if ( contentRef.current ) {
      tl.to( contentRef.current.children, {
        x        : -30,
        opacity  : 0,
        duration : 0.25,
        stagger  : 0.03,
        ease     : 'power2.in',
      } )
    }

    if ( popupRef.current ) {
      tl.to(
        popupRef.current,
        {
          scaleY   : 0,
          opacity  : 0,
          duration : 0.3,
          ease     : 'power3.in',
        },
        '-=0.1'
      )
    }

    if ( overlayRef.current ) {
      tl.to(
        overlayRef.current,
        {
          opacity  : 0,
          duration : 0.2,
        },
        '-=0.2'
      )
    }

    tlRef.current = tl
  }, [] )

  const handleConfirmAction = async () => {
    setIsConfirming( true )
    try {
      await onConfirm()
      actionsRef.current?.close()
    } catch ( err ) {
      alert( err instanceof Error ? err.message : 'Error confirming action' )
    } finally {
      setIsConfirming( false )
    }
  }

  return (
    <Dialog
      onOpenChange={handleOpenChange}
      actionsRef={actionsRef}
    >
      <DialogTrigger
        render={
          trigger || (
            <Button
              variant={isDestructive ? 'destructive' : 'default'}
              size="sm"
              className="w-full gap-1"
            >
              {confirmText}
            </Button>
          )
        }
      />

      <DialogContent
        ref={handlePopupRef}
        overlayRef={overlayRef}
        className="w-full max-w-sm rounded-3xl border border-neutral-100 bg-white p-0 shadow-2xl origin-center"
      >
        <div ref={contentRef}
          className="flex flex-col p-6 gap-6"
        >
          <DialogHeader className="space-y-4">
            <div className={`mx-auto flex size-12 items-center justify-center rounded-full ${isDestructive ? 'bg-destructive/10' : 'bg-primary/10'}`}>
              <AlertCircle className={`size-6 ${isDestructive ? 'text-destructive' : 'text-primary'}`} />
            </div>
            <div className="space-y-2 text-center">
              <DialogTitle className="text-xl font-bold tracking-tight text-neutral-900">
                {title}
              </DialogTitle>
              <div className="text-sm text-neutral-500 font-jakarta">
                {description}
              </div>
            </div>
          </DialogHeader>

          <DialogFooter className="flex w-full gap-3 sm:gap-3 sm:space-x-0 mt-2">
            <DialogClose
              render={
                <Button
                  variant="outline"
                  className="flex-1 rounded-xl"
                  disabled={isConfirming}
                >
                  {cancelText}
                </Button>
              }
            />
            <Button
              variant={isDestructive ? 'destructive' : 'default'}
              className="flex-1 rounded-xl gap-2"
              onClick={handleConfirmAction}
              disabled={isConfirming}
            >
              {isConfirming && <Loader2 className="size-4 animate-spin" />}
              {!isConfirming && isDestructive && <Trash2 className="size-4" />}
              {confirmText}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
