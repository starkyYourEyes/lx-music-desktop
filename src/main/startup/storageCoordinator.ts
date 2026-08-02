import path from 'node:path'
import fs from 'node:fs/promises'
import {
  parseLocalStateSnapshot,
  parsePlaylistMetadataCommand,
  parseSearchHistoryCommand,
} from '../../common/storage/stateValidation'
import type { DatabaseStartupResult } from '../worker/dbService/db'
import type { AccountRepository } from '../storage/accounts/accountRepository'
import type { CredentialVault } from '../storage/credentials/credentialVault'
import { collectLegacyCredentialInventory } from '../migration/credentials/legacySources'
import type { LegacyDataSourceResult } from '../migration/legacyData/source'
import type { RunStateStore } from './runState'
import type {
  Phase3ActivityEvidence,
  Phase3AttestationPrerequisitesV1,
  Phase3CheckState,
} from '../../common/storage/phase3'
import type { CachePhasePrerequisiteV1 } from '../../common/storage/cachePhase'
import type { Phase3CredentialHealth, Phase3PlaybackSmokeEvidence } from './phase3Attestation'
import type { PortableProfileStartupToken } from '../migration/portableProfile'
import type { RawLyricMigrationResult } from '../migration/cache/rawLyrics'

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

export interface CredentialStartupCheck {
  vaultReadable: boolean
  profileRepositoryReadable: boolean
  activePlaintextSources: string[]
  recoveryPath?: string
}

export interface CredentialStartupCheckOptions {
  dataRoot: string
  vault: Pick<CredentialVault, 'read'> | null | undefined
  profileRepository: Pick<AccountRepository, 'getStatus'> | null | undefined
}

type DatabaseReadyResult = Extract<DatabaseStartupResult, { status: 'ready' }>
type RecoveryOutcome = Extract<StorageStartupOutcome, { status: 'recovery' }>
type Phase2LegacyDataSourceResult = Exclude<LegacyDataSourceResult, { status: 'recovery' }>

interface ShutdownDiagnostic {
  code: 'shutdown_flush_timeout'
  flusherNames: string[]
}

export interface StorageCoordinatorDependencies {
  runState: RunStateStore
  initializeTempLifecycle?: () => Promise<void>
  cleanupTempLifecycle?: () => Promise<void>
  preflightLegacyData?: () => Promise<LegacyDataSourceResult>
  initDatabase: (previousShutdownWasClean: boolean) => Promise<DatabaseStartupResult>
  closeDatabase: () => Promise<void> | void
  runMigrationHooks: (
    result: DatabaseReadyResult,
    legacyData: LegacyDataSourceResult,
  ) => Promise<RecoveryOutcome | undefined>
  runPlaybackActivityMigration?: (
    result: DatabaseReadyResult,
    legacyData: Phase2LegacyDataSourceResult,
  ) => Promise<RecoveryOutcome | Phase3ActivityEvidence | undefined>
  checkCredentials: () => Promise<CredentialStartupCheck>
  verifyPhase2Storage?: (legacyData: Phase2LegacyDataSourceResult) => Promise<void>
  now?: () => number
  interruptStalePlaybackSessions: (input: { nowMs: number }) => Promise<number> | number
  runPlaybackTypedSmoke: () => Promise<Phase3PlaybackSmokeEvidence> | Phase3PlaybackSmokeEvidence
  getPhase3AttestationPrerequisites: () => Promise<Phase3AttestationPrerequisitesV1> | Phase3AttestationPrerequisitesV1
  completePhase3Attestation: (input: {
    completedAtMs: number
    legacySourceState: Phase3CheckState
    credentialHealth: Phase3CredentialHealth
    activity: Phase3ActivityEvidence | null
    prerequisites: Phase3AttestationPrerequisitesV1
    smoke: Phase3PlaybackSmokeEvidence
  }) => Promise<void> | void
  getCachePhasePrerequisite?: () => Promise<CachePhasePrerequisiteV1> | CachePhasePrerequisiteV1
  initializePhase4?: (prerequisite: CachePhasePrerequisiteV1) => Promise<{ schemaVersion: 6 | 7 }> | { schemaVersion: 6 | 7 }
  portableProfileToken?: PortableProfileStartupToken
  acknowledgePortableProfileStartup?: (
    token: PortableProfileStartupToken,
  ) => Promise<{ state: 'typed-only-acknowledged' }> | { state: 'typed-only-acknowledged' }
  initSettings: () => Promise<void>
  registerModules: () => void
  appInited: () => void
  showRecovery: (outcome: RecoveryOutcome) => Promise<void>
  flushStores: () => Promise<void>
  reportShutdownFailure?: (diagnostic: ShutdownDiagnostic) => void
  shutdownTimeoutMs?: number
}

