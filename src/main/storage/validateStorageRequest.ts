import type { StorageRequestV1 } from '../../common/storage/contracts'
import { assertFiniteInteger, assertRecord } from '../../common/storage/validation'

const assertStorageRecord: (value: unknown, field: string) => asserts value is Record<string, unknown> = assertRecord
const assertStorageVersion: (value: unknown, field: string, minimum: number, maximum: number) => asserts value is number = assertFiniteInteger

const invalidRequest = (field: string): never => {
  throw new Error(`Invalid storage request ${field}`)
}

export const parseStorageRequest = (value: unknown): StorageRequestV1 => {
  assertStorageRecord(value, 'storage request')

  const keys = Object.keys(value)
  if (keys.length != 2 || !keys.includes('version') || !keys.includes('type')) invalidRequest('keys')

  assertStorageVersion(value.version, 'storage request version', 1, 1)
  if (value.type != 'capabilities.get') invalidRequest('type')

  return { version: 1, type: 'capabilities.get' }
}
