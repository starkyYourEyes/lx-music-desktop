const MAX_IDENTIFIER_LENGTH = 256
const identifierPattern = /^[a-zA-Z0-9_./:-]+$/

const isIdentifier = (value: unknown): value is string => (
  typeof value == 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH && identifierPattern.test(value)
)

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  value != null && typeof value == 'object' && Object.getPrototypeOf(value) == Object.prototype
)

const hasExactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => {
  const keys = Object.keys(value)
  return required.every(key => Object.hasOwn(value, key)) &&
    keys.every(key => required.includes(key) || optional.includes(key))
}

export type UserApiRequestPayload =
  | { requestKey: string, data: unknown }
  | { apiId: string, requestId: string, data: unknown }

export type UserApiCancellationPayload =
  | string
  | { apiId: string, requestId: string, reason?: 'cancelled' | 'timeout' }

export const parseUserApiRequestPayload = (value: unknown): UserApiRequestPayload => {
  if (!isPlainObject(value)) throw new Error('Invalid User API request payload')
  if (hasExactKeys(value, ['requestKey', 'data']) && isIdentifier(value.requestKey)) {
    return { requestKey: value.requestKey, data: value.data }
  }
  if (hasExactKeys(value, ['apiId', 'requestId', 'data']) && isIdentifier(value.apiId) && isIdentifier(value.requestId)) {
    return { apiId: value.apiId, requestId: value.requestId, data: value.data }
  }
  throw new Error('Invalid User API request payload')
}

export const parseUserApiCancellationPayload = (value: unknown): UserApiCancellationPayload => {
  if (isIdentifier(value)) return value
  if (!isPlainObject(value) || !hasExactKeys(value, ['apiId', 'requestId'], ['reason'])) {
    throw new Error('Invalid User API cancellation payload')
  }
  const reason = value.reason
  if (!isIdentifier(value.apiId) || !isIdentifier(value.requestId) ||
    (reason != null && reason != 'cancelled' && reason != 'timeout')) {
    throw new Error('Invalid User API cancellation payload')
  }
  if (reason == 'cancelled') return { apiId: value.apiId, requestId: value.requestId, reason: 'cancelled' }
  if (reason == 'timeout') return { apiId: value.apiId, requestId: value.requestId, reason: 'timeout' }
  return { apiId: value.apiId, requestId: value.requestId }
}