const SHUTDOWN_TIMEOUT_MS = 3_000
const PHASE2_MARKER_NAME = 'legacy_data_v1.phase2_complete' as const

const credentialSourceIdentifiers = {
  'netease-cookie': 'legacy.data.netease-cookie',
  'qq-music-cookie': 'legacy.data.qq-music-cookie',
  'webdav-basic': 'legacy.config.webdav-basic',
  'sync-client': 'legacy.sync.client-key',
  'sync-server-device': 'legacy.sync.server-device-key',
  'legacy-quarantine': 'legacy.credential-quarantine',
} as const

const credentialSourceIdentifierSet = new Set<string>(Object.values(credentialSourceIdentifiers))

const probeVault = (vault: CredentialStartupCheckOptions['vault']): boolean => {
  if (vault == null) return false
  try {
    vault.read({ kind: 'netease-cookie' })
    vault.read({ kind: 'qq-music-cookie' })
    vault.read({ kind: 'webdav-basic' })
    return true
  } catch {
    return false
  }
}

const probeProfileRepository = (repository: CredentialStartupCheckOptions['profileRepository']): boolean => {
  if (repository == null) return false
  try {
    repository.getStatus('netease')
    repository.getStatus('qq_music')
    return true
  } catch {
    return false
  }
}

export const checkCredentialStartup = async({
  dataRoot,
  vault,
  profileRepository,
}: CredentialStartupCheckOptions): Promise<CredentialStartupCheck> => {
  let activePlaintextSources: string[]
  try {
    const inventory = await collectLegacyCredentialInventory(dataRoot)
    activePlaintextSources = Array.from(new Set(
      inventory.credentials.map(source => credentialSourceIdentifiers[source.ref.kind]),
    ))
  } catch {
    return {
      vaultReadable: probeVault(vault),
      profileRepositoryReadable: probeProfileRepository(profileRepository),
      activePlaintextSources: ['legacy.credential-source-scan'],
      recoveryPath: path.join(dataRoot, 'credentials.v1.json'),
    }
  }
  return {
    vaultReadable: probeVault(vault),
    profileRepositoryReadable: probeProfileRepository(profileRepository),
    activePlaintextSources,
  }
}

const failureCode = (error: unknown, fallback: string): string => {
  if (error != null && typeof error == 'object' && 'code' in error && typeof error.code == 'string') {
    if (/^[a-z0-9_.-]{1,100}$/i.test(error.code)) return error.code
  }
  return fallback
}

