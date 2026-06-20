import "server-only";

import { mkdir } from "node:fs/promises";
import sharp from "sharp";

import {
  CAPTURES_DIR,
  FORCE_MOCK,
  FRAME,
  PHOTO_HEIGHT,
  PHOTO_WIDTH,
} from "./config";
import { sidecarCapture, sidecarStatus } from "./sidecar";

export type CameraStatus = {
  /** A real camera is reachable and will be used. */
  connected: boolean;
  /** True when frames/captures are simulated (no camera, or PHOTOBOOTH_MOCK=1). */
  mock: boolean;
  /** Detected camera model, when available. */
  model?: string;
  /** True when the camera service (sidecar) is reachable. */
  gphoto2: boolean;
};

export async function ensureCapturesDir() {
  await mkdir( CAPTURES_DIR, { recursive : true } );
}

/**
 * Camera status comes from the Python sidecar (camera-service/), which owns the
 * camera via libgphoto2 and recovers across USB reconnects in-process. When the
 * sidecar is unreachable — or PHOTOBOOTH_MOCK=1 — we fall back to the simulated
 * camera so the app keeps working without hardware.
 */
export async function detectCamera(): Promise<CameraStatus> {
  if ( FORCE_MOCK ) return { connected : false, mock : true, gphoto2 : false };

  const status = await sidecarStatus();
  if ( !status ) return { connected : false, mock : true, gphoto2 : false };

  return {
    connected : status.connected,
    mock      : !status.connected,
    model     : status.model ?? undefined,
    gphoto2   : true,
  };
}

/**
 * Capture one full-resolution still as a JPEG buffer. Real captures go through
 * the sidecar's /capture endpoint; with no camera we synthesize a mock frame.
 */
export async function captureStill( seq = 0 ): Promise<Buffer> {
  const status = await detectCamera();
  if ( status.mock ) return mockPhoto( seq );

  return sidecarCapture();
}

// ---------------------------------------------------------------------------
// Mock camera (sharp-generated frames) — used when no camera/sidecar is present.
// ---------------------------------------------------------------------------

const MOCK_TINTS = [
  FRAME.accent,
  "#FF7070",
  FRAME.accentSoft,
  "#FFD27A",
  "#7AC7FF",
  "#9DE39D",
];

function escapeXml( s: string ) {
  return s.replace( /[<>&'"]/g, ( c ) =>
    ( { "<" : "&lt;", ">" : "&gt;", "&" : "&amp;", "'" : "&apos;", '"' : "&quot;" } )[
      c
    ] as string,
  );
}

/** A single simulated still — distinct per `seq` so a strip shows variety. */
export async function mockPhoto( seq = 0 ): Promise<Buffer> {
  const tint = MOCK_TINTS[seq % MOCK_TINTS.length];
  const stamp = new Date().toLocaleString();
  const svg = `
<svg width="${PHOTO_WIDTH}" height="${PHOTO_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="g" cx="50%" cy="38%" r="75%">
      <stop offset="0%" stop-color="${tint}"/>
      <stop offset="100%" stop-color="${FRAME.textDark}"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <text x="50%" y="44%" text-anchor="middle" font-family="Arial, sans-serif"
        font-size="120" font-weight="800" fill="#ffffff" opacity="0.92">MOCK</text>
  <text x="50%" y="56%" text-anchor="middle" font-family="Arial, sans-serif"
        font-size="56" font-weight="700" fill="#ffffff" opacity="0.9">Pose #${seq + 1}</text>
  <text x="50%" y="92%" text-anchor="middle" font-family="Arial, sans-serif"
        font-size="30" fill="#ffffff" opacity="0.85">${escapeXml( stamp )}</text>
</svg>`;

  return sharp( Buffer.from( svg ) ).jpeg( { quality : 88 } ).toBuffer();
}

/** A single simulated live-preview frame (animated by `tick`). */
export async function mockPreviewFrame( tick: number ): Promise<Buffer> {
  const w = 800;
  const h = 533;
  const x = 50 + Math.round( 40 * Math.sin( tick / 6 ) );
  const y = 50 + Math.round( 18 * Math.cos( tick / 5 ) );
  const svg = `
<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${FRAME.textDark}"/>
  <circle cx="${x}%" cy="${y}%" r="120" fill="${FRAME.accent}" opacity="0.55"/>
  <circle cx="${100 - x}%" cy="${100 - y}%" r="90" fill="${FRAME.accentSoft}" opacity="0.5"/>
  <text x="50%" y="50%" text-anchor="middle" font-family="Arial, sans-serif"
        font-size="40" font-weight="700" fill="#ffffff" opacity="0.9">LIVE • mock camera</text>
</svg>`;

  return sharp( Buffer.from( svg ) ).jpeg( { quality : 70 } ).toBuffer();
}
