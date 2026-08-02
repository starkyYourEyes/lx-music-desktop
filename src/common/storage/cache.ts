export interface MusicUrlKeyV1 {
  provider: string
  accountScope: string
  sourceTrackId: string
  quality: string
}

export interface MusicUrlGetInputV1 extends MusicUrlKeyV1 {
  nowMs: number
}

export interface MusicUrlPutInputV1 extends MusicUrlGetInputV1 {
  url: string
  providerExpiresAtMs?: number
}

export interface TrackIdentityV1 {
  originalProvider: string
  originalTrackId: string
}

export interface OtherSourcesGetInputV1 extends TrackIdentityV1 {
  nowMs: number
}

export interface OtherSourcesPutInputV1 extends OtherSourcesGetInputV1 {
  candidates: LX.Music.MusicInfoOnline[]
}

export interface MusicUrlAccountInvalidationV1 {
  provider: string
  accountScope: string
}

export interface MusicUrlSourceInvalidationV1 {
  provider: string
}

export type CacheDiagnosticCodeV1 =
  | 'cache_phase3_prerequisite_invalid'
  | 'cache_target_invalid'
  | 'cache_open_failed'
  | 'cache_schema_invalid'
  | 'cache_integrity_failed'
  | 'cache_operation_failed'
  | 'cache_close_failed'
  | 'cache_delete_failed'
  | 'cache_reopen_failed'
  | 'cache_capacity_unavailable'

export type CacheReadResultV1<T> =
  | { status: 'hit', value: T }
  | { status: 'miss' }
  | { status: 'unavailable', code: CacheDiagnosticCodeV1 }

export type CacheWriteResultV1 =
  | { status: 'stored' }
  | { status: 'unavailable', code: CacheDiagnosticCodeV1 }
