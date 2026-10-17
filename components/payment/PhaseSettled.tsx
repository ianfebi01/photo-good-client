import { CheckCircle2 } from 'lucide-react'

interface PhaseSettledProps {
  countdown : number
}

export function PhaseSettled( { countdown }: PhaseSettledProps ) {
  return (
    <main className="flex items-center justify-center h-screen bg-neutral-100">
      <div className="flex flex-col items-center gap-6 px-4 animate-in fade-in duration-500">
        <CheckCircle2 className="size-16 text-emerald-500" />
        <div className="text-center">
          <h3 className="text-xl font-bold text-emerald-600">Payment Successful!</h3>
          <p className="text-sm text-muted-foreground mt-1 font-jakarta">
            Get ready for your photo session!
          </p>
          <p className="text-3xl font-bold text-emerald-600 mt-4 tabular-nums">
            {countdown}
          </p>
          <p className="text-xs text-muted-foreground mt-1 font-jakarta">
            Starting in {countdown} second{countdown !== 1 ? 's' : ''}&hellip;
          </p>
        </div>
      </div>
    </main>
  )
}
