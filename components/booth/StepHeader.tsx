import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Shared header for the booth steps: optional leading action (e.g. a back
 * button), a title / subtitle pair, and optional trailing actions.
 */
export function StepHeader( {
  title,
  subtitle,
  leading,
  actions,
  align = 'start',
  className,
}: {
  title      : ReactNode
  subtitle?  : ReactNode
  leading?   : ReactNode
  actions?   : ReactNode
  align?     : 'start' | 'center'
  className? : string
} ) {
  return (
    <div className={cn( 'flex justify-between items-center gap-4', className )}>
      <div className="flex items-center gap-3">
        {leading}
        <div
          className={cn(
            'flex flex-col',
            align === 'center' && 'items-center text-center',
          )}
        >
          <span className="text-sm font-bold text-neutral-800 font-sans">
            {title}
          </span>
          {subtitle ? (
            <span className="text-xs text-neutral-400 font-jakarta">
              {subtitle}
            </span>
          ) : null}
        </div>
      </div>

      {actions ? (
        <div className="flex items-center gap-2 shrink-0">
          {actions}
        </div>
      ) : null}
    </div>
  )
}
