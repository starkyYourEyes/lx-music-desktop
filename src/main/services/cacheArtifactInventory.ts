import fs from 'node:fs'
import path from 'node:path'

export const CACHE_DB_ARTIFACT_NAMES = Object.freeze([
  'cache.db',
  'cache.db-wal',
  'cache.db-shm',
] as const)

type CacheArtifactName = typeof CACHE_DB_ARTIFACT_NAMES[number]

export type CacheArtifactClearResult =
  | { status: 'cleared' }
  | {
    status: 'failed'
    code: 'cache_target_invalid' | 'cache_delete_failed'
    failedArtifact: CacheArtifactName | null
  }

export interface CacheArtifactInventory {
  // eslint-disable-next-line @typescript-eslint/method-signature-style -- Preserve the exported method contract.
  clearOwnedArtifacts(): CacheArtifactClearResult
}

interface CacheArtifactInventoryOptions {
  cacheRoot: string
  fileSystem?: typeof fs
  pathModule?: typeof path
}

interface FileIdentity {
  dev: number
  ino: number
}

const errorCode = (error: unknown): string | undefined =>
  error != null && typeof error == 'object' && 'code' in error && typeof error.code == 'string'
    ? error.code
    : undefined

const identity = (stats: fs.Stats): FileIdentity => ({ dev: stats.dev, ino: stats.ino })
const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev == right.dev && left.ino == right.ino

export const createCacheArtifactInventory = ({
  cacheRoot,
  fileSystem = fs,
  pathModule = path,
}: CacheArtifactInventoryOptions): CacheArtifactInventory => {
  const resolvedRoot = pathModule.resolve(cacheRoot)

  const inspectRoot = (): { realPath: string, identity: FileIdentity } | null => {
    try {
      const stats = fileSystem.lstatSync(resolvedRoot)
      if (stats.isSymbolicLink() || !stats.isDirectory()) return null
      const realPath = pathModule.resolve(fileSystem.realpathSync(resolvedRoot))
      if (pathModule.relative(resolvedRoot, realPath) != '') return null
      return { realPath, identity: identity(stats) }
    } catch {
      return null
    }
  }

  let ownedRoot: ReturnType<typeof inspectRoot> = null

  const rootIsCurrent = (): boolean => {
    const current = inspectRoot()
    return current != null && ownedRoot != null && current.realPath == ownedRoot.realPath &&
      sameIdentity(current.identity, ownedRoot.identity)
  }

  const clearArtifact = (name: CacheArtifactName): CacheArtifactClearResult => {
    if (ownedRoot == null || !rootIsCurrent()) {
      return { status: 'failed', code: 'cache_target_invalid', failedArtifact: name }
    }
    const targetPath = pathModule.resolve(resolvedRoot, name)
    if (pathModule.dirname(targetPath) != resolvedRoot) {
      return { status: 'failed', code: 'cache_target_invalid', failedArtifact: name }
    }

    let initialStats: fs.Stats
    try {
      initialStats = fileSystem.lstatSync(targetPath)
    } catch (error) {
      return errorCode(error) == 'ENOENT'
        ? { status: 'cleared' }
        : { status: 'failed', code: 'cache_target_invalid', failedArtifact: name }
    }
    if (initialStats.isSymbolicLink() || !initialStats.isFile() || initialStats.nlink != 1) {
      return { status: 'failed', code: 'cache_target_invalid', failedArtifact: name }
    }
    const expected = identity(initialStats)
    let descriptor: number | null = null
    try {
      const realTarget = pathModule.resolve(fileSystem.realpathSync(targetPath))
      if (pathModule.dirname(realTarget) != ownedRoot.realPath) {
        return { status: 'failed', code: 'cache_target_invalid', failedArtifact: name }
      }
      const noFollow = fileSystem.constants.O_NOFOLLOW ?? 0
      descriptor = fileSystem.openSync(targetPath, fileSystem.constants.O_RDONLY | noFollow)
      const guarded = fileSystem.fstatSync(descriptor)
      const published = fileSystem.lstatSync(targetPath)
      if (!rootIsCurrent() || published.isSymbolicLink() || !published.isFile() || published.nlink != 1 ||
        !guarded.isFile() || guarded.nlink != 1 || !sameIdentity(identity(guarded), expected) ||
        !sameIdentity(identity(published), expected) ||
        pathModule.dirname(pathModule.resolve(fileSystem.realpathSync(targetPath))) != ownedRoot.realPath) {
        return { status: 'failed', code: 'cache_target_invalid', failedArtifact: name }
      }
      const destructiveTarget = fileSystem.lstatSync(targetPath)
      if (!rootIsCurrent() || destructiveTarget.isSymbolicLink() || !destructiveTarget.isFile() ||
        destructiveTarget.nlink != 1 || !sameIdentity(identity(destructiveTarget), expected)) {
        return { status: 'failed', code: 'cache_target_invalid', failedArtifact: name }
      }
      fileSystem.unlinkSync(targetPath)
      return { status: 'cleared' }
    } catch (error) {
      return {
        status: 'failed',
        code: ['ENOENT', 'ELOOP'].includes(errorCode(error) ?? '')
          ? 'cache_target_invalid'
          : 'cache_delete_failed',
        failedArtifact: name,
      }
    } finally {
      if (descriptor != null) {
        try { fileSystem.closeSync(descriptor) } catch {}
      }
    }
  }

  const clearOwnedArtifacts = (): CacheArtifactClearResult => {
    ownedRoot = inspectRoot()
    if (ownedRoot == null) {
      return { status: 'failed', code: 'cache_target_invalid', failedArtifact: null }
    }
    let failure: Exclude<CacheArtifactClearResult, { status: 'cleared' }> | null = null
    for (const name of CACHE_DB_ARTIFACT_NAMES) {
      const result = clearArtifact(name)
      if (result.status == 'failed') failure ??= result
    }
    return failure ?? { status: 'cleared' }
  }

  return { clearOwnedArtifacts }
}
