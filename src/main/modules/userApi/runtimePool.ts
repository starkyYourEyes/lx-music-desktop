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
}

interface RuntimeCreationState {
  apiId: string
  generation: number
  promise: Promise<RuntimeRecord>
  disposeWhenIdle: boolean
  disposeReason: 'idle' | 'invalidate' | 'explicit' | null
  clearSession: boolean
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
  request(params: LX.UserApi.UserApiRequestParams, ownerWebContentsId: number): Promise<LX.UserApi.UserApiRequestResult>
  cancel(params: LX.UserApi.UserApiRequestCancelParams, ownerWebContentsId: number): void
  acquireLease(params: LX.UserApi.UserApiRuntimeLeaseParams, ownerWebContentsId: number): void
  releaseLease(params: LX.UserApi.UserApiRuntimeLeaseParams, ownerWebContentsId: number): Promise<void>
  releaseOwner(ownerWebContentsId: number): Promise<void>
  markConfigured(apiIds: ReadonlySet<string>): Promise<void>
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

export const createUserApiRuntimePool: CreateUserApiRuntimePool = deps => {
  const recordsByApiId = new Map<string, RuntimeRecord>()
  const bindingsByWebContentsId = new Map<number, LX.UserApi.UserApiRuntimeIdentity>()
  const leasesByApiId = new Map<string, Map<number, Set<string>>>()
  const configuredApiIds = new Set(deps.initialConfiguredApiIds)
  const pendingByApiId = new Map<string, Map<string, PendingRequest>>()
  const creatingByApiId = new Map<string, RuntimeCreationState>()
  const retiringByApiId = new Map<string, Promise<void>>()
  const nextGenerationByApiId = new Map<string, number>()

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
    record.rejectInit(failure)
  }

  const removeRecord = (record: RuntimeRecord) => {
    if (recordsByApiId.get(record.apiId) == record) recordsByApiId.delete(record.apiId)
    const binding = bindingsByWebContentsId.get(record.runtime.webContentsId)
    if (binding?.apiId == record.apiId && binding.generation == record.generation) {
      bindingsByWebContentsId.delete(record.runtime.webContentsId)
    }
  }

  const retireRecord = async(
    record: RuntimeRecord,
    options: { clearSession: boolean, failure?: LX.Playback.SourceFailureData },
  ): Promise<void> => {
    const existing = retiringByApiId.get(record.apiId)
    if (record.disposing) return existing ?? Promise.resolve()
    record.disposing = true
    removeRecord(record)
    if (options.failure) rejectInit(record, options.failure)
    let retiring!: Promise<void>
    retiring = deps.disposeRuntimeWindow(record.runtime, { clearSession: options.clearSession })
      .finally(() => {
        if (retiringByApiId.get(record.apiId) == retiring) retiringByApiId.delete(record.apiId)
      })
    retiringByApiId.set(record.apiId, retiring)
    return retiring
  }

  const failInitialization = (record: RuntimeRecord, reason: unknown) => {
    if (recordsByApiId.get(record.apiId) != record || record.disposing) return
    const failure = normalizeRuntimeFailure(reason, { apiId: record.apiId, kind: 'initialization' })
    const apiInfo = deps.getApiInfo(record.apiId)
    record.status = { apiId: record.apiId, status: false, message: failure.message, ...(apiInfo ? { apiInfo } : {}) }
    deps.publishStatus({ ...record.status })
    const retiring = retireRecord(record, { clearSession: false, failure })
    settleSource(record.apiId, failure)
    observeLifecycle(`retire failed user API runtime ${record.apiId}`, retiring)
  }

