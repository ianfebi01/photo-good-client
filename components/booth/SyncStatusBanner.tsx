'use client'

import { Loader2, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'

export type SyncStatus = 'idle' | 'syncing' | 'done' | 'error'

export function SyncStatusBanner( {
  status,
  error,
  onRetry,
}: {
  status: SyncStatus
  error: string | null
  onRetry: () => void
} ) {
  if ( status === 'syncing' ) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
        <Loader2 className="size-4 animate-spin" />
        Uploading to server&hellip;
      </div>
    )
  }

  if ( status === 'done' ) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
        <CheckCircle2 className="size-4" />
        Uploaded to server
      </div>
    )
  }

  if ( status === 'error' ) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-full bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
        <AlertCircle className="size-4" />
        Upload failed{error ? `: ${error}` : ''}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 ml-1 text-xs"
          onClick={onRetry}
        >
          <RefreshCw className="mr-1 size-3" />
          Retry
        </Button>
      </div>
    )
  }

  return null
}