const errorWithCode = (code: string): Error & { code: string } => {
  const error = new Error(code)
  error.name = code
  return Object.assign(error, { code })
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

const assertPhase2Method = (value: unknown): void => {
  if (typeof value != 'function') throw errorWithCode('phase2_storage_unavailable')
}

const assertPhase2Marker = (marker: unknown, required: boolean): void => {
  if (marker == null) {
    if (required) throw errorWithCode('phase2_storage_unavailable')
    return
  }
  if (typeof marker != 'object' || Array.isArray(marker) || Object.getPrototypeOf(marker) != Object.prototype) {
    throw errorWithCode('phase2_storage_unavailable')
  }
  const value = marker as Record<string, unknown>
  if (value.name != PHASE2_MARKER_NAME ||
    typeof value.sourceSha256 != 'string' || !/^[a-f0-9]{64}$/.test(value.sourceSha256) ||
    !Number.isSafeInteger(value.completedAtMs) || (value.completedAtMs as number) < 0 ||
    typeof value.detailsJson != 'string') {
    throw errorWithCode('phase2_storage_unavailable')
  }
  let details: unknown
  try {
    details = JSON.parse(value.detailsJson)
  } catch {
    throw errorWithCode('phase2_storage_unavailable')
  }
  if (details == null || Array.isArray(details) || typeof details != 'object' ||
    Object.getPrototypeOf(details) != Object.prototype || (details as { version?: unknown }).version !== 1) {
    throw errorWithCode('phase2_storage_unavailable')
  }
}

const verifyProductionPhase2Storage = async(legacyData: Phase2LegacyDataSourceResult): Promise<void> => {
  // Direct coordinator tests inject the verifier and do not initialize the app global.
  if (typeof globalThis.lx == 'undefined') return
  const repository = globalThis.lx.worker?.dbService
  if (repository == null) throw errorWithCode('phase2_storage_unavailable')

  assertPhase2Method(repository.getNonActivityMigrationMarker)
  assertPhase2Method(repository.getLocalState)
  assertPhase2Method(repository.setLocalState)
  assertPhase2Method(repository.getPlaylistMetadata)
  assertPhase2Method(repository.applyPlaylistMetadata)
  assertPhase2Method(repository.getSearchHistory)
  assertPhase2Method(repository.applySearchHistory)

  assertPhase2Marker(
    await repository.getNonActivityMigrationMarker(PHASE2_MARKER_NAME),
    legacyData.status == 'available',
  )
  parseLocalStateSnapshot(await repository.getLocalState())
  const playlistMetadata = await repository.getPlaylistMetadata()
  for (const [playlistId, value] of Object.entries(playlistMetadata)) {
    parsePlaylistMetadataCommand({ version: 1, action: 'upsert', playlistId, value, updatedAtMs: 0 })
  }
  const searchHistory = await repository.getSearchHistory()
  for (const term of searchHistory) {
    parseSearchHistoryCommand({ version: 1, action: 'record', term, usedAtMs: 0 })
  }

  try {
    const settings = JSON.parse(await fs.readFile(path.join(globalThis.lxDataPath, 'config_v2.json'), 'utf8'))
    const { parseSettingsDocument } = await import('../storage/settings/document')
    parseSettingsDocument(settings)
  } catch (error) {
    if (error != null && typeof error == 'object' && 'code' in error && error.code == 'ENOENT') return
    throw error
  }
}

const verifyPhase2Storage = async(
  verifier: StorageCoordinatorDependencies['verifyPhase2Storage'],
  legacyData: Phase2LegacyDataSourceResult,
): Promise<void> => {
  try {
    await (verifier ?? verifyProductionPhase2Storage)(legacyData)
  } catch (error) {
    const gateError = errorWithCode('phase2_storage_unavailable')
    Object.defineProperty(gateError, 'cause', { value: error })
    throw gateError
  }
}

const runPhase3Gate = async(
  dependencies: StorageCoordinatorDependencies,
  legacySourceState: Phase3CheckState,
  credentialHealth: Phase3CredentialHealth,
  activity: Phase3ActivityEvidence | null,
): Promise<void> => {
  try {
    const nowMs = (dependencies.now ?? Date.now)()
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw errorWithCode('phase3_time_invalid')
    await dependencies.interruptStalePlaybackSessions({ nowMs })
    const smoke = await dependencies.runPlaybackTypedSmoke()
    const prerequisites = await dependencies.getPhase3AttestationPrerequisites()
    await dependencies.completePhase3Attestation({
      completedAtMs: nowMs,
      legacySourceState,
      credentialHealth,
      activity,
      prerequisites,
      smoke,
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code == 'string') throw error
    const gateError = errorWithCode('phase3_storage_unavailable')
    Object.defineProperty(gateError, 'cause', { value: error })
    throw gateError
  }
}

const legacyDataRecovery = (
  result: Extract<LegacyDataSourceResult, { status: 'recovery' }>,
): RecoveryOutcome => ({
  status: 'recovery',
  reason: result.reason,
  target: {
    kind: 'legacy-json',
    sourcePath: result.sourcePath,
    candidatePreviousPath: result.candidatePreviousPath,
  },
})

const credentialRecovery = (check: CredentialStartupCheck): RecoveryOutcome | undefined => {
  if (check.vaultReadable && check.profileRepositoryReadable && check.activePlaintextSources.length == 0) return
  const diagnostics: string[] = []
  if (!check.vaultReadable) diagnostics.push('credentials.vault_unreadable')
  if (!check.profileRepositoryReadable) diagnostics.push('credentials.profile_repository_unreadable')
  for (const source of Array.from(new Set(check.activePlaintextSources))) {
    diagnostics.push(source == 'legacy.credential-source-scan'
      ? 'credentials.source_scan_failed'
      : credentialSourceIdentifierSet.has(source)
        ? `credentials.plaintext_source:${source}`
        : 'credentials.plaintext_source:unknown')
  }
  return {
    status: 'recovery',
    reason: 'credential_startup_check_failed',
    target: {
      kind: 'external-migration',
      component: 'credentials',
      affectedPath: check.recoveryPath ?? null,
      diagnostics,
    },
  }
}

const fixedCredentialHealth = (check: CredentialStartupCheck): Phase3CredentialHealth => {
  if (!check.vaultReadable || !check.profileRepositoryReadable || check.activePlaintextSources.length != 0) {
    throw errorWithCode('credential_startup_check_failed')
  }
  return {
    version: 1,
    status: 'ready',
    vaultReadable: true,
    profileRepositoryReadable: true,
    plaintextSourcesAbsent: true,
  }
}

interface ProductionCacheLifecycle {
  getCachePhasePrerequisite: () => Promise<CachePhasePrerequisiteV1> | CachePhasePrerequisiteV1
  openCacheDatabase: () => Promise<{
    status: 'ready' | 'created' | 'recreated' | 'unavailable'
    schemaVersion: 1 | null
    diagnostic: string | null
  }>
  migrateRawLyrics?: (input: { nowMs: number }) => Promise<RawLyricMigrationResult> | RawLyricMigrationResult
}

const cacheDiagnosticCodes = new Set([
  'cache_target_invalid',
  'cache_open_failed',
  'cache_schema_invalid',
  'cache_integrity_failed',
  'cache_operation_failed',
  'cache_close_failed',
  'cache_delete_failed',
  'cache_reopen_failed',
  'cache_capacity_unavailable',
])

const getProductionCacheLifecycle = (): ProductionCacheLifecycle | null => {
  if (typeof globalThis.lx == 'undefined') return null
  const repository = globalThis.lx.worker?.dbService
  if (repository == null || typeof repository.getCachePhasePrerequisite != 'function' ||
    typeof repository.openCacheDatabase != 'function') {
    throw errorWithCode('cache_phase4_result_invalid')
  }
  return repository
}

const isValidRawLyricMigrationResult = (value: unknown): boolean => {
  if (value == null || typeof value != 'object' || Array.isArray(value) || Object.getPrototypeOf(value) != Object.prototype) return false
  const result = value as Record<string, unknown>
  if (result.status == 'unavailable') return Object.keys(result).length == 2 && typeof result.code == 'string' && cacheDiagnosticCodes.has(result.code)
  if (result.status != 'complete' && result.status != 'already-complete') return false
  const fields = ['sourceRows', 'sourceOwnerGroups', 'skippedInvalidRows', 'targetRows', 'targetOwnerGroups']
  return Object.keys(result).length == 8 && fields.every(field => Number.isSafeInteger(result[field]) && (result[field] as number) >= 0) &&
    typeof result.sourceSha256 == 'string' && typeof result.targetSha256 == 'string' &&
    /^[a-f0-9]{64}$/.test(result.sourceSha256) && result.sourceSha256 == result.targetSha256 &&
    result.sourceRows == result.targetRows && result.sourceOwnerGroups == result.targetOwnerGroups
}

const isValidCacheOpenResult = (value: Awaited<ReturnType<ProductionCacheLifecycle['openCacheDatabase']>>): boolean => {
  if (value == null || typeof value != 'object' || Object.getPrototypeOf(value) != Object.prototype) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length != 3 || !keys.includes('status') || !keys.includes('schemaVersion') || !keys.includes('diagnostic')) {
    return false
  }
  return value.status == 'ready' || value.status == 'created' || value.status == 'recreated'
    ? value.schemaVersion == 1 && value.diagnostic == null
    : value.status == 'unavailable' && value.schemaVersion == null &&
        typeof value.diagnostic == 'string' && cacheDiagnosticCodes.has(value.diagnostic)
}

export const createStorageCoordinator = (
  dependencies: StorageCoordinatorDependencies,
): StorageCoordinator => {
  const shutdownFlushers = new Map<string, () => Promise<void>>()
  const shutdownTimeoutMs = dependencies.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS
  let startPromise: Promise<StorageStartupOutcome> | null = null
  let shutdownPromise: Promise<void> | null = null
  let runHasStarted = false
  let startupReachedReady = false
  let portableProfileAcknowledgement: (() => Promise<void>) | null = null
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
        await dependencies.initializeTempLifecycle?.()
        if (shutdownRequested) return startupCancelled()
        const legacyData = await dependencies.preflightLegacyData?.() ?? { status: 'absent' as const }
        if (shutdownRequested) return startupCancelled()
        if (legacyData.status == 'recovery') {
          const outcome = legacyDataRecovery(legacyData)
          await dependencies.showRecovery(outcome)
          return outcome
        }
        const database = await dependencies.initDatabase(previousShutdownWasClean)
        if (shutdownRequested) return startupCancelled()
        if (database.status == 'recovery') {
          const outcome = databaseRecovery(database)
          await dependencies.showRecovery(outcome)
          return outcome
        }

        const migrationOutcome = await dependencies.runMigrationHooks(database, legacyData)
        if (shutdownRequested) return startupCancelled()
        if (migrationOutcome?.status == 'recovery') {
          await dependencies.showRecovery(migrationOutcome)
          return migrationOutcome
        }

        const playbackMigrationOutcome = await dependencies.runPlaybackActivityMigration?.(database, legacyData)
        if (shutdownRequested) return startupCancelled()
        if (playbackMigrationOutcome != null && 'status' in playbackMigrationOutcome && playbackMigrationOutcome.status == 'recovery') {
          await dependencies.showRecovery(playbackMigrationOutcome)
          return playbackMigrationOutcome
        }
        const activityEvidence = playbackMigrationOutcome != null && 'sourceState' in playbackMigrationOutcome
          ? playbackMigrationOutcome
          : null

        const credentialCheck = await dependencies.checkCredentials()
        const credentialOutcome = credentialRecovery(credentialCheck)
        if (shutdownRequested) return startupCancelled()
        if (credentialOutcome != null) {
          await dependencies.showRecovery(credentialOutcome)
          return credentialOutcome
        }
        const credentialHealth = fixedCredentialHealth(credentialCheck)

        await verifyPhase2Storage(dependencies.verifyPhase2Storage, legacyData)
        if (shutdownRequested) return startupCancelled()
        const legacySourceState = legacyData.status == 'available' ? 'complete' : 'not-applicable'
        await runPhase3Gate(dependencies, legacySourceState, credentialHealth, activityEvidence)
        if (shutdownRequested) return startupCancelled()
        const productionCache = getProductionCacheLifecycle()
        const readCachePrerequisite = dependencies.getCachePhasePrerequisite ??
          (productionCache == null ? undefined : async() => productionCache.getCachePhasePrerequisite())
        const initializePhase4 = dependencies.initializePhase4 ?? (productionCache == null
          ? undefined
          : async() => {
            const cacheResult = await productionCache.openCacheDatabase()
            if (!isValidCacheOpenResult(cacheResult) ||
                (database.schemaVersion != 6 && database.schemaVersion != 7)) {
              throw errorWithCode('cache_phase4_result_invalid')
            }
            if (cacheResult.status == 'unavailable') return { schemaVersion: database.schemaVersion }
            if (typeof productionCache.migrateRawLyrics != 'function') throw errorWithCode('cache_phase4_result_invalid')
            const migrationResult = await productionCache.migrateRawLyrics({ nowMs: dependencies.now?.() ?? Date.now() })
            if (!isValidRawLyricMigrationResult(migrationResult)) throw errorWithCode('cache_phase4_result_invalid')
            return { schemaVersion: database.schemaVersion }
          })
        if (initializePhase4 != null && readCachePrerequisite == null) {
          throw errorWithCode('cache_phase3_prerequisite_invalid')
        }
        const cachePrerequisite = await readCachePrerequisite?.()
        if (shutdownRequested) return startupCancelled()
        const phase4 = cachePrerequisite == null ? undefined : await initializePhase4?.(cachePrerequisite)
        if (shutdownRequested) return startupCancelled()
        let acknowledgementToArm: (() => Promise<void>) | null = null
        if (phase4 != null) {
          if (phase4.schemaVersion != 6 && phase4.schemaVersion != 7) {
            throw errorWithCode('cache_phase4_result_invalid')
          }
          if (dependencies.portableProfileToken != null) {
            const token = dependencies.portableProfileToken
            const acknowledge = dependencies.acknowledgePortableProfileStartup
            if (acknowledge == null) {
              throw errorWithCode('portable_profile_acknowledgement_unavailable')
            }
            acknowledgementToArm = async() => { await acknowledge(token) }
          }
        }
        await dependencies.initSettings()
        if (shutdownRequested) return startupCancelled()
        dependencies.registerModules()
        dependencies.appInited()
        startupReachedReady = true
        portableProfileAcknowledgement = acknowledgementToArm
        return { status: 'ready', schemaVersion: phase4?.schemaVersion ?? database.schemaVersion }
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
        failure ??= errorWithCode('shutdown_flush_timeout')
      } else if (flusherResult.failed) {
        failure ??= errorWithCode('shutdown_flusher_failed')
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

      try {
        if (failure == null && runHasStarted && startupReachedReady) await dependencies.runState.markClean()
        if (failure == null && portableProfileAcknowledgement != null) {
          const acknowledgePortableProfile = portableProfileAcknowledgement
          portableProfileAcknowledgement = null
          await acknowledgePortableProfile()
        }
      } catch (error) {
        failure ??= error instanceof Error ? error : errorWithCode('shutdown_finalize_failed')
      } finally {
        try {
          await dependencies.cleanupTempLifecycle?.()
        } catch (error) {
          failure ??= error instanceof Error ? error : errorWithCode('shutdown_temp_cleanup_failed')
        }
      }
      if (failure != null) throw failure
    })()
    return shutdownPromise
  }

  return { start, registerShutdownFlusher, shutdown }
}
