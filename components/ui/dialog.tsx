'use client'

import * as React from 'react'
import { Dialog as DialogParts } from '@base-ui/react/dialog'
import { cn } from '@/lib/utils'

const {
  Root,
  Portal,
  Backdrop,
  Popup,
  Trigger,
  Close,
  Title,
  Description,
} = DialogParts

const Dialog = Root

const DialogTrigger = Trigger

const DialogClose = Close

const DialogContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof Popup> & {
    overlayRef?: React.Ref<HTMLDivElement>
  }
>( ( { children, className, overlayRef, ...props }, ref ) => (
  <Portal>
    <Backdrop
      ref={overlayRef}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs"
    />
    <Popup
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
        'bg-card rounded-2xl shadow-xl border outline-none',
        className
      )}
      {...props}
    >
      {children}
    </Popup>
  </Portal>
) )
DialogContent.displayName = 'DialogContent'

function DialogHeader( {
  className,
  ...props
}: React.ComponentProps<'div'> ) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 text-center sm:text-left',
        className
      )}
      {...props}
    />
  )
}
DialogHeader.displayName = 'DialogHeader'

function DialogFooter( {
  className,
  ...props
}: React.ComponentProps<'div'> ) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse sm:flex-row sm:justify-end gap-2',
        className
      )}
      {...props}
    />
  )
}
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof Title>
>( ( { className, ...props }, ref ) => (
  <Title
    ref={ref}
    className={cn(
      'text-lg font-semibold leading-none tracking-tight text-foreground',
      className
    )}
    {...props}
  />
) )
DialogTitle.displayName = 'DialogTitle'

const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof Description>
>( ( { className, ...props }, ref ) => (
  <Description
    ref={ref}
    className={cn( 'text-sm text-muted-foreground', className )}
    {...props}
  />
) )
DialogDescription.displayName = 'DialogDescription'

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
