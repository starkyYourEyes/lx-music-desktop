export type SessionCacheCategory = 'cache' | 'cache-storage' | 'code-cache'

export type SessionClearResult =
  | { key: string, category: SessionCacheCategory, status: 'cleared' }
  | {
    key: string
    category: SessionCacheCategory
    status: 'failed'
    code: 'session_cache_clear_failed'
  }

export interface SessionRegistration {
  ready: Promise<void>
  unregister: () => void
}

export interface SessionRegistry {
  register: (input: { key: string, session: Electron.Session }) => SessionRegistration
  clearRegisteredCaches: () => Promise<SessionClearResult[]>
}

interface SessionRecord {
  key: string
  session: Electron.Session
  tokens: Set<symbol>
}

interface Deferred<Value> {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (reason?: unknown) => void
}

interface ClearOperation {
  promise: Promise<SessionClearResult[]>
  ready: Deferred<void>
  pending: Set<SessionRecord>
  admitted: Set<SessionRecord>
  results: SessionClearResult[]
  resolve: (results: SessionClearResult[]) => void
  reject: (reason?: unknown) => void
}

const KEY_RXP = /^[a-z0-9][a-z0-9:_-]{0,127}$/
const categories: Array<{
  category: SessionCacheCategory
  clear: (session: Electron.Session) => Promise<void>
}> = [
  { category: 'cache', clear: async session => session.clearCache() },
  {
    category: 'cache-storage',
    clear: async session => session.clearStorageData({ storages: ['cachestorage'] }),
  },
  { category: 'code-cache', clear: async session => session.clearCodeCaches({}) },
]

const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })
  return { promise, resolve, reject }
}

export const createSessionRegistry = (): SessionRegistry => {
  const records = new Map<string, SessionRecord>()
  const sessionKeys = new WeakMap<Electron.Session, string>()
  let activeClear: ClearOperation | null = null

  const clearRecord = async(record: SessionRecord, results: SessionClearResult[]) => {
    for (const { category, clear } of categories) {
      try {
        await clear(record.session)
        results.push({ key: record.key, category, status: 'cleared' })
      } catch {
        results.push({
          key: record.key,
          category,
          status: 'failed',
          code: 'session_cache_clear_failed',
        })
      }
    }
  }

  const runClear = async(operation: ClearOperation) => {
    while (true) {
      if (!operation.pending.size) {
        if (activeClear === operation) activeClear = null
        operation.ready.resolve()
        operation.resolve(operation.results)
        return
      }
      const batch = [...operation.pending]
      operation.pending.clear()
      await Promise.all(batch.map(async record => clearRecord(record, operation.results)))
    }
  }

  const register = ({ key, session }: { key: string, session: Electron.Session }): SessionRegistration => {
    if (!KEY_RXP.test(key)) throw new Error('invalid_session_registry_key')

    const admittedRecordForKey = activeClear
      ? [...activeClear.admitted].find(record => record.key == key)
      : undefined
    const admittedRecordForSession = activeClear
      ? [...activeClear.admitted].find(record => record.session === session)
      : undefined
    const recordForKey = records.get(key) ?? admittedRecordForKey
    const keyForSession = sessionKeys.get(session)
    if (recordForKey && recordForKey.session !== session) {
      throw new Error('session_registry_key_collision')
    }
    if (keyForSession && keyForSession != key) {
      throw new Error('session_registry_identity_collision')
    }
    if (admittedRecordForSession && admittedRecordForSession.key != key) {
      throw new Error('session_registry_identity_collision')
    }

    const record = recordForKey ?? { key, session, tokens: new Set<symbol>() }
    if (!records.has(key)) {
      records.set(key, record)
      sessionKeys.set(session, key)
      if (activeClear && !activeClear.admitted.has(record)) {
        activeClear.admitted.add(record)
        activeClear.pending.add(record)
      }
    }

    const token = Symbol(key)
    record.tokens.add(token)
    let registered = true
    return {
      ready: activeClear?.ready.promise ?? Promise.resolve(),
      unregister() {
        if (!registered) return
        registered = false
        if (!record.tokens.delete(token) || record.tokens.size) return
        if (records.get(key) !== record) return
        records.delete(key)
        sessionKeys.delete(session)
      },
    }
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- Preserve the shared single-flight promise identity.
  const clearRegisteredCaches = (): Promise<SessionClearResult[]> => {
    if (activeClear) return activeClear.promise

    const completion = deferred<SessionClearResult[]>()
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- The deferred signal intentionally has no value.
    const ready = deferred<void>()
    const initial = [...records.values()]
    const operation: ClearOperation = {
      promise: completion.promise,
      ready,
      pending: new Set(initial),
      admitted: new Set(initial),
      results: [],
      resolve: completion.resolve,
      reject: completion.reject,
    }
    activeClear = operation

    void runClear(operation).catch(error => {
      if (activeClear === operation) activeClear = null
      operation.ready.resolve()
      operation.reject(error)
    })
    return operation.promise
  }

  return { register, clearRegisteredCaches }
}
