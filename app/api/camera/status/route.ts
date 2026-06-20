import { detectCamera } from "@/lib/photobooth/camera";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await detectCamera();
  
  return Response.json( status );
}
