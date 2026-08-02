import {
  beginCacheReset,
  finishCacheReset,
  getCacheLifecycleState,
  openCacheDatabase as runOpenCacheDatabase,
} from '../../cacheDb'
import { scheduleIdleCachePrune } from './prune'

const openCacheDatabase = async() => {
  const result = await runOpenCacheDatabase()
  if (result.status == 'ready' || result.status == 'created' || result.status == 'recreated') {
    scheduleIdleCachePrune()
  }
  return result
}

export {
  openCacheDatabase,
  beginCacheReset,
  finishCacheReset,
  getCacheLifecycleState,
}

export { cachePrune } from './prune'
