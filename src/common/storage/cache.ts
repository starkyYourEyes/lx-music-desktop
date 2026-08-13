export const STORAGE_CACHE_GENERATION_EVENT = 'storage_cache_generation_v1' as const

export type StorageCacheGenerationV1 = number

export type PersistentMusicUrlProviderV1 = 'wy' | 'tx'

export interface MusicUrlAuthorizationRequestV1 {
  provider: PersistentMusicUrlProviderV1
}

export interface MusicUrlAuthorizationV1 {
  version: 1
  provider: PersistentMusicUrlProviderV1
  accountScope: string
  generation: number
}

export interface AuthorizedMusicUrlKeyV1 {
  authorization: MusicUrlAuthorizationV1
  sourceTrackId: string
  quality: string
}

export interface AuthorizedMusicUrlGetInputV1 extends AuthorizedMusicUrlKeyV1 {
  nowMs: number
}

export interface MusicUrlCacheValueV1 {
  url: string
  reportedQuality: LX.Quality | null
}

export interface AuthorizedMusicUrlPutInputV1 extends AuthorizedMusicUrlGetInputV1 {
  url: string
  reportedQuality?: LX.Quality
  providerExpiresAtMs?: number
}

export type AuthorizedMusicUrlDeleteInputV1 = AuthorizedMusicUrlKeyV1

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
  reportedQuality?: LX.Quality
  providerExpiresAtMs?: number
}

export type MusicUrlDeleteInputV1 = MusicUrlKeyV1

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

export interface CachePruneInputV1 {
  nowMs: number
  batchSize: number
}

export interface CachePruneReportV1 {
  status: 'completed'
  musicUrls: {
    rowsBefore: number
    rowsAfter: number
    deletedRows: number
    expiredKeys: string[]
    evictedKeys: string[]
  }
  rawLyrics: {
    rowsBefore: number
    rowsAfter: number
    ownerGroupsBefore: number
    ownerGroupsAfter: number
    bytesBefore: number
    bytesAfter: number
    deletedRows: number
    deletedOwners: number
    deletedBytes: number
    expiredOwners: string[]
    evictedOwners: string[]
  }
  otherSources: {
    rowsBefore: number
    rowsAfter: number
    ownerGroupsBefore: number
    ownerGroupsAfter: number
    bytesBefore: number
    bytesAfter: number
    deletedRows: number
    deletedOwners: number
    deletedBytes: number
    expiredOwners: string[]
    evictedOwners: string[]
  }
}

export type CachePruneResultV1 = CachePruneReportV1 | {
  status: 'unavailable'
  code: CacheDiagnosticCodeV1
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

export type MusicUrlInvalidationResultV1 =
  | { status: 'completed', deletedRows: number }
  | { status: 'unavailable', code: CacheDiagnosticCodeV1 }

export type CacheReadResultV1<T> =
  | { status: 'hit', value: T }
  | { status: 'miss' }
  | { status: 'unavailable', code: CacheDiagnosticCodeV1 }

export type CacheWriteResultV1 =
  | { status: 'stored' }
  | { status: 'unavailable', code: CacheDiagnosticCodeV1 }
