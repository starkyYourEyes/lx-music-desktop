import type fs from 'node:fs'
import type path from 'node:path'

export interface SqliteFileIdentity {
  dev: number
  ino: number
}

export type SqliteTargetPreparation =
  | {
    ok: true
    existed: boolean
    realRoot: string
    identity: SqliteFileIdentity
    guardDescriptor: number
  }
  | {
    ok: false
    diagnostic: string
    sourceCode?: string
  }

export type SqliteTargetExpectation = Pick<
Extract<SqliteTargetPreparation, { ok: true }>,
'realRoot' | 'identity'
>

interface SqliteTargetDependencies {
  fileSystem: typeof fs
  pathModule: typeof path
}

const errorCode = (error: unknown): string | undefined =>
  error != null && typeof error == 'object' && 'code' in error && typeof error.code == 'string'
    ? error.code
    : undefined

const isMissing = (error: unknown): boolean => errorCode(error) == 'ENOENT'
const isAlreadyExists = (error: unknown): boolean => errorCode(error) == 'EEXIST'

export const resolveContainedPath = (
  rootPath: string,
  childName: string,
  pathModule: typeof path,
): string => {
  const root = pathModule.resolve(rootPath)
  const candidate = pathModule.resolve(root, childName)
  const relative = pathModule.relative(root, candidate)
  if (relative.startsWith(`..${pathModule.sep}`) || relative == '..' || pathModule.isAbsolute(relative)) {
    throw new Error('path_outside_root')
  }
  return candidate
}

export const isPathContained = (
  rootPath: string,
  candidatePath: string,
  pathModule: typeof path,
): boolean => {
  const relative = pathModule.relative(rootPath, candidatePath)
  return relative == '' || (
    !relative.startsWith(`..${pathModule.sep}`) && relative != '..' && !pathModule.isAbsolute(relative)
  )
}

export const sqliteFileIdentity = (stats: fs.Stats): SqliteFileIdentity => ({
  dev: stats.dev,
  ino: stats.ino,
})

export const sameSqliteFileIdentity = (
  left: SqliteFileIdentity,
  right: SqliteFileIdentity,
): boolean => left.dev == right.dev && left.ino == right.ino

export const isExclusiveSqliteFile = (stats: fs.Stats): boolean => stats.isFile() && stats.nlink == 1

export const closeSqliteGuardDescriptor = (fileSystem: typeof fs, descriptor: number | null): void => {
  if (descriptor == null) return
  try {
    fileSystem.closeSync(descriptor)
  } catch {}
}

export const validatePreparedSqliteTarget = (
  databasePath: string,
  target: Extract<SqliteTargetPreparation, { ok: true }>,
  { fileSystem, pathModule }: SqliteTargetDependencies,
): boolean => {
  try {
    const targetStats = fileSystem.lstatSync(databasePath)
    if (targetStats.isSymbolicLink() || !isExclusiveSqliteFile(targetStats)) return false
    if (!sameSqliteFileIdentity(sqliteFileIdentity(targetStats), target.identity)) return false
    const guardStats = fileSystem.fstatSync(target.guardDescriptor)
    if (!isExclusiveSqliteFile(guardStats)) return false
    if (!sameSqliteFileIdentity(sqliteFileIdentity(guardStats), target.identity)) return false
    return isPathContained(target.realRoot, fileSystem.realpathSync(databasePath), pathModule)
  } catch {
    return false
  }
}

export const acquireExpectedSqliteTarget = (
  databasePath: string,
  expected: SqliteTargetExpectation,
  { fileSystem, pathModule }: SqliteTargetDependencies,
): Extract<SqliteTargetPreparation, { ok: true }> | null => {
  let guardDescriptor: number | null = null
  try {
    const targetStats = fileSystem.lstatSync(databasePath)
    if (targetStats.isSymbolicLink() || !isExclusiveSqliteFile(targetStats)) return null
    if (!sameSqliteFileIdentity(sqliteFileIdentity(targetStats), expected.identity)) return null
    if (!isPathContained(expected.realRoot, fileSystem.realpathSync(databasePath), pathModule)) return null

    const noFollow = fileSystem.constants.O_NOFOLLOW ?? 0
    guardDescriptor = fileSystem.openSync(databasePath, fileSystem.constants.O_RDONLY | noFollow)
    const guardedTarget = {
      ok: true as const,
      existed: true,
      realRoot: expected.realRoot,
      identity: expected.identity,
      guardDescriptor,
    }
    if (!validatePreparedSqliteTarget(databasePath, guardedTarget, { fileSystem, pathModule })) {
      closeSqliteGuardDescriptor(fileSystem, guardDescriptor)
      return null
    }
    return guardedTarget
  } catch {
    closeSqliteGuardDescriptor(fileSystem, guardDescriptor)
    return null
  }
}

