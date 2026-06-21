export const BOOTHS_QUERY_KEY = ['admin', 'booths'] as const

export type Booth = {
  id : string
  name : string
  location : string | null
  active : boolean
  created_at : string
  updated_at : string
}

async function parseJson<T>( response : Response, fallbackMessage : string ) : Promise<T> {
  const data = await response.json().catch( () => null )
  if ( !response.ok ) {
    const message = data?.error ?? fallbackMessage
    throw new Error( message )
  }
  
  return data as T
}

export async function getBooths() : Promise<Booth[]> {
  const response = await fetch( '/api/admin/booths', { cache : 'no-store' } )
  const data = await parseJson<{ booths : Booth[] }>( response, 'Failed to load booths' )
  
  return data.booths
}

export async function toggleBooth( id : string, active : boolean ) : Promise<Booth> {
  const response = await fetch( `/api/admin/booths/${id}`, {
    method  : 'PATCH',
    headers : { 'Content-Type' : 'application/json' },
    body    : JSON.stringify( { active } ),
  } )
  const data = await parseJson<{ booth : Booth }>( response, 'Failed to update booth' )
  
  return data.booth
}

export async function deleteBooth( id : string ) : Promise<void> {
  const response = await fetch( `/api/admin/booths/${id}`, { method : 'DELETE' } )
  await parseJson( response, 'Failed to delete booth' )
}
