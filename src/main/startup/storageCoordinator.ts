import type { DatabaseStartupResult } from '../worker/dbService/db'
import type { RunStateStore } from './runState'

export type StorageRecoveryTarget =
  | {
    kind: 'database'
    databasePath: string
    backupPath: string | null
    diagnostics: string[]
  }
  | {
    kind: 'legacy-json'
    sourcePath: string
    candidatePreviousPath: string | null
  }
  | {
    kind: 'external-migration'
    component: 'credentials' | 'cache'
    affectedPath: string | null
    diagnostics: string[]
  }

export type StorageStartupOutcome =
  | { status: 'ready', schemaVersion: number }
  | { status: 'recovery', reason: string, target: StorageRecoveryTarget }
  | { status: 'fatal', reason: string }

export interface StorageCoordinator {
  start: () => Promise<StorageStartupOutcome>
  registerShutdownFlusher: (name: string, flush: () => Promise<void>) => () => void
  shutdown: () => Promise<void>
}

type DatabaseReadyResult = Extract<DatabaseStartupResult, { status: 'ready' }>
type RecoveryOutcome = Extract<StorageStartupOutcome, { status: 'recovery' }>

interface ShutdownDiagnostic {
  code: 'shutdown_flush_timeout'
  flusherNames: string[]
}

export interface StorageCoordinatorDependencies {
  runState: RunStateStore
  initDatabase: (previousShutdownWasClean: boolean) => Promise<DatabaseStartupResult>
  closeDatabase: () => Promise<void> | void
  runMigrationHooks: (result: DatabaseReadyResult) => Promise<RecoveryOutcome | undefined>
  initSettings: () => Promise<void>
  registerModules: () => void
  appInited: () => void
  showRecovery: (outcome: RecoveryOutcome) => Promise<void>
  flushStores: () => Promise<void>
  reportShutdownFailure?: (diagnostic: ShutdownDiagnostic) => void
  shutdownTimeoutMs?: number
}

const SHUTDOWN_TIMEOUT_MS = 3_000

const failureCode = (error: unknown, fallback: string): string => {
  if (error != null && typeof error == 'object' && 'code' in error && typeof error.code == 'string') {
    if (/^[a-z0-9_.-]{1,100}$/i.test(error.code)) return error.code
  }
  return fallback
}

const errorWithCode = (code: string): Error => {
  const error = new Error(code)
  error.name = code
  return error
}

const startupCancelled = (): StorageStartupOutcome => ({
  status: 'fatal',
  reason: 'storage_startup_cancelled',
})

const databaseRecovery = (
  result: Extract<DatabaseStartupResult, { status: 'recovery' }>,
): RecoveryOutcome => ({
  status: 'recovery',
  reason: result.reason,
  target: {
    kind: 'database',
    databasePath: result.databasePath,
    backupPath: result.backupPath,
    diagnostics: [...result.diagnostics],
  },
})

export const createStorageCoordinator = (
  dependencies: StorageCoordinatorDependencies,
): StorageCoordinator => {
  const shutdownFlushers = new Map<string, () => Promise<void>>()
  const shutdownTimeoutMs = dependencies.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS
  let startPromise: Promise<StorageStartupOutcome> | null = null
  let shutdownPromise: Promise<void> | null = null
  let runHasStarted = false
  let startupReachedReady = false
  let shutdownRequested = false

  // Repeated callers must receive the exact cached startup Promise.
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  const start = (): Promise<StorageStartupOutcome> => {
    if (startPromise != null) return startPromise
    startPromise = (async() => {
      try {
        if (shutdownRequested) return startupCancelled()
        const previousShutdownWasClean = await dependencies.runState.begin()
        runHasStarted = true
        if (shutdownRequested) return startupCancelled()
        const database = await dependencies.initDatabase(previousShutdownWasClean)
        if (shutdownRequested) return startupCancelled()
        if (database.status == 'recovery') {
          const outcome = databaseRecovery(database)
          await dependencies.showRecovery(outcome)
          return outcome
        }

        const migrationOutcome = await dependencies.runMigrationHooks(database)
        if (shutdownRequested) return startupCancelled()
        if (migrationOutcome?.status == 'recovery') {
          await dependencies.showRecovery(migrationOutcome)
          return migrationOutcome
        }

        await dependencies.initSettings()
        if (shutdownRequested) return startupCancelled()
        dependencies.registerModules()
        dependencies.appInited()
        startupReachedReady = true
        return { status: 'ready', schemaVersion: database.schemaVersion }
      } catch (error) {
        return { status: 'fatal', reason: failureCode(error, 'storage_startup_failed') }
      }
    })()
    return startPromise
  }

  const registerShutdownFlusher = (name: string, flush: () => Promise<void>): (() => void) => {
    shutdownFlushers.set(name, flush)
    return () => {
      if (shutdownFlushers.get(name) == flush) shutdownFlushers.delete(name)
    }
  }

  const runFlushers = async(): Promise<{ timedOut: string[], failed: boolean }> => {
    const entries = [...shutdownFlushers.entries()]
    if (!entries.length) return { timedOut: [], failed: false }

    const pending = new Set(entries.map(([name]) => name))
    let failed = false
    const complete = Promise.all(entries.map(async([name, flush]) => {
      try {
        await flush()
      } catch {
        failed = true
      } finally {
        pending.delete(name)
      }
    }))
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const timeoutResult = new Promise<void>(resolve => {
      timeout = setTimeout(() => {
        timedOut = true
        resolve()
      }, shutdownTimeoutMs)
    })
    await Promise.race([complete, timeoutResult])
    if (timeout != null) clearTimeout(timeout)
    return { timedOut: timedOut ? [...pending] : [], failed }
  }

  const waitForStartup = async(): Promise<boolean> => {
    if (startPromise == null) return true
    let timeout: ReturnType<typeof setTimeout> | null = null
    const completed = await Promise.race([
      startPromise.then(() => true, () => true),
      new Promise<boolean>(resolve => {
        timeout = setTimeout(() => {
          resolve(false)
        }, shutdownTimeoutMs)
      }),
    ])
    if (timeout != null) clearTimeout(timeout)
    return completed
  }

  // Repeated callers must receive the exact cached shutdown Promise.
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  const shutdown = (): Promise<void> => {
    if (shutdownPromise != null) return shutdownPromise
    shutdownPromise = (async() => {
      shutdownRequested = true
      const startupCompleted = await waitForStartup()
      const flusherResult = await runFlushers()
      let failure: Error | null = startupCompleted ? null : errorWithCode('shutdown_startup_timeout')
      if (flusherResult.timedOut.length) {
        dependencies.reportShutdownFailure?.({
          code: 'shutdown_flush_timeout',
          flusherNames: flusherResult.timedOut,
        })
        failure = errorWithCode('shutdown_flush_timeout')
      } else if (flusherResult.failed) {
        failure = errorWithCode('shutdown_flusher_failed')
      }

      try {
        await dependencies.flushStores()
      } catch (error) {
        failure ??= error instanceof Error ? error : errorWithCode('shutdown_store_flush_failed')
      }
      try {
        await dependencies.closeDatabase()
      } catch (error) {
        failure ??= error instanceof Error ? error : errorWithCode('shutdown_database_close_failed')
      }

      if (failure != null) throw failure
      if (runHasStarted && startupReachedReady) await dependencies.runState.markClean()
    })()
    return shutdownPromise
  }

  return { start, registerShutdownFlusher, shutdown }
}
