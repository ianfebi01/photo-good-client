'use client'

import { useCallback, useEffect, useState } from 'react'
import { Camera, Loader2, TvMinimalPlay, type LucideIcon } from 'lucide-react'

import { useBoothStore } from '@/store/boothStore'
import { getCameraModeState, setCameraMode } from '@/lib/photobooth/frames.query'
import { cn } from '@/lib/utils'
import type { CameraDevice, CameraMode } from '@/types/booth'

const OPTIONS: Array<{
  mode : CameraMode
  label : string
  hint : string
  Icon : LucideIcon
}> = [
  {
    mode  : 'gphoto',
    label : 'DSLR',
    hint  : 'PTP camera via the camera service — a shot is its newest live-view frame',
    Icon  : Camera,
  },
  {
    mode  : 'uvc',
    label : 'USB video',
    hint  : 'HDMI/USB video capture device — a shot is a screenshot of the video',
    Icon  : TvMinimalPlay,
  },
]

/**
 * Switch the camera source between the PTP camera and a USB video capture
 * device.
 *
 * The switch itself happens in the camera service (`POST /mode`), which tears
 * its current reader down and opens the other one. The booth then restarts its
 * preview, because the running MJPEG stream was opened against the old source,
 * and carries on with the mode the service reports — in `uvc` mode a shot is a
 * screenshot of the newest video frame, so nothing else in the capture flow
 * changes. Until the status poll catches up the toggle shows the *requested*
 * mode, so the control never looks like the tap missed.
 *
 * `uvc` also gets a device picker when the machine offers more than one
 * capture device: the host auto-selects one, and this is how an operator
 * corrects that choice without a terminal — device indices are positional, so
 * the auto-selection cannot be trusted to be the HDMI stick.
 *
 * Rendered on the capture step, where the camera is actually in use; switching
 * mid-session is blocked because it would swap the source under a live stream.
 */
export function CameraModeToggle( { disabled = false }: { disabled?: boolean } ) {
  const status = useBoothStore( ( state ) => state.status )
  const setStatus = useBoothStore( ( state ) => state.setStatus )
  const restartPreview = useBoothStore( ( state ) => state.restartPreview )

  const [ requested, setRequested ] = useState<CameraMode | null>( null )
  const [ error, setError ] = useState<string | null>( null )
  const [ devices, setDevices ] = useState<CameraDevice[]>( [] )
  const [ device, setDevice ] = useState<string | null>( null )

  const active = requested ?? status?.mode ?? 'gphoto'
  const busy = requested !== null

  // Read the device list once so `uvc` can offer a picker. A booth with no
  // camera service simply gets no picker, so failures are swallowed.
  useEffect( () => {
    let mounted = true
    void getCameraModeState()
      .then( ( state ) => {
        if ( !mounted ) return
        setDevices( state.devices )
        setDevice( state.device ?? null )
      } )
      .catch( () => {} )

    return () => {
      mounted = false
    }
  }, [] )

  const apply = useCallback(
    ( mode: CameraMode, target?: string ) => {
      setRequested( mode )
      setError( null )

      void setCameraMode( mode, target )
        .then( ( state ) => {
          setDevices( state.devices )
          setDevice( state.device ?? null )
          // Reflect the new source immediately, keeping the last known
          // connection details — the status poll re-reads the truth shortly.
          const current = useBoothStore.getState().status
          if ( current ) {
            setStatus( {
              ...current,
              mode   : state.mode,
              device : state.device,
            } )
          }
          restartPreview()
        } )
        .catch( ( err : unknown ) => {
          setError( err instanceof Error ? err.message : 'Switch failed' )
        } )
        .finally( () => setRequested( null ) )
    },
    [restartPreview, setStatus],
  )

  // Camera status hasn't arrived yet — nothing truthful to render.
  if ( !status ) return null

  const locked = disabled || busy

  // `gphoto2: false` is how the status route reports that the camera service
  // itself could not be reached (as opposed to "service up, no camera"). Both
  // modes need that service, so say so before the operator taps and gets a
  // failure: the toggle can only ever work once it is running.
  const note =
    error ??
    ( status.gphoto2 === false
      ? 'Camera service offline — start it with: pnpm camera'
      : null )

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <div
          role="group"
          aria-label="Camera source"
          className={cn(
            'flex items-center gap-1 rounded-full border border-neutral-200 bg-white p-1',
            locked && 'opacity-60',
          )}
        >
          {OPTIONS.map( ( { mode, label, hint, Icon } ) => {
            const isActive = mode === active
            const isWorking = requested === mode

            return (
              <button
                key={mode}
                type="button"
                onClick={() => apply( mode )}
                disabled={locked || isActive}
                aria-pressed={isActive}
                title={hint}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold font-sans transition-colors',
                  isActive
                    ? 'bg-neutral-900 text-white'
                    : 'text-neutral-500 hover:bg-neutral-100',
                  'disabled:cursor-not-allowed',
                )}
              >
                {isWorking ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Icon className="size-3.5" />
                )}
                {label}
              </button>
            )
          } )}

          {active === 'uvc' && devices.length > 1 ? (
            <select
              aria-label="Capture device"
              value={device ?? ''}
              disabled={locked}
              onChange={( event ) => apply( 'uvc', event.target.value )}
              title="Capture device the camera service reads"
              className={cn(
                'max-w-40 truncate rounded-full border-0 bg-neutral-100 px-2 py-1.5',
                'font-sans text-xs font-medium text-neutral-600',
                'disabled:cursor-not-allowed',
              )}
            >
              {/* Shown only when the service's current device is not in this
                  list (it can vanish or be re-indexed between reads). */}
              {devices.some( ( entry ) => entry.id === device ) ? null : (
                <option value="">Auto</option>
              )}
              {devices.map( ( entry ) => (
                <option
                  key={entry.id}
                  value={entry.id}
                >
                  {entry.label}
                </option>
              ) )}
            </select>
          ) : null}
        </div>
      </div>

      {note ? (
        <span
          title={note}
          className="max-w-72 truncate text-[10px] font-medium text-destructive"
        >
          {note}
        </span>
      ) : null}
    </div>
  )
}
