import { create } from "zustand";

import {
  type ClientFrame,
  DEFAULT_FRAME_KEY,
  FALLBACK_FRAMES,
} from "@/lib/photobooth/frames.client";
import { captureShot, composeStrip } from "@/lib/photobooth/frames.query";
import type { BoothClientSettings } from "@/types/booth";

export type Shot = { file: string; url: string };
export type Phase =
  | "idle"
  | "running"
  | "reviewing"
  | "composing"
  | "done"
  | "error"
  | "adjusting";
export type Status = {
  connected: boolean;
  mock: boolean;
  model?: string;
  gphoto2: boolean;
};

/** Idle timeout per step (seconds). Based on photobooth industry standards. */
export const STEP_TIMEOUTS: Record<number, number> = {
  0 : 30,   // Select Frame — 30s idle, then jump to capture
  1 : 30,   // Capture — 30s per slot, auto-capture on timeout
  2 : 15,   // Filter — 45s idle, then compose & go to result
  3 : 60,   // Result — 60s idle, then reset to home
};

/** Show "Are you still there?" warning this many seconds before auto-reset. */
export const TIMEOUT_WARNING_SECONDS = 5;

/** Timeout for individual capture requests (ms). */
const CAPTURE_TIMEOUT_MS = 30_000;

/** Slots are kept for the largest frame we support. */
const MAX_SLOTS = 10;

/**
 * Per-slot framing set on the capture step and consumed when composing.
 *
 * `x`/`y` are in *frame* pixels — the same space the compose API crops in —
 * not screen pixels, so a pan means the same crop no matter how large the
 * preview happens to be rendered.
 */
export type SlotAdjustment = { x: number; y: number; zoom: number; filter: string };

/** Neutral framing for every slot. */
export function createDefaultAdjustments( count = MAX_SLOTS ): SlotAdjustment[] {
  return Array.from( { length : count } ).map( () => ( {
    x      : 0,
    y      : 0,
    zoom   : 1.0,
    filter : 'none',
  } ) );
}

const newId = () => Math.random().toString( 36 ).slice( 2, 10 );

/** Extract a human-readable message from any thrown value. */
function errorMessage( err: unknown, fallback: string ): string {
  return err instanceof Error ? err.message : fallback;
}

// Module-level lock — avoids triggering re-renders on every capture tick.
// Zustand state changes would cause component tree re-renders; this
// module-scoped variable is invisible to React.
let _capturing = false;

export interface BoothState {
  // ── Persisted ──────────────────────────────────────
  started: boolean;
  frameKey: string;
  sessionId: string;
  photos: Shot[];
  strip: string | null;
  gifUrl: string | null;
  videoUrl: string | null;
  loopVideoUrl: string | null;
  countdownClips: Shot[];

  // ── Transient ──────────────────────────────────────
  phase: Phase;
  pending: Shot | null;
  flash: boolean;
  streamKey: string;
  error: string | null;
  uploadOpen: boolean;
  frames: ClientFrame[];
  status: Status | null;

  step: 0 | 1 | 2 | 3;

  // ── Payment ────────────────────────────────────────
  paymentStatus: 'idle' | 'pending' | 'paid' | 'expired' | 'error' | '';
  paymentOrderId: string | null;
  paymentQrCodeUrl: string | null;
  paymentDeeplinkUrl: string | null;
  resultSynced: boolean;

  // ── Timer ──────────────────────────────────────────
  /** Whether the step idle timer is enabled (e.g., kiosk mode). */
  timerEnabled: boolean;
  /** Seconds remaining on the current step timer. */
  timerSecondsLeft: number | null;
  /** Kiosk config: skip the shutter countdown and capture instantly. */
  disableCountdown: boolean;

  // ── Per-booth settings (transient) ─────────────────
  /**
   * Client settings fetched from `GET /api/booth/settings`. Refetched on every
   * load, so this is never persisted.
   *
   * `null` means "not resolved yet" — consumers must not guess a value, since
   * guessing `paymentEnabled: true` would bounce a payment-free booth to the
   * payment page before the request settles.
   */
  settings: BoothClientSettings | null;

  // ── Framing ──────────────────────────────────────
  /**
   * Pan / zoom / filter per slot. Authored on the capture step, applied on the
   * filter step's preview, and sent to the compose API.
   */
  adjustments: SlotAdjustment[];

  // ── Filter ─────────────────────────────────────────
  /** Currently selected global filter on the filter step. */
  globalFilter: string;

