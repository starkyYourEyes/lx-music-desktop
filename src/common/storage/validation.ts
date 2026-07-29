const invalidField = (field: string): never => {
  throw new Error(`Invalid ${field}`)
}

export const assertRecord = (value: unknown, field: string): asserts value is Record<string, unknown> => {
  if (value == null || typeof value != 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalidField(field)
}

export const assertBoundedString = (value: unknown, field: string, minimum: number, maximum: number): asserts value is string => {
  if (typeof value != 'string' || value.length < minimum || value.length > maximum) invalidField(field)
}

export const assertFiniteInteger = (value: unknown, field: string, minimum: number, maximum: number): asserts value is number => {
  if (typeof value != 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) invalidField(field)
}

export const assertJsonByteSize = (value: unknown, field: string, maximum: number): void => {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum) invalidField(field)
}
