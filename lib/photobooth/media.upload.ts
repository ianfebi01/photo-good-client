import { externalFetch } from '@/lib/photobooth/config'
import type {
  BoothMedia,
  BoothMediaFinalizeRequest,
  BoothMediaPresignRequest,
  BoothMediaPresignResponse,
} from '@/types/booth'

/**
 * Upload one local capture to the external booth API.
 *
 * Three steps, so a 50 MB clip never passes through either app server:
 *   1. presign — the API hands back a short-lived PUT URL
 *   2. PUT      — the bytes go straight to object storage
 *   3. finalise — the API records the row and returns its id
 *
 * Throws on any failure, including a rejected PUT, so the caller can log the
 * file and carry on with the rest of the batch.
 */
export async function uploadMediaToBackend( {
  buffer,
  filename,
  mimeType,
}: {
  buffer: Buffer
  filename: string
  mimeType: string
} ): Promise<BoothMedia> {
  const presignBody: BoothMediaPresignRequest = {
    mimeType : mimeType,
    size     : buffer.length,
    filename : filename,
  }

  const presignRes = await externalFetch( '/api/booth/media/presign', {
    method  : 'POST',
    headers : { 'Content-Type' : 'application/json' },
    body    : JSON.stringify( presignBody ),
  } )

  if ( !presignRes.ok ) {
    throw new Error( `Presign failed (${presignRes.status}): ${await presignRes.text()}` )
  }

  const presign = await presignRes.json() as BoothMediaPresignResponse

  // Straight to object storage — no auth header, the signed URL is the credential.
  const putRes = await fetch( presign.uploadUrl, {
    method  : 'PUT',
    headers : { 'Content-Type' : presign.contentType },
    // A plain Uint8Array rather than the Buffer: Buffer's `ArrayBufferLike` type
    // is not assignable to the DOM's BlobPart.
    body    : new Blob( [new Uint8Array( buffer )], { type : presign.contentType } ),
  } )

  if ( !putRes.ok ) {
    const detail = await putRes.text().catch( () => '' )

    throw new Error( `Upload rejected by storage (${putRes.status}): ${detail.slice( 0, 200 )}` )
  }

  const finalizeBody: BoothMediaFinalizeRequest = { key : presign.key }

  const finalizeRes = await externalFetch( '/api/booth/media', {
    method  : 'POST',
    headers : { 'Content-Type' : 'application/json' },
    body    : JSON.stringify( finalizeBody ),
  } )

  if ( !finalizeRes.ok ) {
    throw new Error( `Finalise failed (${finalizeRes.status}): ${await finalizeRes.text()}` )
  }

  const { media } = await finalizeRes.json() as { media : BoothMedia }

  return media
}
