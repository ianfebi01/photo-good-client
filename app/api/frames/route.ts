import { fetchBoothFrames, FetchError } from "@/lib/photobooth/frames.query.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Proxy: fetch frame catalog from the external booth API (keeps BOOTH_API_KEY server-side). */
export async function GET( request: Request ) {
  const { searchParams } = new URL( request.url );
  const page = Math.max( 1, Number( searchParams.get( "page" ) ) || 1 );
  const limit = Math.min( 50, Math.max( 1, Number( searchParams.get( "limit" ) ) || 8 ) );

  let all;
  try {
    all = await fetchBoothFrames();
  } catch ( err ) {
    if ( err instanceof FetchError ) {
      return Response.json( { error : err.message }, { status : err.status } )
    }

    return Response.json( { error : 'Failed to fetch frames' }, { status : 502 } )
  }
  const total = all.length;
  const start = ( page - 1 ) * limit;
  const pageFrames = all.slice( start, start + limit );

  return Response.json( { frames : pageFrames, total } );
}
