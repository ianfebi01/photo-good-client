'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Camera, Info, TvMinimalPlay } from 'lucide-react'

import { useBoothStore } from '@/store/boothStore'
import {
  type DeviceCamera,
  currentDeviceCameraId,
  getDeviceCameraChoice,
  listDeviceCameras,
  pickDeviceCamera,
  reopenDeviceCamera,
  setDeviceCameraChoice,
} from '@/lib/photobooth/deviceCamera'
import {
  USB_DRIVER_CHOICE,
  activeUsbCameraBase,
  getUsbCameraState,
  subscribeUsbCamera,
  usbDriverAvailable,
} from '@/lib/photobooth/usbCamera'
import { cn } from '@/lib/utils'

const KIND_LABEL: Record<DeviceCamera['kind'], string> = {
  external : 'USB',
  front    : 'Front',
  back     : 'Back',
}

const noServerState = () => null

/** What the in-app USB driver is doing, for the operator. */
function usbStatusText( state: string | undefined, error: string | null | undefined ): string | null {
  if ( error ) return error
  if ( state === 'waiting' ) return 'Plug in the USB capture device'
  if ( state === 'opening' ) return 'Opening the USB capture device — allow USB access if asked'
  if ( state === 'starting' ) return 'Starting the USB capture device…'
  if ( state === 'idle' || !state ) return 'USB driver not started yet'

  return null
}

/**
 * Pick which camera the device-camera booth (the Android app) films with.
 *
 * A USB capture device reaches the booth one of two ways: as a camera Android
 * offers to apps (listed as "USB"), or — on the many phones that do not do
 * that — through the app's own USB driver ("USB capture (app driver)"). `Auto`
 * uses either when present, the built-in camera otherwise, and switches by
 * itself when a capture device is plugged in or pulled while the booth is idle.
 *
 * Switching mid-shot would swap the stream under a countdown recording, so the
 * picker is locked (and auto-switching waits) while `disabled`.
 */
export function DeviceCameraPicker( { disabled = false }: { disabled?: boolean } ) {
  const restartPreview = useBoothStore( ( state ) => state.restartPreview )
  const streamKey = useBoothStore( ( state ) => state.streamKey )

  const usbState = useSyncExternalStore( subscribeUsbCamera, getUsbCameraState, noServerState )
  const usbActive = useSyncExternalStore( subscribeUsbCamera, activeUsbCameraBase, noServerState ) !== null
  const [driver, setDriver] = useState( false )
  useEffect( () => {
    const timer = setTimeout( () => setDriver( usbDriverAvailable() ), 0 )

    return () => clearTimeout( timer )
  }, [] )

  const [showDetails, setShowDetails] = useState( false )
  const [cameras, setCameras] = useState<DeviceCamera[]>( [] )
  const [choice, setChoice] = useState( 'auto' )
  const [currentId, setCurrentId] = useState<string | null>( null )

  const refresh = useCallback( async () => {
    const list = await listDeviceCameras().catch( () => [] )
    setCameras( list )
    setChoice( getDeviceCameraChoice() )
    setCurrentId( currentDeviceCameraId() )

    return list
  }, [] )

  // Re-read after every preview (re)start: labels only appear once the camera
  // has been opened, and the open camera is what "current" reports.
  useEffect( () => {
    const timer = setTimeout( () => void refresh(), 1_000 )

    return () => clearTimeout( timer )
  }, [refresh, streamKey] )

  // A capture device plugged in (or pulled) while the booth is up.
  useEffect( () => {
    const media = navigator.mediaDevices
    if ( !media?.addEventListener ) return
    const onChange = async () => {
      const list = await refresh()
      if ( disabled || getDeviceCameraChoice() !== 'auto' ) return
      const best = pickDeviceCamera( list, 'auto' )
      if ( best && best.deviceId !== currentDeviceCameraId() ) {
        reopenDeviceCamera()
        restartPreview()
      }
    }
    media.addEventListener( 'devicechange', onChange )

    return () => media.removeEventListener( 'devicechange', onChange )
  }, [disabled, refresh, restartPreview] )

  const apply = ( next: string ) => {
    setDeviceCameraChoice( next )
    setChoice( next )
    restartPreview()
  }

  const current = cameras.find( ( c ) => c.deviceId === currentId )
  const hasExternal = cameras.some( ( c ) => c.kind === 'external' ) || Boolean( usbState?.connected )
  const Icon = usbActive || current?.kind === 'external' ? TvMinimalPlay : Camera
  const usbNote = driver ? usbStatusText( usbState?.state, usbState?.error ) : null

  return (
    <div className="flex flex-col items-end gap-1">
      <label
        className={cn(
          'flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white py-1 pl-3 pr-1',
          disabled && 'opacity-60',
        )}
      >
        <Icon className="size-3.5 text-neutral-500" />
        <select
          aria-label="Camera"
          value={choice}
          disabled={disabled}
          onChange={( event ) => apply( event.target.value )}
          className={cn(
            'max-w-48 truncate rounded-full border-0 bg-neutral-100 px-2 py-1.5',
            'font-sans text-xs font-medium text-neutral-600',
            'disabled:cursor-not-allowed',
          )}
        >
          <option value="auto">Auto (USB capture if connected)</option>
          {driver ? (
            <option value={USB_DRIVER_CHOICE}>
              USB capture (app driver){usbState?.model ? ` · ${usbState.model}` : ''}
            </option>
          ) : null}
          {cameras.map( ( camera ) => (
            <option
              key={camera.deviceId}
              value={camera.deviceId}
            >
              {KIND_LABEL[camera.kind]} · {camera.label}
            </option>
          ) )}
        </select>
      </label>

      {driver ? (
        <button
          type="button"
          onClick={() => setShowDetails( ( open ) => !open )}
          className="flex items-center gap-1 font-sans text-[10px] font-medium text-neutral-500"
        >
          <Info className="size-3" />
          {showDetails ? 'Hide USB details' : 'USB details'}
        </button>
      ) : null}

      {driver && showDetails ? (
        <pre className="max-h-64 w-80 max-w-[90vw] overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-900 p-3 text-left font-mono text-[10px] leading-snug text-neutral-100">
          {[
            `state: ${usbState?.state ?? 'not started'}${usbState?.error ? ` — ${usbState.error}` : ''}`,
            `device: ${usbState?.model ?? '—'}`,
            `mode: ${usbState?.preview ? `${usbState.preview.width}x${usbState.preview.height} @${usbState.preview.fps}` : '—'}`,
            `frames: ${usbState?.frames ?? 0} · choice ${choice}`,
            '',
            ...( usbState?.log ?? ['(no driver events yet)'] ),
          ].join( '\n' )}
        </pre>
      ) : null}

      {usbNote && !usbState?.connected ? (
        <span className="max-w-72 text-right text-[10px] font-medium text-amber-600">
          {usbNote}
        </span>
      ) : cameras.length > 0 && !hasExternal ? (
        <span className="max-w-72 text-right text-[10px] font-medium text-amber-600">
          No USB capture device detected — check the cable and USB-OTG adapter
        </span>
      ) : null}
    </div>
  )
}
