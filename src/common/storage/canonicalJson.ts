import { createHash } from 'node:crypto'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

const normalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(normalize)
  if (value == null || typeof value != 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]))
}

export const canonicalJson = (value: JsonValue): string => JSON.stringify(normalize(value))
export const sha256Canonical = (value: JsonValue): string =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
