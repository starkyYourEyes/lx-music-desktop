declare namespace LX {
  namespace DBService {

    interface MusicInfo {
      id: string
      listId: string
      name: string
      singer: string
      interval: string | null
      source: LX.Music.MusicInfo['source']
      meta: string
      order: number
    }

    interface CachePhasePrerequisiteV1 {
      version: 1
      markerName: 'legacy_data_v1.cross_artifact_complete'
      sourceSha256: string
      completedAtMs: number
    }

    interface CachePhase4Result {
      schemaVersion: 6 | 7 | 8 | 9
      typedOwnershipVerified: boolean
    }

    type CacheLifecycleState = 'closed' | 'opening' | 'ready' | 'unavailable' | 'resetting'

    type CacheDiagnosticCode =
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

    interface CacheOpenResult {
      status: 'ready' | 'created' | 'recreated' | 'unavailable'
      schemaVersion: 2 | null
      diagnostic: CacheDiagnosticCode | null
    }

    interface CacheResetLease {
      resetId: string
    }

    /* eslint-disable @typescript-eslint/method-signature-style -- Preserve the worker lifecycle interface contract. */
    interface CacheWorkerLifecycle {
      openCacheDatabase(): Promise<CacheOpenResult>
      beginCacheReset(): Promise<CacheResetLease>
      finishCacheReset(input: CacheResetLease): Promise<CacheOpenResult>
      abortCacheReset(input: CacheResetLease): Promise<void>
      getCacheLifecycleState(): Promise<CacheLifecycleState>
    }
    /* eslint-enable @typescript-eslint/method-signature-style */

    type CacheReadResult<T> = { status: 'hit', value: T } | { status: 'miss' } | { status: 'unavailable', code: CacheDiagnosticCode }
    type CacheWriteResult = { status: 'stored' } | { status: 'unavailable', code: CacheDiagnosticCode }

    interface MusicInfoOrder {
      listId: string
      musicInfoId: string
      order: number
    }

    interface MusicInfoQuery {
      listId: string
    }

    interface MusicInfoRemove {
      listId: string
      id: string
    }

    interface ListMusicInfoQuery {
      listId: string
      musicInfoId: string
    }

    interface UserListInfo {
      id: string
      name: string
      source?: LX.OnlineSource
      sourceListId?: string
      position: number
      locationUpdateTime: number | null
    }

    type Lyricnfo = {
      id: string
      type: 'lyric'
      text: string
      source: 'raw' | 'edited'
    } | {
      id: string
      type: keyof Omit<LX.Music.LyricInfo, 'lyric'>
      text: string | null
      source: 'raw' | 'edited'
    }

    interface DownloadMusicInfo {
      id: string
      isComplate: 0 | 1
      status: LX.Download.DownloadTaskStatus
      statusText: string
      progress_downloaded: number
      progress_total: number
      url: string | null
      quality: LX.Quality
      ext: LX.Download.FileExt
      fileName: string
      filePath: string
      musicInfo: string
      position: number
    }

    interface DislikeInfo {
      // type: 'music'
      content: string
      // meta: string | null
    }

  }
}
