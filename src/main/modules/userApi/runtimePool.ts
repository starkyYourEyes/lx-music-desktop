/* eslint-disable @typescript-eslint/method-signature-style, @typescript-eslint/triple-slash-reference */
/// <reference path="../../../common/types/playback_source.d.ts" />
import USER_API_RENDERER_EVENT_NAME from './rendererEvent/name'
import { normalizeRuntimeFailure } from './runtimeError'
import type {
  clearRuntimeSession,
  createRuntimeWindow,
  disposeRuntimeWindow,
  initializeRuntimeWindow,
  UserApiRuntimeWindow,
} from './runtimeWindow'

interface PendingRequest {
  apiId: string
  requestId: string
  ownerWebContentsId: number
  resolve: (result: LX.UserApi.UserApiRequestResult) => void
  timeout: ReturnType<typeof setTimeout>
  state: 'initializing' | 'sent'
}

interface RuntimeRecord {
  apiId: string
  generation: number
  runtime: UserApiRuntimeWindow
  initPromise: Promise<LX.UserApi.UserApiInfo>
  resolveInit: (value: LX.UserApi.UserApiInfo) => void
  rejectInit: (reason: LX.Playback.SourceFailureData) => void
  status: LX.UserApi.UserApiStatus
  disposing: boolean
  disposeWhenIdle: boolean
  initSettled: boolean
  initTimeout: ReturnType<typeof setTimeout> | null
}

interface RuntimeRetirementState {
  record: RuntimeRecord
  clearSession: boolean
  disposeComplete: boolean
  clearSessionComplete: boolean
  version: number
  promise: Promise<void> | null
  failure: unknown
}

interface RuntimeCreationRetirementState {
  apiId: string
  creations: Set<RuntimeCreationState>
  clearSession: boolean
  clearSessionComplete: boolean
  closing: boolean
  version: number
  promise: Promise<void> | null
  failure: unknown
}

interface RuntimeCreationState {
  apiId: string
  generation: number
  promise: Promise<RuntimeRecord>
  disposeWhenIdle: boolean
  disposeReason: 'idle' | 'invalidate' | 'explicit' | 'timeout' | null
  runtime: UserApiRuntimeWindow | null
  creationSettled: boolean
  disposeComplete: boolean
  retirement: RuntimeCreationRetirementState | null
  timeoutPromise: Promise<never>
  initTimeout: ReturnType<typeof setTimeout> | null
}

export interface UserApiRuntimePoolDependencies {
  createRuntimeWindow: typeof createRuntimeWindow
  initializeRuntimeWindow: typeof initializeRuntimeWindow
  disposeRuntimeWindow: typeof disposeRuntimeWindow
  clearRuntimeSession: typeof clearRuntimeSession
  getApiInfo(apiId: string): LX.UserApi.UserApiInfo | undefined
  send<T>(runtime: UserApiRuntimeWindow, name: string, payload: T): boolean
  onProxyUpdate(handler: () => void): () => void
  getProxy(): { host: string, port: string }
  openDevTools(runtime: UserApiRuntimeWindow): void
  showUpdateAlert(info: LX.UserApi.UserApiUpdateInfo): void
  publishStatus(status: LX.UserApi.UserApiStatus): void
  initialConfiguredApiIds: ReadonlySet<string>
  logError(message: string, reason: unknown): void
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
}

export interface UserApiRuntimePool {
  ensure(apiId: string): Promise<LX.UserApi.UserApiInfo>
  request(params: LX.UserApi.SourceUserApiRequestParams, ownerWebContentsId: number): Promise<LX.UserApi.UserApiRequestResult>
  cancel(params: LX.UserApi.SourceUserApiRequestCancelParams, ownerWebContentsId: number): void
  acquireLease(params: LX.UserApi.UserApiRuntimeLeaseParams, ownerWebContentsId: number): void
  releaseLease(params: LX.UserApi.UserApiRuntimeLeaseParams, ownerWebContentsId: number): Promise<void>
  releaseOwner(ownerWebContentsId: number): Promise<void>
  markConfigured(apiIds: ReadonlySet<string>): Promise<void>
  configureIdlePolicy(policy: { primaryApiId: string, idleMinutes: 0 | 1 | 5 | 15 }): Promise<void>
  acceptInit(senderId: number, envelope: LX.UserApi.UserApiRuntimeInitEnvelope): boolean
  acceptResponse(senderId: number, envelope: LX.UserApi.UserApiRuntimeResponseEnvelope): boolean
  handleOpenDevTools(senderId: number, envelope: LX.UserApi.UserApiRuntimeControlEnvelope): boolean
  handleShowUpdateAlert(senderId: number, envelope: LX.UserApi.UserApiRuntimeUpdateAlertEnvelope): boolean
  handleGetProxy(senderId: number, envelope: LX.UserApi.UserApiRuntimeControlEnvelope): boolean
  invalidate(apiId: string, kind: 'sourceChanged' | 'runtimeCrash'): Promise<void>
  dispose(apiId: string, options: { clearSession: boolean }): Promise<void>
  disposeAll(): Promise<void>
  getStatus(apiId: string): LX.UserApi.UserApiStatus
  send<T>(apiId: string, name: string, payload: T): boolean
  broadcast<T>(name: string, payload: T): void
}

