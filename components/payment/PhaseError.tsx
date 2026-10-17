import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface PhaseErrorProps {
  errorMsg : string | null
  onRetry : () => void
}

export function PhaseError( { errorMsg, onRetry }: PhaseErrorProps ) {
  return (
    <main className="flex items-center justify-center h-screen bg-neutral-100">
      <div className="flex flex-col items-center gap-6 px-4">
        <AlertCircle className="size-12 text-red-500" />
        <div className="text-center">
          <h3 className="text-lg font-bold text-red-600">Payment Error</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-xs">
            {errorMsg || 'Something went wrong. Please try again.'}
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
