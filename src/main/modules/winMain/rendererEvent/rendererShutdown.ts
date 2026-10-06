import {
  parseRendererShutdownFlushAck,
  type RendererShutdownFlushAckV1,
  type RendererShutdownFlushRequestV1,
  type RendererShutdownFlusherNameV1,
} from '../../../../common/storage/shutdown'

interface RendererShutdownBridgeDependencies {
  registerShutdownFlusher: (name: string, flush: () => Promise<void>) => () => void
  send: (request: RendererShutdownFlushRequestV1) => void
  isRendererAlive: () => boolean
  createRequestId: () => string
  setTimeout: (callback: () => void, timeoutMs: number) => unknown
  clearTimeout: (timer: unknown) => void
}

interface PendingFlush {
  name: RendererShutdownFlusherNameV1
  timer: unknown
  resolve: () => void
  reject: (error: Error) => void
}

const flushError = (code: string): Error => new Error(code)

export const createRendererShutdownBridge = (dependencies: RendererShutdownBridgeDependencies) => {
  const pending = new Map<string, PendingFlush>()
  let unregisterPlayback: (() => void) | null = null

  const flushRenderer = async(name: RendererShutdownFlusherNameV1 = 'playback'): Promise<void> => {
    if (!dependencies.isRendererAlive()) throw flushError('renderer_unavailable')
    const requestId = dependencies.createRequestId()
    const request: RendererShutdownFlushRequestV1 = {
      version: 1,
      requestId,
      name,
      timeoutMs: name == 'playback' ? 2_500 : 30_000,
    }
    await new Promise<void>((resolve, reject) => {
      const timer = dependencies.setTimeout(() => {
        if (!pending.delete(requestId)) return
        reject(flushError('renderer_playback_flush_timeout'))
      }, request.timeoutMs)
      pending.set(requestId, { timer, resolve, reject, name })
      try {
        dependencies.send(request)
      } catch (error) {
        dependencies.clearTimeout(timer)
        pending.delete(requestId)
        reject(error instanceof Error ? error : flushError('renderer_playback_flush_failed'))
      }
    })
  }

  return {
    flushPlayback: async() => flushRenderer('playback'),
    flushPerformance: async() => flushRenderer('performance'),
    registerPlayback() {
      unregisterPlayback ??= dependencies.registerShutdownFlusher('playback', async() => flushRenderer('playback'))
      return unregisterPlayback
    },
    acknowledge(value: unknown): boolean {
      const ack: RendererShutdownFlushAckV1 | null = parseRendererShutdownFlushAck(value)
      if (ack == null) return false
      const entry = pending.get(ack.requestId)
      if (entry == null || entry.name != ack.name) return false
      dependencies.clearTimeout(entry.timer)
      pending.delete(ack.requestId)
      if (ack.ok) entry.resolve()
      else entry.reject(flushError('renderer_playback_flush_failed'))
      return true
    },
    pendingCount: () => pending.size,
  }
}
