import fs from 'node:fs'
import path from 'node:path'
import {
  closeDirectDirectory,
  revalidateDirectDirectory,
  validateDirectDirectory,
  type DirectDirectoryGuard,
  type NodeIdentity,
} from '../storage/directDirectory'
import {
  isolateOwnedPath,
  reclaimIsolatedPayload,
  type IsolatedPayloadGuard,
  type OwnedDirectNode,
} from '../storage/exclusiveIsolation'

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
  clearOwnedArtifacts(): Promise<CacheArtifactClearResult>
}

interface CacheArtifactInventoryOptions {
  cacheRoot: string
  fileSystem?: typeof fs
  pathModule?: typeof path
}

interface CapturedArtifact {
  name: CacheArtifactName
  source: OwnedDirectNode
}

interface IsolatedArtifact {
  name: CacheArtifactName
  guard: IsolatedPayloadGuard
}

const errorCode = (error: unknown): string | undefined =>
  error != null && typeof error == 'object' && 'code' in error && typeof error.code == 'string'
    ? error.code
    : undefined

const nodeIdentity = (stats: fs.Stats | fs.BigIntStats): NodeIdentity => ({
  dev: String(stats.dev),
  ino: String(stats.ino),
})

export const createCacheArtifactInventory = ({
  cacheRoot,
  fileSystem = fs,
  pathModule = path,
}: CacheArtifactInventoryOptions): CacheArtifactInventory => {
  const resolvedRoot = pathModule.resolve(cacheRoot)

  const captureArtifact = (
    root: DirectDirectoryGuard,
    name: CacheArtifactName,
  ): CapturedArtifact | null => {
    revalidateDirectDirectory(root)
    const targetPath = pathModule.resolve(resolvedRoot, name)
    if (pathModule.dirname(targetPath) != resolvedRoot) throw new Error('cache_target_invalid')
    let stats: fs.Stats | fs.BigIntStats
    try {
      stats = fileSystem.lstatSync(targetPath, { bigint: true })
    } catch (error) {
      if (errorCode(error) == 'ENOENT') {
        revalidateDirectDirectory(root)
        return null
      }
      throw error
    }
    if (stats.isSymbolicLink() || !stats.isFile() || String(stats.nlink) != '1') {
      throw new Error('cache_target_invalid')
    }
    const realTarget = pathModule.resolve(String(fileSystem.realpathSync(targetPath)))
    if (pathModule.relative(root.realPath, realTarget) != name) throw new Error('cache_target_invalid')
    revalidateDirectDirectory(root)
    return {
      name,
      source: {
        root,
        path: targetPath,
        basename: name,
        identity: nodeIdentity(stats),
        kind: 'file',
      },
    }
  }

  const clearOwnedArtifacts = async(): Promise<CacheArtifactClearResult> => {
    let root: DirectDirectoryGuard | null = null
    try {
      root = validateDirectDirectory(resolvedRoot, { fsApi: fileSystem, pathApi: pathModule })
    } catch {
      return { status: 'failed', code: 'cache_target_invalid', failedArtifact: null }
    }

    try {
      const captured: CapturedArtifact[] = []
      for (const name of CACHE_DB_ARTIFACT_NAMES) {
        try {
          const artifact = captureArtifact(root, name)
          if (artifact != null) captured.push(artifact)
        } catch {
          return { status: 'failed', code: 'cache_target_invalid', failedArtifact: name }
        }
      }

      const isolated: IsolatedArtifact[] = []
      for (const artifact of captured) {
        try {
          const result = await isolateOwnedPath({
            source: artifact.source,
            prefix: `.${artifact.name}.isolate-`,
          })
          if (result.state != 'isolated') {
            return { status: 'failed', code: 'cache_delete_failed', failedArtifact: artifact.name }
          }
          isolated.push({ name: artifact.name, guard: result.guard })
        } catch {
          return { status: 'failed', code: 'cache_delete_failed', failedArtifact: artifact.name }
        }
      }

      const verifyStableAbsence = (): CacheArtifactClearResult => {
        for (const name of CACHE_DB_ARTIFACT_NAMES) {
          try {
            revalidateDirectDirectory(root)
            fileSystem.lstatSync(pathModule.join(resolvedRoot, name), { bigint: true })
            return { status: 'failed', code: 'cache_delete_failed', failedArtifact: name }
          } catch (error) {
            if (errorCode(error) != 'ENOENT') {
              return { status: 'failed', code: 'cache_delete_failed', failedArtifact: name }
            }
          }
        }
        try {
          revalidateDirectDirectory(root)
          return { status: 'cleared' }
        } catch {
          return { status: 'failed', code: 'cache_delete_failed', failedArtifact: null }
        }
      }
      const absentBeforeReclaim = verifyStableAbsence()
      if (absentBeforeReclaim.status == 'failed') return absentBeforeReclaim

      let retained: CacheArtifactName | null = null
      for (const artifact of isolated) {
        const result = await reclaimIsolatedPayload({ guard: artifact.guard })
        if (result.state == 'retained') retained ??= artifact.name
      }
      if (retained != null) {
        return { status: 'failed', code: 'cache_delete_failed', failedArtifact: retained }
      }
      return verifyStableAbsence()
    } finally {
      try { closeDirectDirectory(root) } catch {}
    }
  }

  return { clearOwnedArtifacts }
}