  // ── Actions ────────────────────────────────────────
  setStatus: ( status: Status | null ) => void;
  setFrames: ( frames: ClientFrame[] ) => void;
  selectFrame: ( key: string ) => void;
  setUploadOpen: ( open: boolean ) => void;
  restartPreview: () => void;
  start: () => void;
  goToFilter: () => void;
  reset: () => void;
  retakePending: () => void;
  addFrame: ( frame: ClientFrame ) => void;
  takeShot: ( replaceIndex?: number ) => Promise<void>;
  acceptPending: ( replaceIndex?: number ) => Promise<void>;
  composeStripWithAdjustments: ( adjustments: SlotAdjustment[] ) => Promise<void>;
  setGifUrl: ( url: string | null ) => void;
  setVideoUrl: ( url: string | null ) => void;
  setLoopVideoUrl: ( url: string | null ) => void;
  addCountdownClip: ( clip: Shot ) => void;
  /**
   * The current session id, creating and storing one when the session hasn't
   * started yet. `takeShot()` normally creates it, but the countdown recording
   * for the first shot begins before that shot is taken.
   */
  ensureSessionId: () => string;
  setTimerEnabled: ( enabled: boolean ) => void;
  setTimerSecondsLeft: ( seconds: number | null ) => void;
  setDisableCountdown: ( disabled: boolean ) => void;
  setSettings: ( settings: BoothClientSettings ) => void;
  resetTimer: () => void;
  setAdjustments: ( adjustments: SlotAdjustment[] ) => void;
  patchAdjustment: ( index: number, patch: Partial<SlotAdjustment> ) => void;
  resetAdjustment: ( index: number ) => void;
  setGlobalFilter: ( filter: string ) => void;
  setPayment: ( payment: Partial<Pick<BoothState, 'paymentStatus' | 'paymentOrderId' | 'paymentQrCodeUrl' | 'paymentDeeplinkUrl'>> ) => void;
}

// ── Helpers ───────────────────────────────────────────────────────

/** Fields cleared when a session resets or a new frame is selected. */
function freshSessionState(): Partial<BoothState> {
  return {
    started        : false,
    sessionId      : "",
    phase          : "idle",
    photos         : [],
    pending        : null,
    strip          : null,
    gifUrl         : null,
    videoUrl       : null,
    loopVideoUrl   : null,
    countdownClips : [],
    error          : null,
    globalFilter   : 'none',
    adjustments    : createDefaultAdjustments(),
  };
}

// ── Store ─────────────────────────────────────────────────────────

