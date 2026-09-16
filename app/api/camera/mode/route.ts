import {
  SIDECAR_URL,
  cameraServiceHint,
  sidecarDevices,
  sidecarMode,
  sidecarSetMode,
} from "@/lib/photobooth/sidecar";
import type { CameraMode, CameraModeState } from "@/types/booth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODES: CameraMode[] = [ "gphoto", "uvc" ];

function isMode( value: unknown ): value is CameraMode {
  return value === "gphoto" || value === "uvc";
}

/**
 * The camera service did not answer — say which fix that needs.
 *
 * The booth's toggle reads this message, so it has to name the address and the
 * command: "unreachable" alone sends people looking for a bug in the app when
 * the camera service simply is not running.
 */
async function unreachable() {
  return Response.json(
    { error : await cameraServiceHint(), url : SIDECAR_URL },
    { status : 503 },
  );
}

/** Read the camera service's current source plus the devices it can offer. */
async function readState(): Promise<CameraModeState | null> {
  const [ mode, deviceList ] = await Promise.all( [
    sidecarMode(),
    sidecarDevices(),
  ] );

  // No mode means no camera service, which also means nothing to switch.
  if ( !mode ) return null;

  return {
    mode    : isMode( mode.mode ) ? mode.mode : "uvc",
    device  : mode.device ?? null,
    modes   : mode.modes?.length ? mode.modes : MODES,
    ffmpeg  : mode.ffmpeg ?? deviceList?.ffmpeg ?? false,
    devices : deviceList?.devices ?? [],
  };
}

export async function GET() {
  const state = await readState();
  if ( !state ) return unreachable();

  return Response.json( state );
}

/**
 * Switch the camera source between the PTP camera (`gphoto`) and a USB video
 * capture device (`uvc`).
 *
 * Both modes end up serving the same `/preview` + `/snapshot` pair, so a shot
 * stays a screenshot of the live view either way — in `uvc` mode that is the
 * only capture that exists. Callers should restart the booth preview afterwards
 * so the running MJPEG stream reconnects to the new source.
 *
 * Body (JSON):
 *   - mode:   "gphoto" | "uvc"
 *   - device: optional capture device id (`uvc`); omitted, the service picks
 *             the first device it can see
 */
export async function POST( request: Request ) {
  let mode: CameraMode;
  let device: string | undefined;

  try {
    const body = await request.json();
    if ( !isMode( body?.mode ) ) {
      return Response.json(
        { error : "mode must be 'gphoto' or 'uvc'" },
        { status : 400 },
      );
    }
    mode = body.mode;
    if ( typeof body.device === "string" && body.device.trim() ) {
      device = body.device.trim();
    }
  } catch {
    return Response.json( { error : "Invalid JSON body" }, { status : 400 } );
  }

  let updated;
  try {
    updated = await sidecarSetMode( mode, device );
  } catch ( err ) {
    return Response.json(
      { error : err instanceof Error ? err.message : "Camera mode switch failed" },
      { status : 502 },
    );
  }

  if ( !updated ) return unreachable();

  const state = await readState();

  return Response.json(
    state ?? {
      mode    : isMode( updated.mode ) ? updated.mode : mode,
      device  : updated.device ?? null,
      modes   : updated.modes?.length ? updated.modes : MODES,
      ffmpeg  : updated.ffmpeg ?? false,
      devices : [],
    },
  );
}
