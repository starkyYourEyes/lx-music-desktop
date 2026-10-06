import * as Comlink from 'comlink'

export type MainTypes = Comlink.Remote<LX.WorkerMainTypes>

export const createMainWorker = () => {
  const worker: Worker = new Worker(new URL(
    /* webpackChunkName: 'renderer.main.worker' */
    '../main',
    import.meta.url,
  ))
  const remote = Comlink.wrap<LX.WorkerMainTypes>(worker)
  return remote
}

// export const createWorker = <T>(url: string): Comlink.Remote<T> => {
//   // @ts-expect-error
//   const worker: Worker = new Worker(new URL(url, import.meta.url))
//   return Comlink.wrap<T>(worker)
//   // worker.addEventListener('message', (event: MessageEvent) => {

//   // })
// }

export type DownloadTypes = Comlink.Remote<LX.WorkerDownloadTypes>
interface OwnedDownloadWorker {
  remote: DownloadTypes
  dispose: () => void
}

const spawnDownloadWorker = (): OwnedDownloadWorker => {
  const worker: Worker = new Worker(new URL(
    /* webpackChunkName: 'renderer.download.worker' */
    '../download',
    import.meta.url,
  ))
  const remote = Comlink.wrap<LX.WorkerDownloadTypes>(worker)
  return {
    remote,
    dispose: () => {
      try {
        remote[Comlink.releaseProxy]()
      } finally {
        worker.terminate()
      }
    },
  }
}

// This manager has no settings/store imports: globalData creates the facade before
// lxData (and therefore the reactive settings store) exists.
export const createDownloadWorkerManager = (spawn: () => OwnedDownloadWorker | Promise<OwnedDownloadWorker> = spawnDownloadWorker) => {
  let mode: 'off' | 'onDemand' | 'resident' = 'off'
  let owned: OwnedDownloadWorker | undefined
  let loading: Promise<OwnedDownloadWorker> | undefined
  let activities = 0
  let operations = 0
  let generation = 0
  let error: string | null = null
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  const getStatus = () => ({
    loaded: !!owned,
    loading: !!loading,
    active: activities > 0 || operations > 0,
    activeCount: activities,
    pendingCount: activities || operations,
    draining: mode == 'off' && (activities > 0 || operations > 0),
    error,
  })
  const scheduleDisposal = () => {
    if (mode == 'resident' || activities > 0 || operations > 0 || !!loading || !owned) return
    const version = generation
    queueMicrotask(() => {
      if (version != generation || mode == 'resident' || activities > 0 || operations > 0 || !!loading || !owned) return
      const resource = owned
      owned = undefined
      try {
        resource.dispose()
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
      emit()
    })
  }
  const ensureWorker = async() => {
    if (owned) return owned
    if (!loading) {
      loading = Promise.resolve().then(spawn).then(resource => {
        owned = resource
        error = null
        return resource
      }).catch(err => {
        error = err instanceof Error ? err.message : String(err)
        throw err
      }).finally(() => {
        loading = undefined
        emit()
        scheduleDisposal()
      })
      emit()
    }
    return loading
  }
  const allowed = (method: string) => mode != 'off' || (
    activities > 0 && ['writeMeta', 'saveLrc', 'updateUrl', 'pauseTask', 'removeTask'].includes(method)
  ) || (!!owned && ['pauseTask', 'removeTask'].includes(method))
  const facade = new Proxy({}, {
    get: (_target, method: string | symbol) => {
      if (method == 'then' || typeof method != 'string') return undefined
      return async(...args: unknown[]) => {
        if (['pauseTask', 'removeTask'].includes(method) && !owned && !loading) return
        if (!allowed(method)) throw new Error('Downloads are disabled')
        ++operations
        ++generation
        emit()
        try {
          const resource = await ensureWorker()
          // Settings may change while the shared initialization is in flight.
          if (!allowed(method)) throw new Error('Downloads are disabled')
          const invoke = resource.remote[method as keyof LX.WorkerDownloadTypes] as (...args: unknown[]) => Promise<unknown>
          return await invoke(...args)
        } finally {
          --operations
          emit()
          scheduleDisposal()
        }
      }
    },
  }) as DownloadTypes
  return {
    facade,
    getStatus,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setMode(next: typeof mode) {
      if (mode == next) return
      mode = next
      ++generation
      emit()
      scheduleDisposal()
    },
    acquire() {
      if (mode == 'off') throw new Error('Downloads are disabled')
      ++activities
      ++generation
      emit()
      let released = false
      return () => {
        if (released) return
        released = true
        --activities
        emit()
        scheduleDisposal()
      }
    },
    async prewarm() {
      if (mode != 'resident') return
      ++operations
      ++generation
      try {
        await ensureWorker()
      } finally {
        --operations
        emit()
        scheduleDisposal()
      }
    },
  }
}

export const downloadWorkerManager = createDownloadWorkerManager()
export const createDownloadWorker = () => downloadWorkerManager.facade

export const proxyCallback = <Args extends any[]>(callback: (...T: Args) => void) => {
  return Comlink.proxy(callback)
}
