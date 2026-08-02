import {
  advanceAppDatabase,
  close as closeAppDatabase,
  getDatabaseHealth,
  init,
} from './db'
import { exposeWorker } from '../utils/worker'
import { list, lyric, musicUrlCache, otherSourceCache, download, dislike_list, account_profile, app_state, playback, phase3, phase4, cacheLifecycle } from './modules/index'
import type { CachePhase4Result, CachePhasePrerequisiteV1 } from '../../../common/storage/cachePhase'
import { closeCacheDatabase } from './cacheDb'

export { advanceAppDatabase, init }

const close = async(): Promise<void> => {
  let failure: unknown | null = null
  try {
    await closeCacheDatabase()
  } catch (error) {
    failure = error
  }
  try {
    closeAppDatabase()
  } catch (error) {
    failure ??= error
  }
  if (failure instanceof Error) throw failure
  if (failure != null) throw new Error('database_close_failed')
}

const common = {
  init,
  advanceAppDatabase,
  close,
  getDatabaseHealth,
}

exposeWorker(Object.assign(common, list, lyric, musicUrlCache, otherSourceCache, download, dislike_list, account_profile, app_state, playback, phase3, phase4, cacheLifecycle))

export type workerDBSeriveTypes = typeof common
  & typeof list
  & typeof lyric
  & typeof musicUrlCache
  & typeof otherSourceCache
  & typeof download
  & typeof dislike_list
  & typeof account_profile
  & typeof app_state
  & typeof playback
  & typeof phase3
  & typeof phase4
  & typeof cacheLifecycle

export type WorkerCachePhasePrerequisite = CachePhasePrerequisiteV1
export type WorkerCachePhase4Result = CachePhase4Result
