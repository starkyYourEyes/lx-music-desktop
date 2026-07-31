import { createAtomicJsonFile, type AtomicJsonFile } from './atomicJsonFile'

export type StorageOperation = 'save' | 'remove'

interface OperationJournalFileV1 {
  version: 1
  nextRevision: number
  intents: Record<string, {
    revision: number
    operation: StorageOperation
  }>
}

export interface PendingStorageOperation {
  key: string
  revision: number
  operation: StorageOperation
}

export interface OperationJournal {
  begin: (key: string, operation: StorageOperation) => Promise<number>
  complete: (key: string, revision: number) => Promise<void>
  list: () => Promise<PendingStorageOperation[]>
  flush: () => Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value)

const isRevision = (value: unknown): value is number =>
  typeof value == 'number' && Number.isSafeInteger(value) && value > 0

const isOperation = (value: unknown): value is StorageOperation => value == 'save' || value == 'remove'

const isSafeKey = (value: string): boolean =>
  value.length > 0 && value.length <= 2_048 && !['__proto__', 'constructor', 'prototype'].includes(value)

const isOperationJournalFileV1 = (value: unknown): value is OperationJournalFileV1 => {
  if (!isRecord(value) || value.version != 1 || !isRevision(value.nextRevision) || !isRecord(value.intents) ||
    Object.keys(value).some(key => !['version', 'nextRevision', 'intents'].includes(key))) return false
  return Object.entries(value.intents).every(([key, intent]) => isSafeKey(key) && isRecord(intent) &&
    Object.keys(intent).length == 2 && isRevision(intent.revision) && isOperation(intent.operation))
}

const emptyJournal = (): OperationJournalFileV1 => ({ version: 1, nextRevision: 1, intents: {} })

const cloneJournal = (value: OperationJournalFileV1): OperationJournalFileV1 => ({
  version: 1,
  nextRevision: value.nextRevision,
  intents: Object.fromEntries(Object.entries(value.intents).map(([key, intent]) => [key, { ...intent }])),
})

export const createOperationJournal = (options: {
  filePath: string
  file?: AtomicJsonFile<OperationJournalFileV1>
}): OperationJournal => {
  const file = options.file ?? createAtomicJsonFile<OperationJournalFileV1>({
    filePath: options.filePath,
    validate: isOperationJournalFileV1,
    shouldPreservePrevious: () => false,
    mode: 0o600,
  })
  let state: OperationJournalFileV1 | null = null
  let lifecycle = Promise.resolve()

  const serialize = async<Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = lifecycle.then(operation, operation)
    lifecycle = result.then(() => undefined, () => undefined)
    return await result
  }

  const load = async(): Promise<OperationJournalFileV1> => {
    if (state != null) return state
    const loaded = await file.read()
    // Journal initialization is called only from the serialized lifecycle.
    // eslint-disable-next-line require-atomic-updates
    state = loaded ?? emptyJournal()
    if (loaded == null) await file.replace(state)
    return state
  }

  const begin = async(key: string, operation: StorageOperation): Promise<number> => {
    if (!isSafeKey(key)) throw new Error('Invalid storage operation key')
    if (!isOperation(operation)) throw new Error('Invalid storage operation')
    return await serialize(async() => {
      const current = await load()
      if (current.nextRevision == Number.MAX_SAFE_INTEGER) throw new Error('Storage operation revision exhausted')
      const next = cloneJournal(current)
      const revision = next.nextRevision++
      next.intents[key] = { revision, operation }
      await file.replace(next)
      state = next
      return revision
    })
  }

  const complete = async(key: string, revision: number): Promise<void> => {
    if (!isSafeKey(key) || !isRevision(revision)) throw new Error('Invalid storage operation completion')
    await serialize(async() => {
      const current = await load()
      if (current.intents[key]?.revision != revision) return
      const next = cloneJournal(current)
      Reflect.deleteProperty(next.intents, key)
      await file.replace(next)
      state = next
    })
  }

  const list = async(): Promise<PendingStorageOperation[]> => await serialize(async() => {
    const current = await load()
    return Object.entries(current.intents).map(([key, intent]) => ({ key, ...intent }))
  })

  const flush = async(): Promise<void> => {
    await lifecycle
    await file.flush()
  }

  return { begin, complete, list, flush }
}
