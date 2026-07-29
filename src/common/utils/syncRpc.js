const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const toError = value => value instanceof Error ? value : new Error(String(value))
const serializeError = error => ({
  name: typeof error?.name == 'string' ? error.name : 'Error',
  message: typeof error?.message == 'string' ? error.message : String(error),
})
const deserializeError = value => {
  const error = new Error(typeof value?.message == 'string' ? value.message : 'Remote RPC error')
  error.name = typeof value?.name == 'string' ? value.name : 'Error'
  return error
}

const createSyncRpc = ({ funcsObj, timeout = 30_000, wireProtocol = 'legacy', sendMessage, onCallBeforeParams = args => args, onError = () => {} }) => {
  let destroyed = false
  let nextId = 0
  const pending = new Map()
  const queues = new Map()
  const reportError = (error, path = [], group = null) => {
    try {
      onError(toError(error), path, group)
    } catch {}
  }
  const resolveWireProtocol = () => {
    const selected = typeof wireProtocol == 'function' ? wireProtocol() : wireProtocol
    return selected == 'current' ? 'current' : 'legacy'
  }
  const encodeCall = (protocol, id, path, args, group) => protocol == 'current'
    ? { type: 'call', id, path, args, group }
    : { name: id, path, data: args }
  const encodeResult = (protocol, id, data) => protocol == 'current'
    ? { type: 'result', id, data }
    : { name: id, error: null, data }
  const encodeError = (protocol, id, error) => protocol == 'current'
    ? { type: 'error', id, error: serializeError(error) }
    : { name: id, error: toError(error).message }
  const settlePending = (id, handler) => {
    const entry = pending.get(id)
    if (!entry) return false
    pending.delete(id)
    clearTimeout(entry.timer)
    handler(entry)
    return true
  }
  const send = (data, onSendError) => {
    try {
      const result = sendMessage(data)
      if (result && typeof result.then == 'function') result.catch(error => onSendError(toError(error)))
    } catch (error) {
      onSendError(toError(error))
    }
  }
  const callRemote = (path, args, group) => {
    if (destroyed) return Promise.reject(new Error('Sync RPC destroyed'))
    return new Promise((resolve, reject) => {
      const id = `${path.join('.')}__${Date.now().toString(36)}-${++nextId}`
      const timer = setTimeout(() => {
        settlePending(id, entry => entry.reject(new Error(`Sync RPC timeout: ${path.join('.')}`)))
      }, Math.max(1, timeout))
      pending.set(id, { resolve, reject, timer })
      send(
        encodeCall(resolveWireProtocol(), id, path, args, group),
        error => settlePending(id, entry => entry.reject(error)),
      )
    })
  }
  const drainQueue = group => {
    const state = queues.get(group)
    if (!state || state.active || destroyed) return
    const job = state.items.shift()
    if (!job) {
      queues.delete(group)
      return
    }
    state.active = true
    callRemote(job.path, job.args, group).then(job.resolve, job.reject).finally(() => {
      state.active = false
      drainQueue(group)
    })
  }
  const queueRemoteCall = (group, path, args) => {
    if (destroyed) return Promise.reject(new Error('Sync RPC destroyed'))
    return new Promise((resolve, reject) => {
      let state = queues.get(group)
      if (!state) {
        state = { active: false, items: [] }
        queues.set(group, state)
      }
      state.items.push({ path, args, resolve, reject })
      drainQueue(group)
    })
  }
  const createRemote = (path = [], group = null) => new Proxy(() => {}, {
    get(...handlerArgs) {
      const property = handlerArgs[1]
      if (property == 'then' && !path.length) return undefined
      if (typeof property != 'string') return undefined
      return createRemote([...path, property], group)
    },
    apply(...handlerArgs) {
      const args = handlerArgs[2]
      return group == null ? callRemote(path, args, null) : queueRemoteCall(group, path, args)
    },
  })
  const resolveFunction = path => {
    if (!Array.isArray(path) || !path.length || path.some(part => typeof part != 'string' || !part || BLOCKED_PATH_SEGMENTS.has(part))) throw new Error('Unknown RPC path')
    let parent = null
    let target = funcsObj
    for (const part of path) {
      if (target == null || !Object.prototype.hasOwnProperty.call(target, part)) throw new Error(`Unknown RPC path: ${path.join('.')}`)
      parent = target
      target = target[part]
    }
    if (typeof target != 'function') throw new Error(`RPC path is not a function: ${path.join('.')}`)
    return { parent, target }
  }
  const handleCall = async({ id, path: rawPath, args: rawArgs, group, protocol }) => {
    const path = Array.isArray(rawPath) ? rawPath : []
    try {
      if (typeof id != 'string' || !Array.isArray(rawArgs)) throw new Error('Invalid RPC call')
      const { parent, target } = resolveFunction(path)
      const args = await onCallBeforeParams(rawArgs)
      if (!Array.isArray(args)) throw new Error('RPC parameter hook must return an array')
      const result = await target.apply(parent, args)
      send(
        encodeResult(protocol, id, result),
        error => reportError(error, path, group),
      )
    } catch (error) {
      reportError(error, path, group)
      if (typeof id == 'string') {
        send(
          encodeError(protocol, id, error),
          sendError => reportError(sendError, path, group),
        )
      }
    }
  }
  const message = data => {
    if (destroyed || !data || typeof data != 'object') return

    switch (data.type) {
      case 'call':
        void handleCall({
          id: data.id,
          path: data.path,
          args: data.args,
          group: typeof data.group == 'string' ? data.group : null,
          protocol: 'current',
        })
        return
      case 'result':
        if (typeof data.id == 'string') {
          settlePending(data.id, entry => entry.resolve(data.data))
        }
        return
      case 'error':
        if (typeof data.id == 'string') {
          settlePending(data.id, entry => entry.reject(deserializeError(data.error)))
        }
        return
    }

    if (typeof data.name != 'string') return
    if (Array.isArray(data.path) && data.path.length) {
      void handleCall({
        id: data.name,
        path: data.path,
        args: data.data,
        group: null,
        protocol: 'legacy',
      })
      return
    }
    settlePending(data.name, entry => {
      if (data.error == null) entry.resolve(data.data)
      else entry.reject(new Error(String(data.error)))
    })
  }
  const destroy = () => {
    if (destroyed) return
    destroyed = true
    const error = new Error('Sync RPC destroyed')
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
    for (const state of queues.values()) {
      for (const job of state.items.splice(0)) job.reject(error)
    }
    queues.clear()
  }
  return { remote: createRemote(), createQueueRemote: group => createRemote([], group), message, destroy }
}
module.exports = { createSyncRpc }
