import * as React from 'react'

import { cn } from '@/lib/utils'

export default function AppCard( {
  className,
  children,
  ...props
}: React.ComponentProps<'div'> ) {
  return (
    <div
      className={cn(
        'rounded-3xl bg-white p-6 transition-all duration-300 ease-in-out hover:shadow-xl',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}
