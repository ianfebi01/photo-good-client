'use client'

import { Loader2, QrCode } from 'lucide-react'

import { BoothQR } from '@/components/booth/BoothQR'
import type { SyncStatus } from '@/components/booth/SyncStatusBanner'

export function QRSection( {
  syncStatus,
  resultSessionId,
}: {
  syncStatus: SyncStatus
  resultSessionId: string | null
} ) {
  return (
    <div className="flex flex-col items-center gap-4">
      {syncStatus === 'done' && resultSessionId ? (
        <>
          <BoothQR
            page={`${process.env.NEXT_PUBLIC_BASE_URL || ''}/r/${resultSessionId}`}
          />
          <p className="text-sm text-muted-foreground text-center max-w-xs">
            Scan to view &amp; download your photos on your phone
          </p>
        </>
      ) : (
        // Placeholder that mirrors BoothQR dimensions exactly —
        // prevents layout shift when the real QR renders in.
        <div className="flex flex-col items-center gap-3 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            <QrCode className="size-4" />
            Scan to open on phone
          </div>
          <div className="relative size-50 rounded-xl border bg-secondary/50 shadow-sm flex items-center justify-center">
            <Loader2 className="size-8 animate-spin text-muted-foreground/60" />
          </div>
          <span className="text-xs text-muted-foreground h-8" />
        </div>
      )}
    </div>
  )
}
