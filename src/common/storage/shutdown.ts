export type RendererShutdownFlusherNameV1 = 'playback'

export interface RendererShutdownFlushRequestV1 {
  version: 1
  requestId: string
  name: RendererShutdownFlusherNameV1
  timeoutMs: number
}

export interface RendererShutdownFlushAckV1 {
  version: 1
  requestId: string
  name: RendererShutdownFlusherNameV1
  ok: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value)

const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actual = Object.keys(value)
  return actual.length == keys.length && keys.every(key => Object.hasOwn(value, key))
}

export const parseRendererShutdownFlushRequest = (value: unknown): RendererShutdownFlushRequestV1 | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'requestId', 'name', 'timeoutMs'])) return null
  if (value.version != 1 || typeof value.requestId != 'string' || value.requestId.length == 0 || value.name != 'playback') return null
  if (typeof value.timeoutMs != 'number' || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0) return null
  return value as unknown as RendererShutdownFlushRequestV1
}

export const parseRendererShutdownFlushAck = (value: unknown): RendererShutdownFlushAckV1 | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'requestId', 'name', 'ok'])) return null
  if (value.version != 1 || typeof value.requestId != 'string' || value.requestId.length == 0 || value.name != 'playback') return null
  if (typeof value.ok != 'boolean') return null
  return value as unknown as RendererShutdownFlushAckV1
}
