import type fs from 'node:fs'
import type path from 'node:path'
import type { CacheDiagnosticCodeV1 } from '../../common/storage/cache'
import type { SessionCacheCategory, SessionClearResult, SessionRegistry } from './sessionRegistry'
import { createCacheArtifactInventory } from './cacheArtifactInventory'

export interface CacheClearComponentResult {
  component: 'cache-db' | 'chromium-http' | 'chromium-cache-storage' | 'chromium-code'
  key: string
  status: 'cleared' | 'failed'
  code?: CacheDiagnosticCodeV1 | 'session_cache_clear_failed'
}

export interface CacheClearResult {
  status: 'cleared' | 'degraded'
  generation: number
  components: readonly CacheClearComponentResult[]
}

export interface CacheManager {
  // eslint-disable-next-line @typescript-eslint/method-signature-style -- Preserve the exported method contract.
  clearAll(): Promise<CacheClearResult>
}

interface CacheResetWorker {
  // eslint-disable-next-line @typescript-eslint/method-signature-style -- Preserve the worker method contract.
  beginCacheReset(): Promise<LX.DBService.CacheResetLease>
  // eslint-disable-next-line @typescript-eslint/method-signature-style -- Preserve method parameter bivariance in the worker contract.
  finishCacheReset(input: LX.DBService.CacheResetLease): Promise<LX.DBService.CacheOpenResult>
}

interface CacheManagerOptions {
  cacheRoot: string
  worker: CacheResetWorker
  sessionRegistry: Pick<SessionRegistry, 'clearRegisteredCaches'>
  publishGeneration: (generation: number) => void
  fileSystem?: typeof fs
  pathModule?: typeof path
}

const categoryComponents: Record<SessionCacheCategory, CacheClearComponentResult['component']> = {
  cache: 'chromium-http',
  'cache-storage': 'chromium-cache-storage',
  'code-cache': 'chromium-code',
}

const sessionComponent = (result: SessionClearResult): CacheClearComponentResult => result.status == 'cleared'
  ? { component: categoryComponents[result.category], key: result.key, status: 'cleared' }
  : {
      component: categoryComponents[result.category],
      key: result.key,
      status: 'failed',
      code: 'session_cache_clear_failed',
    }

const failedSessionBarrier = (): CacheClearComponentResult[] =>
  (Object.entries(categoryComponents) as Array<[SessionCacheCategory, CacheClearComponentResult['component']]>).map(([, component]) => ({
    component,
    key: 'session-registry',
    status: 'failed',
    code: 'session_cache_clear_failed',
  }))

export const createCacheManager = ({
  cacheRoot,
  worker,
  sessionRegistry,
  publishGeneration,
  fileSystem,
  pathModule,
}: CacheManagerOptions): CacheManager => {
  const inventory = createCacheArtifactInventory({ cacheRoot, fileSystem, pathModule })
  let generation = 0
  let activeClear: Promise<CacheClearResult> | null = null

  const runClear = async(): Promise<CacheClearResult> => {
    let lease: LX.DBService.CacheResetLease
    try {
      lease = await worker.beginCacheReset()
    } catch {
      return {
        status: 'degraded',
        generation,
        components: [{ component: 'cache-db', key: 'cache.db', status: 'failed', code: 'cache_close_failed' }],
      }
    }

    const components: CacheClearComponentResult[] = []
    let reopenResult: LX.DBService.CacheOpenResult | null = null
    try {
      const artifactResult = inventory.clearOwnedArtifacts()
      components.push(artifactResult.status == 'cleared'
        ? { component: 'cache-db', key: 'cache.db', status: 'cleared' }
        : { component: 'cache-db', key: 'cache.db', status: 'failed', code: artifactResult.code })
      try {
        components.push(...(await sessionRegistry.clearRegisteredCaches()).map(sessionComponent))
      } catch {
        components.push(...failedSessionBarrier())
      }
    } finally {
      try {
        reopenResult = await worker.finishCacheReset(lease)
      } catch {
        reopenResult = { status: 'unavailable', schemaVersion: null, diagnostic: 'cache_reopen_failed' }
      }
    }

    if (reopenResult.status == 'unavailable') {
      const database = components.find(component => component.component == 'cache-db')
      if (database != null) {
        database.status = 'failed'
        database.code = reopenResult.diagnostic ?? 'cache_reopen_failed'
      }
    } else if (reopenResult.status == 'created' || reopenResult.status == 'recreated') {
      generation++
      try { publishGeneration(generation) } catch {}
    }

    return {
      status: components.some(component => component.status == 'failed') ? 'degraded' : 'cleared',
      generation,
      components,
    }
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- Preserve the shared active-clear promise identity.
  const clearAll = (): Promise<CacheClearResult> => {
    if (activeClear != null) return activeClear
    const operation = runClear()
    activeClear = operation
    void operation.finally(() => {
      if (activeClear === operation) activeClear = null
    })
    return operation
  }

  return { clearAll }
}
