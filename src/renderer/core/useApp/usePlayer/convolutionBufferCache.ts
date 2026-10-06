// Keep the current impulse and one recently used impulse. A late decode after
// clear() must not retain its buffer in the cache.
export const createConvolutionBufferCache = <T>(load: (name: string, signal: AbortSignal) => Promise<T>) => {
  const buffers = new Map<string, T>()
  const pending = new Map<string, Promise<T>>()
  const controllers = new Set<AbortController>()
  let generation = 0
  let currentName = ''
  return {
    async get(name: string): Promise<T> {
      currentName = name
      const cached = buffers.get(name)
      if (cached != null) {
        buffers.delete(name)
        buffers.set(name, cached)
        return Promise.resolve(cached)
      }
      const loading = pending.get(name)
      if (loading) return loading
      const token = generation
      const controller = new AbortController()
      controllers.add(controller)
      const result = load(name, controller.signal).then(buffer => {
        if (token == generation) {
          buffers.set(name, buffer)
          while (buffers.size > 2) buffers.delete([...buffers.keys()].find(key => key != currentName)!)
        }
        return buffer
      }).finally(() => {
        controllers.delete(controller)
        if (pending.get(name) == result) pending.delete(name)
      })
      pending.set(name, result)
      return result
    },
    clear() {
      generation++
      buffers.clear()
      pending.clear()
      for (const controller of controllers) controller.abort()
      controllers.clear()
    },
  }
}
