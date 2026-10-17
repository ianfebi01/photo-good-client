import { Loader2 } from 'lucide-react'

export function PhaseLoading() {
  return (
    <main className="flex items-center justify-center h-screen bg-neutral-100">
      <Loader2 className="size-10 animate-spin text-muted-foreground" />
    </main>
  )
}
