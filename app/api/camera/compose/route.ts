import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureCapturesDir } from "@/lib/photobooth/camera";
import {
  CAPTURES_DIR,
  DEFAULT_FRAME,
  getFrame,
} from "@/lib/photobooth/config";
import { composeStrip } from "@/lib/photobooth/compose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE_RE = /^shot-[a-z0-9]+-\d+\.jpg$/i;
const ID_RE = /^[a-z0-9]+$/i;
const FRAME_KEY_RE = /^[a-z0-9-]+$/i;

export async function POST( request: Request ) {
  let files: string[] = [];
  let sessionId = "";
  let frameKey: string = DEFAULT_FRAME;
  let adjustments: { x: number; y: number; zoom: number; filter: string }[] | undefined = undefined;
  try {
    const body = await request.json();
    files = Array.isArray( body.files ) ? body.files.map( String ) : [];
    sessionId = String( body.sessionId ?? "" );
    if ( typeof body.frame === "string" ) frameKey = body.frame;
    if ( Array.isArray( body.adjustments ) ) {
      adjustments = body.adjustments as { x: number; y: number; zoom: number; filter: string }[];
    }
  } catch {
    return Response.json( { error : "Invalid JSON body" }, { status : 400 } );
  }

  if ( !ID_RE.test( sessionId ) ) {
    return Response.json( { error : "Invalid sessionId" }, { status : 400 } );
  }
  if ( !FRAME_KEY_RE.test( frameKey ) ) {
    return Response.json( { error : "Invalid frame key" }, { status : 400 } );
  }
  const frame = await getFrame( frameKey );
  if ( !frame ) {
    return Response.json( { error : "Unknown frame" }, { status : 400 } );
  }
  if ( files.length !== frame.slots.length ) {
    return Response.json(
      { error : `Expected ${frame.slots.length} files for ${frame.label}` },
      { status : 400 },
    );
  }
  if ( !files.every( ( f ) => FILE_RE.test( f ) ) ) {
    return Response.json( { error : "Invalid file name" }, { status : 400 } );
  }

  try {
    await ensureCapturesDir();
    const buffers = await Promise.all(
      files.map( ( f ) => readFile( path.join( CAPTURES_DIR, path.basename( f ) ) ) ),
    );
    const strip = await composeStrip( buffers, frameKey, adjustments );
    const name = `strip-${sessionId}-${frameKey}.jpg`;
    await writeFile( path.join( CAPTURES_DIR, name ), strip );

    return Response.json( { file : name, url : `/api/captures/${name}` } );
  } catch ( err ) {
    return Response.json(
      { error : err instanceof Error ? err.message : "Compose failed" },
      { status : 500 },
    );
  }
}
