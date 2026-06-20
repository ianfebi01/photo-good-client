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
  3 : 30,   // Result — 30s idle
};

/** Show "Are you still there?" warning this many seconds before auto-reset. */
export const TIMEOUT_WARNING_SECONDS = 5;

const newId = () => Math.random().toString( 36 ).slice( 2, 10 );

// Module-level lock — avoids re-render on every capture tick
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

export const useBoothStore = create<BoothState>()(
  persist(
    ( set, get ) => ( {
      // ── Initial state ──────────────────────────────
      started        : false,
      frameKey       : DEFAULT_FRAME_KEY,
      sessionId      : "",
      photos         : [],
      strip          : null,
      gifUrl         : null,
      videoUrl       : null,
      loopVideoUrl   : null,
      countdownClips : [],
      phase          : "idle",
      pending        : null,
      flash          : false,
      streamKey      : "live",
      error          : null,
      uploadOpen     : false,
      frames         : FALLBACK_FRAMES,
      status         : null,
      step           : 0,

      // Timer
      timerEnabled     : true,
      timerSecondsLeft : null,

      // ── Setters ────────────────────────────────────
      setStatus : ( status ) => set( { status } ),
      setFrames : ( frames ) => {
        const currentKey = get().frameKey;
        const keyExists = frames.some( f => f.key === currentKey );
        set( { 
          frames, 
          frameKey : keyExists ? currentKey : ( frames[0]?.key ?? "" ) 
        } );
      },
      setUploadOpen : ( uploadOpen ) => set( { uploadOpen } ),

      restartPreview : () => set( { streamKey : newId() } ),

      // ── Begin capture session ──────────────────────
      start : () => set( { started : true, step : 1 } ),

      // ── Move to filter step ────────────────────────
      goToFilter : () => set( { step : 2 } ),

      // ── Frame selection ────────────────────────────
      selectFrame : ( key ) => {
        if ( key === get().frameKey ) return;
        _capturing = false;
        set( {
          frameKey       : key,
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
        } );
        get().restartPreview();
      },

      // ── Session reset ──────────────────────────────
      reset : () => {
        _capturing = false;
        const frames = get().frames;
        set( {
          started          : false,
          sessionId        : "",
          phase            : "idle",
          photos           : [],
          pending          : null,
          strip            : null,
          gifUrl           : null,
          videoUrl         : null,
          loopVideoUrl     : null,
          countdownClips   : [],
          error            : null,
          flash            : false,
          step             : 0,
          frameKey         : frames[0]?.key ?? DEFAULT_FRAME_KEY,
          timerSecondsLeft : null,
        } );
        get().restartPreview();
      },

      // ── Retake a pending shot ──────────────────────
      retakePending : () => {
        const { phase, pending } = get();
        if ( phase !== "reviewing" || !pending ) return;
        set( { pending : null, phase : "idle" } );
        get().restartPreview();
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
        const timeout = setTimeout( () => controller.abort(), 30_000 );

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
          const message = err instanceof Error
            ? ( err.name === "AbortError" ? "Capture timed out" : err.message )
            : "Something went wrong";
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
            set( { phase : "idle" } );
            get().restartPreview();
          }
        } catch ( err ) {
          set( {
            error : err instanceof Error ? err.message : "Accept failed",
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
          set( { strip : composed.url, phase : "done", step : 3 } );
        } catch ( err ) {
          set( {
            error : err instanceof Error ? err.message : "Compose failed",
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
        const step = get().step;
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