export type CreateUserApiRuntimePool = (deps: UserApiRuntimePoolDependencies) => UserApiRuntimePool

const messageFailure = (
  apiId: string,
  kind: LX.Playback.SourceFailureKind,
  message: string,
) => normalizeRuntimeFailure({ message }, { apiId, kind })

const USER_API_INITIALIZATION_TIMEOUT = 10_000

export const createUserApiRuntimePool: CreateUserApiRuntimePool = deps => {
  const recordsByApiId = new Map<string, RuntimeRecord>()
  const bindingsByWebContentsId = new Map<number, LX.UserApi.UserApiRuntimeIdentity>()
  const leasesByApiId = new Map<string, Map<number, Set<string>>>()
  const configuredApiIds = new Set(deps.initialConfiguredApiIds)
  const pendingByApiId = new Map<string, Map<string, PendingRequest>>()
  const creatingByApiId = new Map<string, RuntimeCreationState>()
  const retiringCreationsByApiId = new Map<string, RuntimeCreationRetirementState>()
  const retiringByApiId = new Map<string, RuntimeRetirementState>()
  const nextGenerationByApiId = new Map<string, number>()
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let primaryApiId = ''
  let idleMinutes: 0 | 1 | 5 | 15 = 5
  const cancelIdleTimer = (apiId: string) => {
    const timer = idleTimers.get(apiId)
    if (timer == null) return
    deps.clearTimeout(timer)
    idleTimers.delete(apiId)
  }

  const hasLeases = (apiId: string) => {
    const owners = leasesByApiId.get(apiId)
    if (!owners) return false
    for (const leaseIds of owners.values()) if (leaseIds.size) return true
    return false
  }

  const observeLifecycle = (label: string, promise: Promise<unknown>) => {
    void promise.catch(reason => {
      deps.logError(label, reason)
    })
  }

  const getBoundRecord = (
    senderId: number,
    identity: LX.UserApi.UserApiRuntimeIdentity,
  ): RuntimeRecord | null => {
    const binding = bindingsByWebContentsId.get(senderId)
    if (!binding || binding.apiId != identity.apiId || binding.generation != identity.generation) return null
    const record = recordsByApiId.get(binding.apiId)
    return record?.generation == binding.generation ? record : null
  }

  let disposeIfIdle: (apiId: string) => Promise<void>
  let dispose: UserApiRuntimePool['dispose']

  const settlePending = (
    apiId: string,
    requestId: string,
    result: LX.UserApi.UserApiRequestResult,
  ) => {
    const sourcePending = pendingByApiId.get(apiId)
    const pending = sourcePending?.get(requestId)
    if (!pending) return false
    sourcePending!.delete(requestId)
    if (!sourcePending!.size) pendingByApiId.delete(apiId)
    deps.clearTimeout(pending.timeout)
    pending.resolve(result)
    observeLifecycle(`dispose idle user API runtime ${apiId} failed`, disposeIfIdle(apiId))
    return true
  }

  const settleSource = (apiId: string, failure: LX.Playback.SourceFailureData) => {
    for (const requestId of [...(pendingByApiId.get(apiId)?.keys() ?? [])]) {
      settlePending(apiId, requestId, { ok: false, error: failure })
    }
  }

  const rejectInit = (record: RuntimeRecord, failure: LX.Playback.SourceFailureData) => {
    if (record.initSettled) return
    record.initSettled = true
    if (record.initTimeout != null) {
      deps.clearTimeout(record.initTimeout)
      record.initTimeout = null
    }
    record.rejectInit(failure)
  }

  const clearCreationTimeout = (state: RuntimeCreationState) => {
    if (state.initTimeout == null) return
    deps.clearTimeout(state.initTimeout)
    state.initTimeout = null
  }

  const removeRecord = (record: RuntimeRecord) => {
    cancelIdleTimer(record.apiId)
    if (recordsByApiId.get(record.apiId) == record) recordsByApiId.delete(record.apiId)
    const binding = bindingsByWebContentsId.get(record.runtime.webContentsId)
    if (binding?.apiId == record.apiId && binding.generation == record.generation) {
      bindingsByWebContentsId.delete(record.runtime.webContentsId)
    }
  }

  const retainCreation = (state: RuntimeCreationState) => {
    if (state.retirement) return state.retirement
    let retirement = retiringCreationsByApiId.get(state.apiId)
    if (!retirement) {
      retirement = {
        apiId: state.apiId,
        creations: new Set(),
        clearSession: false,
        clearSessionComplete: false,
        closing: false,
        version: 0,
        promise: null,
        failure: null,
      }
      retiringCreationsByApiId.set(state.apiId, retirement)
    }
    retirement.creations.add(state)
    retirement.version++
    state.retirement = retirement
    return retirement
  }

  const upgradeCreationRetirement = (retirement: RuntimeCreationRetirementState, clearSession: boolean) => {
    if (!clearSession || retirement.clearSession) return
    retirement.clearSession = true
    retirement.version++
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  const attemptCreationRetirement = (retirement: RuntimeCreationRetirementState): Promise<void> => {
    if (retirement.promise) {
      return retirement.promise.then(async() => {
        await attemptCreationRetirement(retirement)
      })
    }
    let attempt!: Promise<void>
    attempt = Promise.resolve().then(async() => {
      while (true) {
        const recordBeforeDestruction = recordsByApiId.get(retirement.apiId)
        const version = retirement.version
        for (const state of retirement.creations) {
          if (!state.creationSettled || state.runtime == null || state.disposeComplete) continue
          await deps.disposeRuntimeWindow(state.runtime, { clearSession: false })
          state.disposeComplete = true
        }
        const replacement = creatingByApiId.get(retirement.apiId)
        if (retirement.clearSession && replacement && replacement.retirement != retirement) {
          replacement.disposeReason = 'explicit'
          retainCreation(replacement)
        }
        const allDestroyed = [...retirement.creations].every(state =>
          state.creationSettled && (state.runtime == null || state.disposeComplete),
        )
        if (!allDestroyed) {
          retirement.failure = null
          return
        }
        if (retirement.clearSession && !retirement.clearSessionComplete) {
          const replacementRecord = recordsByApiId.get(retirement.apiId)
          if (replacementRecord && replacementRecord != recordBeforeDestruction) {
            const failure = messageFailure(retirement.apiId, 'sourceChanged', 'User API source changed')
            settleSource(retirement.apiId, failure)
            const retiringRecord = retireRecord(replacementRecord, { clearSession: false, failure })
            // Record retirement resumes this aggregate; awaiting it here would make that handoff circular.
            observeLifecycle(`retire replacement User API runtime ${retirement.apiId} failed`, retiringRecord)
            retirement.failure = null
            return
          }
          const recordRetirement = retiringByApiId.get(retirement.apiId)
          if (recordsByApiId.has(retirement.apiId) || (recordRetirement && !recordRetirement.disposeComplete)) {
            retirement.failure = null
            return
          }
          if (!retirement.closing) {
            retirement.closing = true
            retirement.version++
          }
          await deps.clearRuntimeSession(retirement.apiId)
          retirement.clearSessionComplete = true
        }
        if (version != retirement.version) continue
        retirement.failure = null
        if (retiringCreationsByApiId.get(retirement.apiId) == retirement) {
          retiringCreationsByApiId.delete(retirement.apiId)
        }
        for (const state of retirement.creations) state.retirement = null
        return
      }
    }).catch(reason => {
      retirement.failure = reason
      throw reason
    }).finally(() => {
      if (retirement.promise == attempt) retirement.promise = null
    })
    retirement.promise = attempt
    observeLifecycle(`retire User API runtime creation ${retirement.apiId} failed`, attempt)
    return attempt
  }

  const upgradeRetirement = (retirement: RuntimeRetirementState, clearSession: boolean) => {
    if (!clearSession || retirement.clearSession) return
    retirement.clearSession = true
    retirement.version++
  }

  // Preserve the exact in-flight promise so concurrent cleanup callers share one attempt.
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  const attemptRetirement = (retirement: RuntimeRetirementState): Promise<void> => {
    if (retirement.promise) return retirement.promise
    let attempt!: Promise<void>
    attempt = Promise.resolve()
      .then(async() => {
        while (true) {
          const version = retirement.version
          if (!retirement.disposeComplete) {
            const clearSession = retirement.clearSession
            await deps.disposeRuntimeWindow(retirement.record.runtime, { clearSession })
            retirement.disposeComplete = true
            retirement.clearSessionComplete ||= clearSession
          }
          if (retirement.clearSession && !retirement.clearSessionComplete) {
            await deps.clearRuntimeSession(retirement.record.apiId)
            retirement.clearSessionComplete = true
          }
          if (version != retirement.version) continue
          retirement.failure = null
          if (retiringByApiId.get(retirement.record.apiId) == retirement) {
            retiringByApiId.delete(retirement.record.apiId)
          }
          const creationRetirement = retiringCreationsByApiId.get(retirement.record.apiId)
          if (creationRetirement) await attemptCreationRetirement(creationRetirement)
          return
        }
      })
      .catch(reason => {
        retirement.failure = reason
        throw reason
      })
      .finally(() => {
        if (retirement.promise == attempt) retirement.promise = null
      })
    retirement.promise = attempt
    return attempt
  }

  const retireRecord = async(
    record: RuntimeRecord,
    options: { clearSession: boolean, failure?: LX.Playback.SourceFailureData },
  ): Promise<void> => {
    const existing = retiringByApiId.get(record.apiId)
    if (record.disposing) {
      if (existing) upgradeRetirement(existing, options.clearSession)
      if (existing?.promise) return existing.promise
      return existing?.failure == null ? Promise.resolve() : Promise.reject(existing.failure)
    }
    record.disposing = true
    removeRecord(record)
    if (options.failure) rejectInit(record, options.failure)
    const retirement: RuntimeRetirementState = {
      record,
      clearSession: options.clearSession,
      disposeComplete: false,
      clearSessionComplete: false,
      version: 0,
      promise: null,
      failure: null,
    }
    retiringByApiId.set(record.apiId, retirement)
    return attemptRetirement(retirement)
  }

  const failInitialization = (
    record: RuntimeRecord,
    reason: unknown,
    kind: LX.Playback.SourceFailureKind = 'initialization',
  ) => {
    if (recordsByApiId.get(record.apiId) != record || record.disposing) return
    const failure = normalizeRuntimeFailure(reason, { apiId: record.apiId, kind })
    const apiInfo = deps.getApiInfo(record.apiId)
    record.status = { apiId: record.apiId, status: false, message: failure.message, ...(apiInfo ? { apiInfo } : {}) }
    deps.publishStatus({ ...record.status })
    const retiring = retireRecord(record, { clearSession: false, failure })
    settleSource(record.apiId, failure)
    observeLifecycle(`retire failed user API runtime ${record.apiId}`, retiring)
  }

  const ensureRecord = async(apiId: string): Promise<RuntimeRecord> => {
    const retiringCreation = retiringCreationsByApiId.get(apiId)
    if (retiringCreation?.failure != null) return Promise.reject(retiringCreation.failure)
    if (retiringCreation?.closing) {
      await attemptCreationRetirement(retiringCreation)
      return ensureRecord(apiId)
    }
    const retiring = retiringByApiId.get(apiId)
    if (retiring) {
      if (retiring.promise) await retiring.promise
      else if (retiring.failure != null) return Promise.reject(retiring.failure)
      return ensureRecord(apiId)
    }
    const record = recordsByApiId.get(apiId)
    if (record && !record.disposing) return record
    const creating = creatingByApiId.get(apiId)
    if (creating) {
      if (creating.disposeReason == null || creating.disposeReason == 'idle') {
        return Promise.race([creating.promise, creating.timeoutPromise])
      }
      try { await Promise.race([creating.promise, creating.timeoutPromise]) } catch (_) {}
      return ensureRecord(apiId)
    }
    const apiInfo = deps.getApiInfo(apiId)
    if (!apiInfo) {
      const failure = messageFailure(apiId, 'initialization', 'User API source is not found')
      throw Object.assign(new Error(failure.message), failure)
    }
    const generation = nextGenerationByApiId.get(apiId) ?? 1
    nextGenerationByApiId.set(apiId, generation + 1)
    const state: RuntimeCreationState = {
      apiId,
      generation,
      promise: null as unknown as Promise<RuntimeRecord>,
      disposeWhenIdle: !configuredApiIds.has(apiId),
      disposeReason: null,
      runtime: null,
      creationSettled: false,
      disposeComplete: false,
      retirement: null,
      timeoutPromise: null as unknown as Promise<never>,
      initTimeout: null,
    }
    let rejectTimeout!: (reason: LX.Playback.SourceFailureData) => void
    state.timeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject
    })
    state.initTimeout = deps.setTimeout(() => {
      state.initTimeout = null
      const failure = messageFailure(apiId, 'timeout', 'User API initialization timed out')
      const record = recordsByApiId.get(apiId)
      if (record?.generation == generation) {
        failInitialization(record, failure, 'timeout')
      } else {
        if (creatingByApiId.get(apiId) != state) return
        retainCreation(state)
        creatingByApiId.delete(apiId)
        if (state.disposeReason == 'invalidate' || state.disposeReason == 'explicit') {
          rejectTimeout(messageFailure(apiId, 'sourceChanged', 'User API source changed'))
          return
        }
        state.disposeReason = 'timeout'
        deps.publishStatus({ apiId, status: false, message: failure.message, apiInfo })
        settleSource(apiId, failure)
      }
      rejectTimeout(failure)
    }, USER_API_INITIALIZATION_TIMEOUT)
    const initTimeout = state.initTimeout as { unref?: () => void }
    initTimeout.unref?.()
    creatingByApiId.set(apiId, state)
    let rawCreation: Promise<UserApiRuntimeWindow>
    try {
      rawCreation = Promise.resolve(deps.createRuntimeWindow({
        apiInfo,
        generation,
        hooks: {
          onClosed: identity => {
            if (identity.generation != generation || recordsByApiId.get(apiId)?.generation != generation) return
            observeLifecycle(`closed user API runtime ${apiId}`, invalidate(apiId, 'runtimeCrash'))
          },
          onRenderProcessGone: identity => {
            if (identity.generation != generation || recordsByApiId.get(apiId)?.generation != generation) return
            observeLifecycle(`crashed user API runtime ${apiId}`, invalidate(apiId, 'runtimeCrash'))
          },
        },
      }))
    } catch (error) {
      rawCreation = Promise.reject(error)
    }

    state.promise = rawCreation.then(async runtime => {
      state.runtime = runtime
      state.creationSettled = true
      if (state.retirement) state.retirement.version++

      if (state.disposeReason == 'idle' &&
        (configuredApiIds.has(apiId) || hasLeases(apiId) || (pendingByApiId.get(apiId)?.size ?? 0) > 0)) {
        state.disposeReason = null
        state.disposeWhenIdle = !configuredApiIds.has(apiId)
      }
      if (creatingByApiId.get(apiId) != state || state.disposeReason != null) {
        const retirement = retainCreation(state)
        await attemptCreationRetirement(retirement)
        const failure = state.disposeReason == 'timeout'
          ? messageFailure(apiId, 'timeout', 'User API initialization timed out')
          : messageFailure(apiId, 'sourceChanged', 'User API source changed')
        throw Object.assign(new Error(failure.message), failure)
      }

      creatingByApiId.delete(apiId)
      let resolveInit!: RuntimeRecord['resolveInit']
      let rejectInitPromise!: RuntimeRecord['rejectInit']
      const initPromise = new Promise<LX.UserApi.UserApiInfo>((resolve, reject) => {
        resolveInit = resolve
        rejectInitPromise = reject
      })
      // Initialization dispatch can outlive the deadline before ensure() can await this promise.
      void initPromise.catch(() => {})
      const nextRecord: RuntimeRecord = {
        apiId,
        generation,
        runtime,
        initPromise,
        resolveInit,
        rejectInit: rejectInitPromise,
        status: { apiId, status: false, apiInfo },
        disposing: false,
        disposeWhenIdle: state.disposeWhenIdle,
        initSettled: false,
        initTimeout: state.initTimeout,
      }
      state.initTimeout = null
      recordsByApiId.set(apiId, nextRecord)
      bindingsByWebContentsId.set(runtime.webContentsId, { apiId, generation })
      try {
        const sent = await deps.initializeRuntimeWindow(runtime, apiInfo)
        if (!sent) failInitialization(nextRecord, new Error('User API runtime initialization could not be sent'))
      } catch (error) {
        failInitialization(nextRecord, error)
      }
      await disposeIfIdle(apiId)
      return nextRecord
    }, async error => {
      state.creationSettled = true
      if (state.retirement) {
        state.retirement.version++
        await attemptCreationRetirement(state.retirement)
      }
      throw error
    }).catch(error => {
      clearCreationTimeout(state)
      throw error
    }).finally(() => {
      if (creatingByApiId.get(apiId) == state) creatingByApiId.delete(apiId)
    })
    return Promise.race([state.promise, state.timeoutPromise])
  }

  const ensure = async(apiId: string) => {
    cancelIdleTimer(apiId)
    const record = await ensureRecord(apiId)
    const info = await record.initPromise
    await disposeIfIdle(apiId)
    return info
  }

  const invalidate = async(apiId: string, kind: 'sourceChanged' | 'runtimeCrash') => {
    if (kind == 'sourceChanged') leasesByApiId.delete(apiId)
    const creating = creatingByApiId.get(apiId)
    if (creating && (creating.disposeReason == null || creating.disposeReason == 'idle')) {
      creating.disposeReason = 'invalidate'
    }
    const record = recordsByApiId.get(apiId)
    const failure = messageFailure(
      apiId,
      kind,
      kind == 'runtimeCrash' ? 'User API runtime crashed' : 'User API source changed',
    )
    if (!record) {
      settleSource(apiId, failure)
      return
    }
    if (kind == 'runtimeCrash' || kind == 'sourceChanged') {
      const apiInfo = deps.getApiInfo(apiId)
      record.status = { apiId, status: false, message: failure.message, ...(apiInfo ? { apiInfo } : {}) }
      deps.publishStatus({ ...record.status })
    }
    const retiring = retireRecord(record, { clearSession: false, failure })
    settleSource(apiId, failure)
    await retiring
  }

  dispose = async(apiId, options) => {
    cancelIdleTimer(apiId)
    leasesByApiId.delete(apiId)
    const failure = messageFailure(apiId, 'sourceChanged', 'User API source changed')
    const creating = creatingByApiId.get(apiId)
    let creationRetirement = retiringCreationsByApiId.get(apiId)
    if (creating) {
      creating.disposeReason = 'explicit'
      creationRetirement = retainCreation(creating)
      upgradeCreationRetirement(creationRetirement, options.clearSession)
    } else if (creationRetirement) {
      upgradeCreationRetirement(creationRetirement, options.clearSession)
    }

    const record = recordsByApiId.get(apiId)
    const existingRetirement = retiringByApiId.get(apiId)
    let recordRetiring: Promise<void> | null = null
    if (record) {
      recordRetiring = retireRecord(record, {
        clearSession: options.clearSession && creationRetirement == null,
        failure,
      })
    } else if (existingRetirement) {
      upgradeRetirement(existingRetirement, options.clearSession && creationRetirement == null)
      recordRetiring = attemptRetirement(existingRetirement)
    } else if (options.clearSession && creationRetirement == null) {
      creationRetirement = {
        apiId,
        creations: new Set(),
        clearSession: true,
        clearSessionComplete: false,
        closing: false,
        version: 0,
        promise: null,
        failure: null,
      }
      retiringCreationsByApiId.set(apiId, creationRetirement)
    }

    settleSource(apiId, failure)
    let creationSettled = false
    if (creating) {
      creationSettled = await Promise.race([
        creating.promise.then(() => true, () => true),
        creating.timeoutPromise.then(() => false, () => false),
      ])
    }
    if (recordRetiring) await recordRetiring
    if (creationRetirement) {
      if (creating && creationSettled && creationRetirement.failure != null) {
        return Promise.reject(creationRetirement.failure)
      }
      await attemptCreationRetirement(creationRetirement)
    }
  }

  disposeIfIdle = async(apiId: string) => {
    if ((pendingByApiId.get(apiId)?.size ?? 0) > 0 || hasLeases(apiId) || apiId == primaryApiId) {
      cancelIdleTimer(apiId)
      return
    }
    const record = recordsByApiId.get(apiId)
    if (configuredApiIds.has(apiId)) {
      // Configuration keeps capabilities discoverable, but only the primary source is pinned.
      if (!record?.initSettled || record.disposing || idleMinutes == 0 || idleTimers.has(apiId)) return
      const generation = record.generation
      const timer = deps.setTimeout(() => {
        idleTimers.delete(apiId)
        if (recordsByApiId.get(apiId)?.generation != generation || apiId == primaryApiId ||
          hasLeases(apiId) || (pendingByApiId.get(apiId)?.size ?? 0) > 0) return
        deps.publishStatus({ apiId, status: false, message: 'User API runtime released after idle timeout' })
        observeLifecycle(`dispose idle user API runtime ${apiId} failed`, dispose(apiId, { clearSession: false }))
      }, idleMinutes * 60_000)
      idleTimers.set(apiId, timer)
      ;(timer as { unref?: () => void }).unref?.()
      return
    }
    if (record?.disposeWhenIdle) {
      await dispose(apiId, { clearSession: false })
      return
    }
    const creating = creatingByApiId.get(apiId)
    if (creating?.disposeWhenIdle && creating.disposeReason == null) creating.disposeReason = 'idle'
  }

  const request: UserApiRuntimePool['request'] = async(params, ownerWebContentsId) => {
    const { apiId, requestId } = params
    const old = pendingByApiId.get(apiId)?.get(requestId)
    if (old) {
      if (old.ownerWebContentsId != ownerWebContentsId) {
        return {
          ok: false,
          error: messageFailure(apiId, 'request', 'User API request ID is already in use'),
        }
      }
      settlePending(apiId, requestId, {
        ok: false,
        error: normalizeRuntimeFailure(new Error('User API request ID is already pending'), { apiId, cancelled: true }),
      })
    }
    return new Promise(resolve => {
      let sourcePending = pendingByApiId.get(apiId)
      if (!sourcePending) pendingByApiId.set(apiId, sourcePending = new Map())
      const pending: PendingRequest = {
        apiId,
        requestId,
        ownerWebContentsId,
        resolve,
        timeout: deps.setTimeout(() => {
          settlePending(apiId, requestId, {
            ok: false,
            error: messageFailure(apiId, 'timeout', 'User API request timed out'),
          })
        }, 20_000),
        state: 'initializing',
      }
      sourcePending.set(requestId, pending)
      void ensure(apiId).then(() => {
        if (pendingByApiId.get(apiId)?.get(requestId) != pending) return
        pending.state = 'sent'
        if (!pool.send(apiId, USER_API_RENDERER_EVENT_NAME.request, params)) {
          settlePending(apiId, requestId, {
            ok: false,
            error: normalizeRuntimeFailure(new Error('User API runtime is unavailable'), { apiId }),
          })
        }
      }).catch(error => {
        if (pendingByApiId.get(apiId)?.get(requestId) != pending) return
        const failure = error?.name == 'PlaybackSourceError'
          ? { ...error, apiId }
          : normalizeRuntimeFailure(error, { apiId, kind: 'initialization' })
        settlePending(apiId, requestId, { ok: false, error: failure })
      })
    })
  }

  const cancel: UserApiRuntimePool['cancel'] = (params, ownerWebContentsId) => {
    const pending = pendingByApiId.get(params.apiId)?.get(params.requestId)
    if (!pending || pending.ownerWebContentsId != ownerWebContentsId) return
    const error = params.reason == 'timeout'
      ? messageFailure(params.apiId, 'timeout', 'User API request timed out')
      : normalizeRuntimeFailure(new Error('User API request cancelled'), { apiId: params.apiId, cancelled: true })
    settlePending(params.apiId, params.requestId, { ok: false, error })
  }

  const acquireLease: UserApiRuntimePool['acquireLease'] = (params, ownerWebContentsId) => {
    for (const apiId of params.apiIds) {
      cancelIdleTimer(apiId)
      let owners = leasesByApiId.get(apiId)
      if (!owners) leasesByApiId.set(apiId, owners = new Map())
      let leases = owners.get(ownerWebContentsId)
      if (!leases) owners.set(ownerWebContentsId, leases = new Set())
      leases.add(params.leaseId)
    }
  }

  const releaseLease: UserApiRuntimePool['releaseLease'] = async(params, ownerWebContentsId) => {
    for (const apiId of params.apiIds) {
      const owners = leasesByApiId.get(apiId)
      const leases = owners?.get(ownerWebContentsId)
      leases?.delete(params.leaseId)
      if (leases && !leases.size) owners!.delete(ownerWebContentsId)
      if (owners && !owners.size) leasesByApiId.delete(apiId)
      await disposeIfIdle(apiId)
    }
  }

  const releaseOwner: UserApiRuntimePool['releaseOwner'] = async ownerWebContentsId => {
    const affected = new Set<string>()
    for (const [apiId, owners] of leasesByApiId) {
      if (owners.delete(ownerWebContentsId)) affected.add(apiId)
      if (!owners.size) leasesByApiId.delete(apiId)
    }
    for (const [apiId, requests] of pendingByApiId) {
      for (const pending of [...requests.values()]) {
        if (pending.ownerWebContentsId != ownerWebContentsId) continue
        cancel({ apiId, requestId: pending.requestId, reason: 'cancelled' }, ownerWebContentsId)
        affected.add(apiId)
      }
    }
    await Promise.all([...affected].map(disposeIfIdle))
  }

  const markConfigured: UserApiRuntimePool['markConfigured'] = async apiIds => {
    const affected = new Set([...configuredApiIds, ...apiIds])
    configuredApiIds.clear()
    for (const apiId of apiIds) configuredApiIds.add(apiId)
    for (const apiId of affected) {
      cancelIdleTimer(apiId)
      const isConfigured = configuredApiIds.has(apiId)
      const record = recordsByApiId.get(apiId)
      if (record) record.disposeWhenIdle = !isConfigured
      const creating = creatingByApiId.get(apiId)
      if (creating) {
        creating.disposeWhenIdle = !isConfigured
        if (isConfigured && creating.disposeReason == 'idle') creating.disposeReason = null
      }
    }
    await Promise.all([...affected].map(disposeIfIdle))
  }

  const configureIdlePolicy: UserApiRuntimePool['configureIdlePolicy'] = async policy => {
    primaryApiId = policy.primaryApiId
    idleMinutes = policy.idleMinutes
    for (const apiId of idleTimers.keys()) cancelIdleTimer(apiId)
    await Promise.all([...recordsByApiId.keys()].map(disposeIfIdle))
  }

  const acceptInit: UserApiRuntimePool['acceptInit'] = (senderId, envelope) => {
    const record = getBoundRecord(senderId, envelope.identity)
    if (!record || record.initSettled) return false
    if (!envelope.status) {
      failInitialization(record, {
        message: envelope.message,
        code: envelope.code,
        statusCode: envelope.statusCode,
      })
      return true
    }
    const apiInfo = deps.getApiInfo(record.apiId)
    if (!apiInfo) {
      failInitialization(record, new Error('User API source is not found'))
      return true
    }
    const initializedInfo = { ...apiInfo, sources: envelope.data.sources }
    record.initSettled = true
    if (record.initTimeout != null) {
      deps.clearTimeout(record.initTimeout)
      record.initTimeout = null
    }
    record.status = { apiId: record.apiId, status: true, apiInfo: initializedInfo }
    deps.publishStatus({ ...record.status })
    record.resolveInit(initializedInfo)
    return true
  }

  const acceptResponse: UserApiRuntimePool['acceptResponse'] = (senderId, envelope) => {
    const record = getBoundRecord(senderId, envelope.identity)
    if (!record) return false
    const { requestId, result } = envelope.data
    if (envelope.status) return settlePending(record.apiId, requestId, { ok: true, value: result })
    return settlePending(record.apiId, requestId, {
      ok: false,
      error: normalizeRuntimeFailure({
        message: envelope.message,
        code: envelope.code,
        statusCode: envelope.statusCode,
      }, { apiId: record.apiId }),
    })
  }

  const handleOpenDevTools: UserApiRuntimePool['handleOpenDevTools'] = (senderId, envelope) => {
    const record = getBoundRecord(senderId, envelope.identity)
    if (!record) return false
    deps.openDevTools(record.runtime)
    return true
  }

  const handleShowUpdateAlert: UserApiRuntimePool['handleShowUpdateAlert'] = (senderId, envelope) => {
    const record = getBoundRecord(senderId, envelope.identity)
    const apiInfo = record ? deps.getApiInfo(record.apiId) : undefined
    if (!record || !apiInfo?.allowShowUpdateAlert || !envelope.status) return false
    deps.showUpdateAlert({
      name: apiInfo.name,
      description: apiInfo.description,
      log: envelope.data.log,
      updateUrl: envelope.data.updateUrl,
    })
    return true
  }

  const handleGetProxy: UserApiRuntimePool['handleGetProxy'] = (senderId, envelope) => {
    const record = getBoundRecord(senderId, envelope.identity)
    if (!record) return false
    return deps.send(record.runtime, USER_API_RENDERER_EVENT_NAME.proxyUpdate, deps.getProxy())
  }

  const send: UserApiRuntimePool['send'] = (apiId, name, payload) => {
    const record = recordsByApiId.get(apiId)
    return record != null && !record.disposing && deps.send(record.runtime, name, payload)
  }

  const broadcast: UserApiRuntimePool['broadcast'] = (name, payload) => {
    for (const record of recordsByApiId.values()) {
      if (!record.disposing) deps.send(record.runtime, name, payload)
    }
  }

  const getStatus: UserApiRuntimePool['getStatus'] = apiId => {
    const status = recordsByApiId.get(apiId)?.status
    return status ? { ...status } : { apiId, status: false, message: 'User API runtime is not initialized' }
  }

  const unsubscribeProxy = deps.onProxyUpdate(() => {
    broadcast(USER_API_RENDERER_EVENT_NAME.proxyUpdate, deps.getProxy())
  })

  const disposeAll: UserApiRuntimePool['disposeAll'] = async() => {
    try {
      const ids = new Set([
        ...recordsByApiId.keys(),
        ...creatingByApiId.keys(),
        ...retiringCreationsByApiId.keys(),
        ...retiringByApiId.keys(),
      ])
      const results = await Promise.allSettled([...ids].map(async apiId => {
        return dispose(apiId, { clearSession: false })
      }))
      const failed = results.find((result): result is PromiseRejectedResult => result.status == 'rejected')
      if (failed) throw failed.reason
    } finally {
      unsubscribeProxy()
    }
  }

  const pool: UserApiRuntimePool = {
    ensure,
    request,
    cancel,
    acquireLease,
    releaseLease,
    releaseOwner,
    markConfigured,
    configureIdlePolicy,
    acceptInit,
    acceptResponse,
    handleOpenDevTools,
    handleShowUpdateAlert,
    handleGetProxy,
    invalidate,
    dispose,
    disposeAll,
    getStatus,
    send,
    broadcast,
  }
  return pool
}

let productionPool: UserApiRuntimePool | null = null

export const initializeUserApiRuntimePool = (
  deps: UserApiRuntimePoolDependencies,
): UserApiRuntimePool => productionPool ??= createUserApiRuntimePool(deps)

export const getUserApiRuntimePool = (): UserApiRuntimePool => {
  if (!productionPool) throw new Error('User API runtime pool is not initialized')
  return productionPool
}