export const prepareSqliteTarget = (
  rootPath: string,
  databasePath: string,
  { fileSystem, pathModule }: SqliteTargetDependencies,
): SqliteTargetPreparation => {
  const directoryPath = pathModule.dirname(databasePath)
  let guardDescriptor: number | null = null
  try {
    fileSystem.mkdirSync(directoryPath, { recursive: true })
    const realRoot = fileSystem.realpathSync(rootPath)
    const realDirectory = fileSystem.realpathSync(directoryPath)
    if (!isPathContained(realRoot, realDirectory, pathModule)) {
      return { ok: false, diagnostic: 'open.path_invalid' }
    }

    let targetStats: fs.Stats | null = null
    try {
      targetStats = fileSystem.lstatSync(databasePath)
    } catch (error) {
      if (!isMissing(error)) {
        return {
          ok: false,
          diagnostic: 'open.target_inspect_failed',
          sourceCode: errorCode(error),
        }
      }
    }

    if (targetStats != null) {
      if (targetStats.isSymbolicLink()) return { ok: false, diagnostic: 'open.target_symlink' }
      if (!targetStats.isFile()) return { ok: false, diagnostic: 'open.target_not_regular' }
      if (!isExclusiveSqliteFile(targetStats)) return { ok: false, diagnostic: 'open.target_hard_link' }
      const realTarget = fileSystem.realpathSync(databasePath)
      if (!isPathContained(realRoot, realTarget, pathModule)) {
        return { ok: false, diagnostic: 'open.path_invalid' }
      }
      const noFollow = fileSystem.constants.O_NOFOLLOW ?? 0
      guardDescriptor = fileSystem.openSync(databasePath, fileSystem.constants.O_RDONLY | noFollow)
      const guardStats = fileSystem.fstatSync(guardDescriptor)
      if (!isExclusiveSqliteFile(guardStats) ||
        !sameSqliteFileIdentity(sqliteFileIdentity(guardStats), sqliteFileIdentity(targetStats))) {
        closeSqliteGuardDescriptor(fileSystem, guardDescriptor)
        return { ok: false, diagnostic: 'open.target_changed' }
      }
      return {
        ok: true,
        existed: true,
        realRoot,
        identity: sqliteFileIdentity(guardStats),
        guardDescriptor,
      }
    }

    try {
      guardDescriptor = fileSystem.openSync(databasePath, 'wx', 0o600)
    } catch (error) {
      return {
        ok: false,
        diagnostic: isAlreadyExists(error) ? 'open.reserve_conflict' : 'open.reserve_failed',
        sourceCode: errorCode(error),
      }
    }
    const guardStats = fileSystem.fstatSync(guardDescriptor)
    const reservedStats = fileSystem.lstatSync(databasePath)
    if (reservedStats.isSymbolicLink() || !isExclusiveSqliteFile(reservedStats) ||
      !isExclusiveSqliteFile(guardStats) ||
      !sameSqliteFileIdentity(sqliteFileIdentity(reservedStats), sqliteFileIdentity(guardStats))) {
      closeSqliteGuardDescriptor(fileSystem, guardDescriptor)
      return { ok: false, diagnostic: 'open.reserved_target_invalid' }
    }
    const realTarget = fileSystem.realpathSync(databasePath)
    if (!isPathContained(realRoot, realTarget, pathModule)) {
      closeSqliteGuardDescriptor(fileSystem, guardDescriptor)
      return { ok: false, diagnostic: 'open.path_invalid' }
    }
    return {
      ok: true,
      existed: false,
      realRoot,
      identity: sqliteFileIdentity(guardStats),
      guardDescriptor,
    }
  } catch (error) {
    closeSqliteGuardDescriptor(fileSystem, guardDescriptor)
    return {
      ok: false,
      diagnostic: 'open.target_inspect_failed',
      sourceCode: errorCode(error),
    }
  }
}
