import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import {
  type ClientFrame,
  DEFAULT_FRAME_KEY,
  FALLBACK_FRAMES,
} from "@/lib/photobooth/frames.client";
import { captureShot, composeStrip } from "@/lib/photobooth/frames.query";

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
  0 : 30,   // Select Frame — 30s idle
  1 : 120,  // Capture — 2min idle
  2 : 60,   // Filter — 60s idle
  3 : 60,   // Result — 60s idle
};

/** Show "Are you still there?" warning this many seconds before auto-reset. */
export const TIMEOUT_WARNING_SECONDS = 5;

/** Timeout for individual capture requests (ms). */
const CAPTURE_TIMEOUT_MS = 30_000;

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

  // ── Timer ──────────────────────────────────────────
  /** Whether the step idle timer is enabled (e.g., kiosk mode). */
  timerEnabled: boolean;
  /** Seconds remaining on the current step timer. */
  timerSecondsLeft: number | null;

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
  composeStripWithAdjustments: ( adjustments: { x: number; y: number; zoom: number; filter: string }[] ) => Promise<void>;
  setGifUrl: ( url: string | null ) => void;
  setVideoUrl: ( url: string | null ) => void;
  setLoopVideoUrl: ( url: string | null ) => void;
  addCountdownClip: ( clip: Shot ) => void;
  setTimerEnabled: ( enabled: boolean ) => void;
  setTimerSecondsLeft: ( seconds: number | null ) => void;
  resetTimer: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────

/** Fields that are cleared when a session resets or a new frame is selected. */
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
    step           : 0,
  };
}

// ── Store ─────────────────────────────────────────────────────────

export const useBoothStore = create<BoothState>()(
  persist(
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
      timerEnabled     : true,
      timerSecondsLeft : null,

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
          timerSecondsLeft : null,
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

      // ── Timer controls ─────────────────────────────
      setTimerEnabled     : ( enabled ) => set( { timerEnabled : enabled } ),
      setTimerSecondsLeft : ( seconds ) => set( { timerSecondsLeft : seconds } ),
      resetTimer          : () => {
        const { step } = get();
        const timeout = STEP_TIMEOUTS[step] ?? 30;
        set( { timerSecondsLeft : timeout } );
      },
    } ),
    {
      name       : "booth-store",
      storage    : createJSONStorage( () => localStorage ),
      partialize : ( state ) => ( {
        started        : state.started,
        frameKey       : state.frameKey,
        sessionId      : state.sessionId,
        photos         : state.photos,
        strip          : state.strip,
        step           : state.step,
        gifUrl         : state.gifUrl,
        videoUrl       : state.videoUrl,
        loopVideoUrl   : state.loopVideoUrl,
        countdownClips : state.countdownClips,
      } ),
    },
  ),
);
