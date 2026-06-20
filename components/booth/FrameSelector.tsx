import { type ClientFrame } from '@/lib/photobooth/frames.client'
import { FramePhotoStack } from './FramePhotoStack'

export function FrameSelector( {
  frames,
  active,
  disabled,
  onSelect,
}: {
  frames: ClientFrame[]
  active: string
  disabled: boolean
  onSelect: ( key: string ) => void
  onAdd: ( frame: ClientFrame ) => void
} ) {
  return (
    <div className="flex flex-col gap-6 grow overflow-hidden items-center">
      {/* Main Stack Workspace - Transparent, centered, no backgrounds or borders */}
      <div className="w-full max-w-2xl flex-1 flex items-center justify-center overflow-visible relative">
        <FramePhotoStack
          frames={frames}
          activeKey={active}
          onSelect={onSelect}
          disabled={disabled}
        />
      </div>
    </div>
  )
}
