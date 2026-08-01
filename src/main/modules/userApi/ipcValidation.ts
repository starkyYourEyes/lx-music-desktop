const MAX_IDENTIFIER_LENGTH = 256
const MAX_RUNTIME_LEASE_SOURCE_COUNT = 1024
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

export interface UserApiRequestPayload { apiId: string, requestId: string, data: unknown }

export interface UserApiCancellationPayload {
  apiId: string
  requestId: string
  reason?: 'cancelled' | 'timeout'
}

const invalidEnsurePayload = (): never => {
  throw new Error('Invalid User API ensure payload')
}

const invalidRuntimeLeasePayload = (): never => {
  throw new Error('Invalid User API runtime lease payload')
}

export const parseUserApiRequestPayload = (value: unknown): UserApiRequestPayload => {
  if (!isPlainObject(value)) throw new Error('Invalid User API request payload')
  if (hasExactKeys(value, ['apiId', 'requestId', 'data']) && isIdentifier(value.apiId) && isIdentifier(value.requestId)) {
    return { apiId: value.apiId, requestId: value.requestId, data: value.data }
  }
  throw new Error('Invalid User API request payload')
}

export const parseUserApiCancellationPayload = (value: unknown): UserApiCancellationPayload => {
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

export const parseUserApiEnsurePayload = (value: unknown): string => {
  if (!isIdentifier(value)) return invalidEnsurePayload()
  return value
}

export const parseUserApiRuntimeLeasePayload = (value: unknown): LX.UserApi.UserApiRuntimeLeaseParams => {
  try {
    if (value == null || typeof value != 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return invalidRuntimeLeasePayload()
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length != 2 || keys.some(key => key != 'apiIds' && key != 'leaseId')) {
      return invalidRuntimeLeasePayload()
    }
    const apiIdsDescriptor = descriptors.apiIds
    const leaseIdDescriptor = descriptors.leaseId
    if (apiIdsDescriptor == null || !apiIdsDescriptor.enumerable || !Object.hasOwn(apiIdsDescriptor, 'value') ||
      leaseIdDescriptor == null || !leaseIdDescriptor.enumerable || !Object.hasOwn(leaseIdDescriptor, 'value') ||
      !isIdentifier(leaseIdDescriptor.value)) return invalidRuntimeLeasePayload()

    const apiIds = apiIdsDescriptor.value
    if (!Array.isArray(apiIds) || Object.getPrototypeOf(apiIds) !== Array.prototype) return invalidRuntimeLeasePayload()
    const apiIdDescriptors = Object.getOwnPropertyDescriptors(apiIds) as unknown as Record<PropertyKey, PropertyDescriptor>
    const lengthDescriptor = apiIdDescriptors.length
    if (lengthDescriptor == null || lengthDescriptor.enumerable) return invalidRuntimeLeasePayload()
    if (!Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > MAX_RUNTIME_LEASE_SOURCE_COUNT ||
      Reflect.ownKeys(apiIdDescriptors).length != lengthDescriptor.value + 1) return invalidRuntimeLeasePayload()
    const parsedApiIds: string[] = []
    for (let index = 0; index < lengthDescriptor.value; index++) {
      const descriptor = apiIdDescriptors[index]
      if (descriptor == null || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
        !isIdentifier(descriptor.value)) return invalidRuntimeLeasePayload()
      parsedApiIds.push(descriptor.value)
    }
    return { apiIds: parsedApiIds, leaseId: leaseIdDescriptor.value }
  } catch {
    return invalidRuntimeLeasePayload()
  }
}
