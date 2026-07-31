import { createHash } from 'node:crypto'
import path from 'node:path'
import syncFs from 'node:fs'
import fs from 'node:fs/promises'
import { canonicalJson, type JsonValue } from '../../common/storage/canonicalJson'

export type AtomicFileSystem = Pick<typeof fs, 'mkdir' | 'open' | 'readFile' | 'readdir' | 'rename' | 'stat' | 'unlink'>

export interface AtomicJsonStage {
  readonly filePath: string
  readonly fileSha256: string
}

export interface AtomicJsonFile<T> {
  read: () => Promise<T | null>
  stage: (value: T, label?: 'next') => Promise<AtomicJsonStage>
  commit: (stage: AtomicJsonStage) => Promise<{ fileSha256: string }>
  replace: (value: T) => Promise<{ fileSha256: string }>
  flush: () => Promise<void>
  cleanupOwnedTemps: () => Promise<void>
}

interface FileIdentity {
  dev: number | bigint
  ino: number | bigint
  size: number | bigint
  mtimeMs: number | bigint
  ctimeMs: number | bigint
}

interface StageRecord {
  filePath: string
  fileSha256: string
  identity: FileIdentity
}

const isMissing = (error: unknown): error is NodeJS.ErrnoException => {
  return error instanceof Error && 'code' in error && error.code == 'ENOENT'
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const identityOf = (stats: Awaited<ReturnType<typeof fs.stat>>): FileIdentity => ({
  dev: stats.dev,
  ino: stats.ino,
  size: stats.size,
  mtimeMs: stats.mtimeMs,
  ctimeMs: stats.ctimeMs,
})

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean => {
  return left.dev == right.dev &&
    left.ino == right.ino &&
    left.size == right.size &&
    left.mtimeMs == right.mtimeMs &&
    left.ctimeMs == right.ctimeMs
}

let tempCounter = 0
const cleanupInFlightByFile = new Map<string, Promise<void>>()
const activeOwnedTempsByFile = new Map<string, Set<string>>()

const ownedTempPattern = (basename: string): RegExp =>
  new RegExp(`^${basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.owned-tmp-\\d+-\\d+$`)

const isActiveOwnedTemp = (filePath: string, ownedPath: string): boolean =>
  activeOwnedTempsByFile.get(filePath)?.has(ownedPath) == true

const markOwnedTempActive = (filePath: string, ownedPath: string): void => {
  let active = activeOwnedTempsByFile.get(filePath)
  if (active == null) activeOwnedTempsByFile.set(filePath, active = new Set())
  active.add(ownedPath)
}

const markOwnedTempInactive = (filePath: string, ownedPath: string): void => {
  const active = activeOwnedTempsByFile.get(filePath)
  if (active == null) return
  active.delete(ownedPath)
  if (!active.size) activeOwnedTempsByFile.delete(filePath)
}

export const cleanupAtomicJsonOwnedTempsSync = (targetPath: string): void => {
  const filePath = path.resolve(targetPath)
  const directoryPath = path.dirname(filePath)
  const pattern = ownedTempPattern(path.basename(filePath))
  let entries: string[]
  try {
    entries = syncFs.readdirSync(directoryPath)
  } catch (error) {
    if (!isMissing(error)) throw error
    return
  }
  for (const entry of entries) {
    if (!pattern.test(entry)) continue
    const ownedPath = path.join(directoryPath, entry)
    if (isActiveOwnedTemp(filePath, ownedPath)) continue
    try {
      syncFs.unlinkSync(ownedPath)
    } catch {}
  }
}

export function createAtomicJsonFile<T>(options: {
  filePath: string
  validate: (value: unknown) => value is T
  shouldPreservePrevious?: (current: T) => boolean
  allowInvalidPrevious?: boolean
  mode?: number
  fs?: AtomicFileSystem
  initialCleanupComplete?: boolean
}): AtomicJsonFile<T> {
  const filePath = path.resolve(options.filePath)
  const directoryPath = path.dirname(filePath)
  const basename = path.basename(filePath)
  const ownedPrefix = `${basename}.owned-tmp-`
  const ownedPattern = ownedTempPattern(basename)
  const fileSystem = options.fs ?? fs
  const mode = options.mode ?? 0o600
  const stageRecords = new WeakMap<AtomicJsonStage, StageRecord>()
  let queuePromise: Promise<{ fileSha256: string }> | null = null
  let pendingValue: T | undefined
  let hasPendingValue = false
  let initialCleanupPromise = options.initialCleanupComplete ? Promise.resolve() : null

  const isValid = (value: unknown): value is T => {
    try {
      return options.validate(value)
    } catch {
      return false
    }
  }

  const parseAndValidate = (bytes: string, description: string): T => {
    let value: unknown
    try {
      value = JSON.parse(bytes)
    } catch {
      throw new Error(`Atomic JSON ${description} is not valid JSON`)
    }
    if (!isValid(value)) throw new Error(`Atomic JSON ${description} is not valid`)
    return value
  }

  const nextOwnedTempPath = (): string => {
    tempCounter++
    return path.join(directoryPath, `${ownedPrefix}${process.pid}-${tempCounter}`)
  }

  const writeDurableBytes = async(destination: string, bytes: string, exclusive: boolean): Promise<FileIdentity> => {
    await fileSystem.mkdir(directoryPath, { recursive: true })
    const handle = await fileSystem.open(destination, exclusive ? 'wx' : 'w', mode)
    let operationFailed = false
    let operationError: unknown
    try {
      await handle.writeFile(bytes, 'utf8')
      await handle.sync()
    } catch (error) {
      operationFailed = true
      operationError = error
    }
    let closeFailed = false
    let closeError: unknown
    try {
      await handle.close()
    } catch (error) {
      closeFailed = true
      closeError = error
    }
    if (operationFailed) await Promise.reject(operationError)
    if (closeFailed) await Promise.reject(closeError)
    return identityOf(await fileSystem.stat(destination))
  }

  const removeBestEffort = async(targetPath: string): Promise<void> => {
    try {
      await fileSystem.unlink(targetPath)
    } catch {}
  }

  const syncDirectoryBestEffort = async(): Promise<void> => {
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null
    try {
      handle = await fileSystem.open(directoryPath, 'r')
      await handle.sync()
    } catch {
      // Directory fsync is unavailable on some supported filesystems.
    } finally {
      try {
        await handle?.close()
      } catch {}
    }
  }

  const cleanupOwnedTempsOnce = async(): Promise<void> => {
    if (initialCleanupPromise == null) {
      let sharedCleanup = cleanupInFlightByFile.get(filePath)
      if (sharedCleanup == null) {
        sharedCleanup = (async() => {
          let entries: string[]
          try {
            entries = await fileSystem.readdir(directoryPath)
          } catch (error) {
            if (isMissing(error)) return
            throw error
          }
          await Promise.all(entries.map(async entry => {
            if (!ownedPattern.test(entry)) return
            const ownedPath = path.join(directoryPath, entry)
            if (isActiveOwnedTemp(filePath, ownedPath)) return
            await removeBestEffort(ownedPath)
          }))
        })()
        cleanupInFlightByFile.set(filePath, sharedCleanup)
        void sharedCleanup.then(() => {
          if (cleanupInFlightByFile.get(filePath) == sharedCleanup) cleanupInFlightByFile.delete(filePath)
        }, () => {
          if (cleanupInFlightByFile.get(filePath) == sharedCleanup) cleanupInFlightByFile.delete(filePath)
        })
      }
      initialCleanupPromise = sharedCleanup
    }
    await initialCleanupPromise
  }

  const read = async(): Promise<T | null> => {
    await cleanupOwnedTempsOnce()
    let bytes: string
    try {
      bytes = await fileSystem.readFile(filePath, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    return parseAndValidate(bytes, 'destination')
  }

  const stage = async(value: T, label?: 'next'): Promise<AtomicJsonStage> => {
    await cleanupOwnedTempsOnce()
    if (!isValid(value)) throw new Error('Atomic JSON value is not valid')
    let bytes: string
    try {
      const serialized: unknown = canonicalJson(value as JsonValue)
      if (typeof serialized != 'string') throw new Error('invalid_serialized_value')
      bytes = serialized
    } catch {
      throw new Error('Atomic JSON value is not valid')
    }
    const stagedPath = label == 'next' ? `${filePath}.next` : nextOwnedTempPath()
    if (label == null) markOwnedTempActive(filePath, stagedPath)
    try {
      const identity = await writeDurableBytes(stagedPath, bytes, label == null)
      parseAndValidate(bytes, 'stage')
      const fileSha256 = sha256(bytes)
      const result = Object.freeze({ filePath: stagedPath, fileSha256 })
      stageRecords.set(result, { filePath: stagedPath, fileSha256, identity })
      return result
    } catch (error) {
      await removeBestEffort(stagedPath)
      markOwnedTempInactive(filePath, stagedPath)
      throw error
    }
  }

  const verifyStage = async(candidate: AtomicJsonStage): Promise<{ record: StageRecord, bytes: string }> => {
    const record = stageRecords.get(candidate)
    if (record == null || candidate.filePath != record.filePath || candidate.fileSha256 != record.fileSha256) {
      throw new Error('Atomic JSON stage is not recognized')
    }
    const identity = identityOf(await fileSystem.stat(record.filePath))
    if (!sameIdentity(identity, record.identity)) throw new Error('Atomic JSON stage identity changed')
    const bytes = await fileSystem.readFile(record.filePath, 'utf8')
    if (sha256(bytes) != record.fileSha256) throw new Error('Atomic JSON stage hash changed')
    parseAndValidate(bytes, 'stage')
    return { record, bytes }
  }

  const preservePrevious = async(bytes: string): Promise<void> => {
    const tempPath = nextOwnedTempPath()
    markOwnedTempActive(filePath, tempPath)
    try {
      await writeDurableBytes(tempPath, bytes, true)
      parseAndValidate(await fileSystem.readFile(tempPath, 'utf8'), 'previous stage')
      await fileSystem.rename(tempPath, `${filePath}.previous`)
      markOwnedTempInactive(filePath, tempPath)
      const readBack = await fileSystem.readFile(`${filePath}.previous`, 'utf8')
      parseAndValidate(readBack, 'previous read-back')
      if (sha256(readBack) != sha256(bytes)) throw new Error('Atomic JSON previous read-back hash changed')
    } catch (error) {
      await removeBestEffort(tempPath)
      markOwnedTempInactive(filePath, tempPath)
      throw error
    }
  }

  const removePrevious = async(): Promise<void> => {
    try {
      await fileSystem.unlink(`${filePath}.previous`)
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    await syncDirectoryBestEffort()
  }

  const commit = async(candidate: AtomicJsonStage): Promise<{ fileSha256: string }> => {
    const { record } = await verifyStage(candidate)
    let destinationBytes: string | null = null
    try {
      destinationBytes = await fileSystem.readFile(filePath, 'utf8')
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (destinationBytes != null) {
      let destination: T | null = null
      try {
        destination = parseAndValidate(destinationBytes, 'durable destination')
      } catch (error) {
        if (!options.allowInvalidPrevious) throw error
      }
      if (destination != null && (options.shouldPreservePrevious?.(destination) ?? true)) {
        await preservePrevious(destinationBytes)
      } else {
        await removePrevious()
      }
    }

    let replaced = false
    try {
      await fileSystem.rename(record.filePath, filePath)
      replaced = true
      markOwnedTempInactive(filePath, record.filePath)
      const readBack = await fileSystem.readFile(filePath, 'utf8')
      parseAndValidate(readBack, 'destination read-back')
      if (sha256(readBack) != record.fileSha256) throw new Error('Atomic JSON destination read-back hash changed')
      await syncDirectoryBestEffort()
      return { fileSha256: record.fileSha256 }
    } finally {
      if (replaced) stageRecords.delete(candidate)
    }
  }

  const replaceOne = async(value: T): Promise<{ fileSha256: string }> => {
    const staged = await stage(value)
    try {
      return await commit(staged)
    } catch (error) {
      stageRecords.delete(staged)
      markOwnedTempInactive(filePath, staged.filePath)
      await removeBestEffort(staged.filePath)
      throw error
    }
  }

  const runQueue = async(initialValue: T): Promise<{ fileSha256: string }> => {
    let value = initialValue
    let result: { fileSha256: string }
    while (true) {
      result = await replaceOne(value)
      if (!hasPendingValue) return result
      value = pendingValue as T
      pendingValue = undefined
      hasPendingValue = false
    }
  }

  // Coalesced writers must receive the exact shared queue Promise.
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  const replace = (value: T): Promise<{ fileSha256: string }> => {
    if (queuePromise != null) {
      pendingValue = value
      hasPendingValue = true
      return queuePromise
    }
    queuePromise = runQueue(value).finally(() => {
      queuePromise = null
      pendingValue = undefined
      hasPendingValue = false
    })
    return queuePromise
  }

  const flush = async(): Promise<void> => {
    if (queuePromise != null) await queuePromise
  }

  const cleanupOwnedTemps = async(): Promise<void> => cleanupOwnedTempsOnce()

  return { read, stage, commit, replace, flush, cleanupOwnedTemps }
}
