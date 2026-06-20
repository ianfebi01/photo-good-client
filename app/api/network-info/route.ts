import { networkInterfaces } from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Return the server's local IP so the QR code can point to a
 * network-reachable URL instead of localhost.
 */
export async function GET() {
  const nets = networkInterfaces();
  const candidates: string[] = [];

  for ( const info of Object.values( nets ) ) {
    if ( !info ) continue;
    for ( const addr of info ) {
      // Skip internal / loopback
      if ( addr.internal || addr.family !== "IPv4" ) continue;
      candidates.push( addr.address );
    }
  }

  // Prefer 192.168.x.x, then 10.x.x.x, then first available
  const ip =
    candidates.find( ( a ) => a.startsWith( "192.168." ) ) ??
    candidates.find( ( a ) => a.startsWith( "10." ) ) ??
    candidates[0] ??
    "localhost";

  return Response.json( { ip } );
}
