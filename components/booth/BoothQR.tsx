'use client'

import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { QrCode } from 'lucide-react'

export function BoothQR( { page }: { page?: string } ) {
  const canvasRef = useRef<HTMLCanvasElement>( null )
  const [url, setUrl] = useState( '' )
  const [ready, setReady] = useState( false )

  useEffect( () => {
    const buildQr = async () => {
      const { hostname, port, protocol } = window.location
      const path = page ?? ''

      // If page is an absolute URL, render it directly
      if ( path.startsWith( 'http://' ) || path.startsWith( 'https://' ) ) {
        renderQR( path )

        return
      }

      // Already using an IP or non-localhost hostname — use it directly
      if ( hostname !== 'localhost' && hostname !== '127.0.0.1' ) {
        const url = `${protocol}//${hostname}${port ? `:${port}` : ''}${path}`
        renderQR( url )

        return
      }

      // Detect the server's local IP so phones on the same network can connect
      try {
        const res = await fetch( '/api/network-info' )
        const { ip } = await res.json()
        const url = `${protocol}//${ip}${port ? `:${port}` : ''}${path}`
        renderQR( url )
      } catch {
        // Fallback to localhost
        const url = `${protocol}//${hostname}${port ? `:${port}` : ''}${path}`
        renderQR( url )
      }
    }

    const renderQR = ( url: string ) => {
      setUrl( url )
      const canvas = canvasRef.current
      if ( !canvas ) return
      QRCode.toCanvas( canvas, url, {
        width  : 200,
        margin : 2,
        color  : {
          dark  : '#1e1e1e',
          light : '#ffffff',
        },
      } )
      setReady( true )
    }

    buildQr()
  }, [page] )

  return (
    <div className="flex flex-col items-center gap-3 p-4">
      <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        <QrCode className="size-4" />
        Scan to open on phone
      </div>
      <div className="relative size-50">
        <canvas
          ref={canvasRef}
          width={200}
          height={200}
          className="size-50 rounded-xl border bg-white p-2 shadow-sm"
        />
        {!ready && (
          <div className="absolute inset-0 animate-pulse rounded-xl border bg-secondary shadow-sm" />
        )}
      </div>
      <span className="text-xs text-muted-foreground truncate max-w-45 h-8">
        {url}
      </span>
    </div>
  )
}
