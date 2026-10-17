import { Loader2, ExternalLink } from 'lucide-react'
import type { PaymentChargeState } from '@/types/payment'

interface PhasePendingProps {
  charge : PaymentChargeState
}

export function PhasePending( { charge }: PhasePendingProps ) {
  return (
    <main className="flex items-center justify-center min-h-screen bg-neutral-100">
      <div className="container px-4 py-8 mx-auto">
        <div className="mb-8 space-y-3 text-center">
          <h2 className="text-3xl font-bold tracking-tight lg:text-4xl text-foreground">
            Scan to Start
          </h2>
          <p className="max-w-md mx-auto text-sm text-muted-foreground lg:text-base font-jakarta">
            Pay with QRIS via GoPay or any e-wallet to begin your photo session.
          </p>
        </div>

        <div className="flex flex-col items-center gap-6 font-jakarta">
          {charge.qrCodeUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={charge.qrCodeUrl}
              alt="QRIS payment QR code"
              className="w-64 h-64 border rounded-xl shadow-md"
            />
          ) : (
            <div className="w-64 h-64 border rounded-xl shadow-md flex items-center justify-center bg-muted">
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
            </div>
          )}
          <p className="text-sm text-muted-foreground text-center max-w-xs">
            Scan with your e-wallet app to pay{' '}
            <strong>
              Rp {charge.grossAmount ? charge.grossAmount.toLocaleString( 'id-ID' ) : '15.000'}
            </strong>
          </p>
          {charge.deeplinkUrl && (
            <a
              href={charge.deeplinkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-full hover:bg-blue-100 transition-colors"
            >
              <ExternalLink className="size-4" />
              {charge.gateway === 'midtrans' ? 'Open GoPay' : 'Open E-Wallet'}
            </a>
          )}
          <p className="text-xs text-muted-foreground/60">
            Waiting for payment&hellip;
          </p>
        </div>

        {charge.boothName && (
          <p className="mt-8 text-xs text-center text-muted-foreground/40">
            {charge.boothName}
          </p>
        )}
      </div>
    </main>
  )
}
