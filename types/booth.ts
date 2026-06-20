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
