import { fetchBoothFrames } from "@/lib/photobooth/frames.query.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Return a paginated frame catalog from the external API. */
export async function GET( request: Request ) {
  const { searchParams } = new URL( request.url );
  const page = Math.max( 1, Number( searchParams.get( "page" ) ) || 1 );
  const limit = Math.min( 50, Math.max( 1, Number( searchParams.get( "limit" ) ) || 8 ) );

  const all = await fetchBoothFrames();
  const total = all.length;
  const start = ( page - 1 ) * limit;
  const pageFrames = all.slice( start, start + limit );

  return Response.json( { frames : pageFrames, total } );
}
