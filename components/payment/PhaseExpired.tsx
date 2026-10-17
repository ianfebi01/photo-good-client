import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface PhaseExpiredProps {
  onRetry : () => void
}

export function PhaseExpired( { onRetry }: PhaseExpiredProps ) {
  return (
    <main className="flex items-center justify-center h-screen bg-neutral-100">
      <div className="flex flex-col items-center gap-6 px-4">
        <AlertCircle className="size-12 text-amber-500" />
        <div className="text-center">
          <h3 className="text-lg font-bold text-amber-600">Payment Expired</h3>
          <p className="text-sm text-muted-foreground mt-1">
            The payment window has closed. Please try again.
          </p>
        </div>
        <Button
          size="lg"
          variant="outline"
          onClick={onRetry}
        >
          Create New Payment
        </Button>
      </div>
    </main>
  )
}
