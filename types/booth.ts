/** A slot defines where a captured photo is placed on a frame. */
export type BoothFrameSlot = {
  left : number
  top : number
  width : number
  height : number
}

/** A frame returned by the booth-facing frames API. */
export type BoothFrame = {
  key : string
  label : string
  imageUrl : string
  width : number
  height : number
  slots : BoothFrameSlot[]
  builtIn : boolean
}

/** GET /api/booth/frames response. */
export type BoothFramesResponse = {
  frames : BoothFrame[]
}

// ── Client settings ───────────────────────────────────────────────

/**
 * Per-booth settings the booth client fetches on startup.
 *
 * These only control which steps the client renders — they never disable the
 * underlying APIs, so a request still succeeds even when its step is hidden.
 */
export type BoothClientSettings = {
  /** Show the payment step before a session starts. */
  paymentEnabled : boolean
  /**
   * Frame keys hidden from this booth. An empty list means every frame is
   * available, including frames uploaded after this response was fetched.
   *
   * `GET /api/booth/frames` already filters the catalog by this list, so the
   * client can render whatever it receives without applying the deny-list
   * itself. Skip the frame picker when fewer than two frames come back.
   */
  disabledFrameKeys : string[]
  /** Show the countdown timer before each capture. */
  timerEnabled : boolean
  /** Show the "photo X of Y" capture counter. */
  captureCounterEnabled : boolean
}

/** GET /api/booth/settings response. */
export type BoothSettingsResponse = {
  settings : BoothClientSettings
}

// ── Media upload ──────────────────────────────────────────────────

/** POST /api/booth/media response. */
export type BoothMedia = {
  id : string
  filename : string
  url : string
  mime_type : string
  size_bytes : number
  created_at : string
}

// ── Result creation ───────────────────────────────────────────────

/** Media types for results. */
export type BoothMediaType = 'strip' | 'image' | 'mashup' | 'countdown' | 'loop'

/** A single item in the POST /api/booth/results request body. */
export type BoothResultItem = {
  mediaId : string
  type : BoothMediaType
}

/** POST /api/booth/results request (JSON body). */
export type BoothResultCreateRequest = {
  sessionId : string
  frameKey? : string
  items : BoothResultItem[]
}

/** A result row from app_results (joined with app_media). */
export type BoothResult = {
  id : string
  booth_id : string
  session_id : string | null
  media_id : string
  media_type : BoothMediaType
  frame_key : string | null
  created_at : string
  expires_at : string
}

/** POST /api/booth/results success response (201). */
export type BoothResultCreateResponse = {
  sessionId : string
  results : BoothResult[]
  booth : {
    id : string
    name : string
  }
}

/** GET /api/booth/results?sessionId=… response. */
export type BoothResultsResponse = {
  sessionId : string
  boothName : string
  results : {
    id : string
    mediaType : BoothMediaType
    url : string
    frameKey : string | null
    createdAt : string
    expiresAt : string
  }[]
}

/** Generic error. */
export type BoothApiError = {
  error : string
}
