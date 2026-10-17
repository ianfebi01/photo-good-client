import { Loader2 } from 'lucide-react'

export function PhaseCreating() {
  return (
    <main className="flex items-center justify-center h-screen bg-neutral-100">
      <div className="flex flex-col items-center gap-6 px-4">
        <Loader2 className="size-12 animate-spin text-muted-foreground" />
        <p className="text-lg font-medium text-muted-foreground">
          Creating payment&hellip;
        </p>
      </div>
    </main>
  )
}