export const useBoothStore = create<BoothState>()(

  ( set, get ) => ( {
    // ── Initial state ──────────────────────────────
    started          : false,
    frameKey         : DEFAULT_FRAME_KEY,
    sessionId        : "",
    photos           : [],
    strip            : null,
    gifUrl           : null,
    videoUrl         : null,
    loopVideoUrl     : null,
    countdownClips   : [],
    phase            : "idle",
    pending          : null,
    flash            : false,
    streamKey        : "live",
    error            : null,
    uploadOpen       : false,
    frames           : FALLBACK_FRAMES,
    status           : null,
    step             : 0,
    timerEnabled     : false,
    timerSecondsLeft : null,
    disableCountdown : false,
    settings         : null,
    globalFilter     : 'none',
    adjustments      : createDefaultAdjustments(),

    // Payment
    paymentStatus      : '' as const,
    paymentOrderId     : null,
    paymentQrCodeUrl   : null,
    paymentDeeplinkUrl : null,
    resultSynced       : false,

    // ── Setters ────────────────────────────────────
    setStatus : ( status ) => set( { status } ),

    setFrames : ( frames ) => {
      const currentKey = get().frameKey;
      const keyExists = frames.some( ( f ) => f.key === currentKey );
      set( {
        frames,
        frameKey : keyExists ? currentKey : ( frames[0]?.key ?? "" ),
      } );
    },

    setUploadOpen : ( uploadOpen ) => set( { uploadOpen } ),

    restartPreview : () => set( { streamKey : newId() } ),

    // ── Navigation ─────────────────────────────────
    start      : () => set( { started : true, step : 1 } ),
    goToFilter : () => set( { step : 2 } ),

    // ── Frame selection ────────────────────────────
    selectFrame : ( key ) => {
      if ( key === get().frameKey ) return;
      _capturing = false;
      set( {
        ...freshSessionState(),
        frameKey  : key,
        streamKey : newId(),
      } );
    },

    // ── Session reset ──────────────────────────────
    reset : () => {
      _capturing = false;
      const { frames } = get();
      set( {
        ...freshSessionState(),
        frameKey         : frames[0]?.key ?? DEFAULT_FRAME_KEY,
        flash            : false,
        streamKey        : newId(),
        step             : 0,
        timerSecondsLeft : null,
        resultSynced     : false,
      } );
    },

    // ── Retake a pending shot ──────────────────────
    retakePending : () => {
      const { phase, pending } = get();
      if ( phase !== "reviewing" || !pending ) return;
      set( { pending : null, phase : "idle", streamKey : newId() } );
    },

    // ── Add an uploaded frame ──────────────────────
    addFrame : ( newFrame ) => {
      const { frames } = get();
      if ( !frames.some( ( f ) => f.key === newFrame.key ) ) {
        set( { frames : [...frames, newFrame] } );
      }
      set( { uploadOpen : false } );
      get().selectFrame( newFrame.key );
    },

    // ── Capture a shot ─────────────────────────────
    takeShot : async ( replaceIndex ) => {
      const { photos, frames, frameKey } = get();
      const frame = frames.find( ( f ) => f.key === frameKey ) ?? frames[0];
      const photoCount = frame?.photoCount ?? 0;

      if ( _capturing ) return;
      if ( replaceIndex === undefined && photos.length >= photoCount ) return;
      _capturing = true;

      const controller = new AbortController();
      const timeout = setTimeout( () => controller.abort(), CAPTURE_TIMEOUT_MS );

      set( { error : null, phase : "running" } );
      try {
        const { sessionId } = get();
        const activeSession = sessionId || newId();
        if ( !sessionId ) set( { sessionId : activeSession } );
        const index = replaceIndex ?? photos.length;

        const data = await captureShot( { sessionId : activeSession, index } );

        set( {
          pending : { file : data.file, url : `${data.url}?v=${newId()}` },
          phase   : "reviewing",
        } );
      } catch ( err ) {
        const message = err instanceof Error && err.name === "AbortError"
          ? "Capture timed out"
          : errorMessage( err, "Something went wrong" );
        set( { error : message, phase : "error" } );
        get().restartPreview();
      } finally {
        clearTimeout( timeout );
        set( { flash : false } );
        _capturing = false;
      }
    },

    // ── Accept pending shot ────────────────────────
    acceptPending : async ( replaceIndex ) => {
      const { pending, phase, photos, frames, frameKey } = get();
      if ( !pending || phase !== "reviewing" ) return;
      if ( _capturing ) return;
      _capturing = true;

      set( { error : null } );
      try {
        const frame = frames.find( ( f ) => f.key === frameKey ) ?? frames[0];
        const photoCount = frame?.photoCount ?? 0;

        const nextPhotos = [...photos];
        if ( replaceIndex !== undefined && replaceIndex < photos.length ) {
          nextPhotos[replaceIndex] = pending;
        } else {
          nextPhotos.push( pending );
        }
        set( { photos : nextPhotos, pending : null } );

        if ( nextPhotos.length >= photoCount ) {
          set( { phase : "adjusting" } );
        } else {
          set( { phase : "idle", streamKey : newId() } );
        }
      } catch ( err ) {
        set( {
          error : errorMessage( err, "Accept failed" ),
          phase : "error",
        } );
        get().restartPreview();
      } finally {
        _capturing = false;
      }
    },

    // ── Compose strip with custom adjustments ──────
    composeStripWithAdjustments : async ( adjustments ) => {
      const { photos, frameKey, sessionId } = get();
      set( { phase : "composing", error : null } );
      try {
        const activeSession = sessionId || newId();
        const composed = await composeStrip( {
          sessionId : activeSession,
          frame     : frameKey,
          files     : photos.map( ( s ) => s.file ),
          adjustments,
        } );
        set( {
          strip     : composed.url,
          phase     : "done",
          step      : 3,
          sessionId : activeSession,
        } );
      } catch ( err ) {
        set( {
          error : errorMessage( err, "Compose failed" ),
          phase : "error",
        } );
      }
    },

    // ── Store generated GIF / video URLs ──────────
    setGifUrl       : ( url ) => set( { gifUrl : url } ),
    setVideoUrl     : ( url ) => set( { videoUrl : url } ),
    setLoopVideoUrl : ( url ) => set( { loopVideoUrl : url } ),

    // ── Store a countdown video clip ───────────────
    addCountdownClip : ( clip ) => {
      set( ( s ) => ( {
        countdownClips : [...s.countdownClips, clip],
      } ) );
    },

    // ── Session id ─────────────────────────────────
    // An empty id is rejected by the capture routes, which silently lost the
    // first countdown clip of every session: its recording starts on the shutter
    // tap, before the first `takeShot()` has created the session.
    ensureSessionId : () => {
      const { sessionId } = get();
      if ( sessionId ) return sessionId;

      const active = newId();
      set( { sessionId : active } );

      return active;
    },

    // ── Timer controls ─────────────────────────────
    setTimerEnabled     : ( enabled ) => set( { timerEnabled : enabled } ),
    setTimerSecondsLeft : ( seconds ) => set( { timerSecondsLeft : seconds } ),
    setDisableCountdown : ( disabled ) => set( { disableCountdown : disabled } ),

    // ── Per-booth settings ─────────────────────────
    // The server owns the idle step timer toggle, so mirror it here.
    setSettings : ( settings ) => set( {
      settings,
      timerEnabled : settings.timerEnabled,
    } ),

    resetTimer : () => {
      const { step } = get();
      const timeout = STEP_TIMEOUTS[step] ?? 30;
      set( { timerSecondsLeft : timeout } );
    },

    // ── Filter ─────────────────────────────────────
    setGlobalFilter : ( filter ) => set( { globalFilter : filter } ),

    // ── Framing ────────────────────────────────────
    setAdjustments : ( adjustments ) => set( { adjustments } ),

    patchAdjustment : ( index, patch ) => set( ( s ) => {
      const next = s.adjustments.slice();
      next[index] = { ...next[index], ...patch };

      return { adjustments : next };
    } ),

    resetAdjustment : ( index ) => set( ( s ) => {
      const next = s.adjustments.slice();
      next[index] = { x : 0, y : 0, zoom : 1.0, filter : 'none' };

      return { adjustments : next };
    } ),

    // ── Payment ────────────────────────────────────
    setPayment : ( payment ) => set( payment ),
  } ),
);
