import { type Status } from '@/store/boothStore'

export function CameraBadge( { status }: { status: Status | null } ) {
  if ( !status ) {
    return (
      <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
        Detecting camera…
      </span>
    )
  }

  if ( status.connected ) {
    return (
      <span className="flex items-center gap-2 rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
        <span className="size-2 rounded-full bg-emerald-500" />
        {status.model ?? 'Camera ready'}
      </span>
    )
  }

  return (
    <span className="flex items-center gap-2 rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">
      <span className="size-2 rounded-full bg-amber-500" />
      {status.gphoto2 ? 'No camera — mock mode' : 'gphoto2 missing — mock mode'}
    </span>
  )
}
