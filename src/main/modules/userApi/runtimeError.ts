const firstLine = (value: unknown, limit: number): string => (
  typeof value == 'string' ? value.split(/\r?\n/, 1)[0].substring(0, limit) : ''
)

const RATE_LIMIT_CODES = new Set(['RATE_LIMIT', 'TOO_MANY_REQUESTS'])
const LEGACY_RATE_LIMIT_MESSAGES = new Set(['\u670d\u52a1\u5668\u7e41\u5fd9'])
const LEGACY_SERVER_BUSY_MESSAGES = new Set(['server busy'])

export const normalizeRuntimeFailure = (
  err: unknown,
  context: { apiId: string; kind?: LX.Playback.SourceFailureKind; cancelled?: boolean },
): LX.Playback.SourceFailureData => {
  const value = err != null && typeof err == 'object' ? err as Record<string, unknown> : {}
  const statusCode = typeof value.statusCode == 'number' ? value.statusCode : undefined
  const message = firstLine(value.message, 1024) || 'Playback source request failed'
  const code = firstLine(value.code, 64).toUpperCase()
  const messageKey = message.trim().toLowerCase()
  let kind = context.kind
  if (context.cancelled) kind = 'cancelled'
  else if (!kind && (statusCode == 429 || RATE_LIMIT_CODES.has(code) ||
    LEGACY_RATE_LIMIT_MESSAGES.has(messageKey))) kind = 'rateLimit'
  else if (!kind && LEGACY_SERVER_BUSY_MESSAGES.has(messageKey)) kind = 'serverBusy'
  kind ??= 'request'
  const sourceKinds: LX.Playback.SourceFailureKind[] = [
    'initialization', 'runtimeCrash', 'rateLimit', 'serverBusy', 'sourceChanged', 'timeout',
  ]
  return {
    name: 'PlaybackSourceError',
    message,
    scope: kind == 'cancelled' ? 'session' : sourceKinds.includes(kind) ? 'source' : 'candidate',
    kind,
    apiId: context.apiId,
    ...(statusCode == null ? {} : { statusCode }),
  }
}