  const ensureRecord = async(apiId: string): Promise<RuntimeRecord> => {
    const retiring = retiringByApiId.get(apiId)
    if (retiring) {
      await retiring
      return ensureRecord(apiId)
    }
    const record = recordsByApiId.get(apiId)
    if (record && !record.disposing) return record
    const creating = creatingByApiId.get(apiId)
    if (creating) {
      if (creating.disposeReason == null || creating.disposeReason == 'idle') return creating.promise
      try { await creating.promise } catch (_) {}
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
      clearSession: false,
    }
    state.promise = Promise.resolve().then(async() => {
      const runtime = await deps.createRuntimeWindow({
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
      })

      if (state.disposeReason == 'idle' &&
        (configuredApiIds.has(apiId) || hasLeases(apiId) || (pendingByApiId.get(apiId)?.size ?? 0) > 0)) {
        state.disposeReason = null
        state.disposeWhenIdle = !configuredApiIds.has(apiId)
      }
      if (creatingByApiId.get(apiId) != state || state.disposeReason != null) {
        await deps.disposeRuntimeWindow(runtime, { clearSession: false })
        if (state.clearSession) await deps.clearRuntimeSession(apiId)
        const failure = messageFailure(apiId, 'sourceChanged', 'User API source changed')
        throw Object.assign(new Error(failure.message), failure)
      }

      creatingByApiId.delete(apiId)
      let resolveInit!: RuntimeRecord['resolveInit']
      let rejectInitPromise!: RuntimeRecord['rejectInit']
      const initPromise = new Promise<LX.UserApi.UserApiInfo>((resolve, reject) => {
        resolveInit = resolve
        rejectInitPromise = reject
      })
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
      }
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
    }).finally(() => {
      if (creatingByApiId.get(apiId) == state) creatingByApiId.delete(apiId)
    })
    creatingByApiId.set(apiId, state)
    return state.promise
  }

  const ensure = async(apiId: string) => {
    const record = await ensureRecord(apiId)
    return record.initPromise
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
    if (kind == 'runtimeCrash') {
      const apiInfo = deps.getApiInfo(apiId)
      record.status = { apiId, status: false, message: failure.message, ...(apiInfo ? { apiInfo } : {}) }
      deps.publishStatus({ ...record.status })
    }
    const retiring = retireRecord(record, { clearSession: false, failure })
    settleSource(apiId, failure)
    await retiring
  }

  dispose = async(apiId, options) => {
    leasesByApiId.delete(apiId)
    const failure = messageFailure(apiId, 'sourceChanged', 'User API source changed')
    const creating = creatingByApiId.get(apiId)
    if (creating) {
      creating.disposeReason = 'explicit'
      creating.clearSession ||= options.clearSession
      settleSource(apiId, failure)
      try { await creating.promise } catch (_) {}
      return
    }
    const record = recordsByApiId.get(apiId)
    if (record) {
      const retiring = retireRecord(record, { clearSession: options.clearSession, failure })
      settleSource(apiId, failure)
      await retiring
      return
    }
    settleSource(apiId, failure)
    const retiring = retiringByApiId.get(apiId)
    if (retiring) await retiring
    if (options.clearSession) await deps.clearRuntimeSession(apiId)
  }

  disposeIfIdle = async(apiId: string) => {
    if ((pendingByApiId.get(apiId)?.size ?? 0) > 0 || hasLeases(apiId)) return
    if (configuredApiIds.has(apiId)) return
    const record = recordsByApiId.get(apiId)
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
      settlePending(apiId, requestId, {
        ok: false,
        error: normalizeRuntimeFailure(new Error('User API request replaced'), { apiId, cancelled: true }),
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

  const acceptInit: UserApiRuntimePool['acceptInit'] = (senderId, envelope) => {
    const record = getBoundRecord(senderId, envelope.identity)
    if (!record || record.initSettled) return false
    if (!envelope.status) {
      failInitialization(record, { message: envelope.message })
      return true
    }
    const apiInfo = deps.getApiInfo(record.apiId)
    if (!apiInfo) {
      failInitialization(record, new Error('User API source is not found'))
      return true
    }
    const initializedInfo = { ...apiInfo, sources: envelope.data.sources }
    record.initSettled = true
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
      error: normalizeRuntimeFailure({ message: envelope.message }, { apiId: record.apiId }),
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
        ...retiringByApiId.keys(),
      ])
      const results = await Promise.allSettled([...ids].map(async apiId => {
        const retiring = retiringByApiId.get(apiId)
        if (retiring) return retiring
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
