import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { rendererOn, rendererSend } from '@common/rendererIpc'
import {
  parseRendererShutdownFlushRequest,
  type RendererShutdownFlusherNameV1,
  type RendererShutdownFlushAckV1,
  type RendererShutdownFlushRequestV1,
} from '../../common/storage/shutdown'

type ShutdownFlusher = (timeoutMs: number) => Promise<boolean>

interface RendererShutdownRegistryDependencies {
  onRequest: (listener: LX.IpcRendererEventListenerParams<unknown>) => void
  sendAck: (ack: RendererShutdownFlushAckV1) => void
}

const defaultDependencies: RendererShutdownRegistryDependencies = {
  onRequest: listener => {
    rendererOn(WIN_MAIN_RENDERER_EVENT_NAME.storage_shutdown_flush_request, listener)
  },
  sendAck: ack => {
    rendererSend(WIN_MAIN_RENDERER_EVENT_NAME.storage_shutdown_flush_ack, ack)
  },
}

export const createRendererShutdownRegistry = (
  dependencies: RendererShutdownRegistryDependencies = defaultDependencies,
) => {
  const flushers = new Map<RendererShutdownFlusherNameV1, ShutdownFlusher>()

  dependencies.onRequest(async({ params }) => {
    const request: RendererShutdownFlushRequestV1 | null = parseRendererShutdownFlushRequest(params)
    if (request == null) return
    const flusher = flushers.get(request.name)
    let ok = false
    if (flusher != null) {
      try {
        ok = await flusher(request.timeoutMs)
      } catch {
        ok = false
      }
    }
    dependencies.sendAck({
      version: 1,
      requestId: request.requestId,
      name: request.name,
      ok,
    })
  })

  return {
    registerShutdownFlusher(name: RendererShutdownFlusherNameV1, flusher: ShutdownFlusher): () => void {
      flushers.set(name, flusher)
      return () => {
        if (flushers.get(name) == flusher) flushers.delete(name)
      }
    },
  }
}

const shutdownRegistry = createRendererShutdownRegistry()

export const registerShutdownFlusher = (
  name: RendererShutdownFlusherNameV1,
  flusher: ShutdownFlusher,
): (() => void) => shutdownRegistry.registerShutdownFlusher(name, flusher)
