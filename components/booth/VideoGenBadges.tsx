'use client'

import { Loader2, AlertCircle } from 'lucide-react'

export type GenStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'

export function isSettled( s: GenStatus ) {
  return s === 'ready' || s === 'error' || s === 'unavailable'
}

export function VideoGenBadges( {
  videoStatus,
  loopStatus,
}: {
  videoStatus: GenStatus
  loopStatus: GenStatus
} ) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3 mb-4">
      {videoStatus === 'loading' && (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
          <Loader2 className="size-3 animate-spin" />
          Generating mashup video&hellip;
        </span>
      )}
      {videoStatus === 'error' && (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
          <AlertCircle className="size-3" />
          Mashup video failed
        </span>
      )}
      {videoStatus === 'unavailable' && (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-gray-50 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          Mashup unavailable
        </span>
      )}

      {loopStatus === 'loading' && (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
          <Loader2 className="size-3 animate-spin" />
          Generating loop video&hellip;
        </span>
      )}
      {loopStatus === 'error' && (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
          <AlertCircle className="size-3" />
          Loop video failed
        </span>
      )}
      {loopStatus === 'unavailable' && (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-gray-50 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          Loop unavailable
        </span>
      )}
    </div>
  )
}
