import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface PhaseFallbackProps {
  onRetry : () => void
}

export function PhaseFallback( { onRetry }: PhaseFallbackProps ) {
  return (
    <main className="flex items-center justify-center h-screen bg-neutral-100">
      <div className="flex flex-col items-center gap-6 px-4">
        <X className="size-16 text-red-500" />
        <div className="text-center">
          <h3 className="text-xl font-bold text-red-600">No Payment Detected</h3>
          <p className="text-sm text-muted-foreground mt-1 font-jakarta">
            Please complete the payment to continue.
          </p>
        </div>
        <Button
          size="lg"
          variant="outline"
          onClick={onRetry}
        >
          Try Again
        </Button>
      </div>
    </main>
  )
}
