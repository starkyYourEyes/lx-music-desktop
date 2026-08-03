import fs from 'node:fs'
import path from 'node:path'
import { PROJECT_IDENTITY } from '../../common/projectIdentity'
import {
  closeDirectDirectory,
  createDirectChildDirectory,
  validateDirectDirectory,
  type DirectDirectoryGuard,
} from '../storage/directDirectory'
import type { RunTempReservation } from './tempLifecycle'

export interface StoragePaths {
  profileRoot: string
  cacheRoot: string
  runtimeRoot: string
  sessionDataRoot: string
  tempRoot: string
  runTempRoot: string
  backupsRoot: string
  portableRoot: string | null
}

export interface StoragePathResolutionInput {
  profileRoot: string
  applicationCacheRoot: string
  tempBase: string
  portableRoot: string | null
}

export interface ApplicationCacheRootInput {
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
  homePath: string
}

type ResolvedStoragePaths = Omit<StoragePaths, 'runTempRoot'>

export interface InitializedStoragePaths {
  paths: Readonly<StoragePaths>
  runTempReservation: RunTempReservation
}

export const resolveApplicationCacheRoot = (input: ApplicationCacheRootInput): string => {
  const pathApi = input.platform == 'win32' ? path.win32 : path.posix
  if (!pathApi.isAbsolute(input.homePath)) throw new Error('local_cache_home_invalid')

  let basePath: string
  switch (input.platform) {
    case 'win32': {
      const localAppData = input.env.LOCALAPPDATA
      basePath = localAppData != null && pathApi.isAbsolute(localAppData)
        ? localAppData
        : pathApi.join(input.homePath, 'AppData', 'Local')
      break
    }
    case 'darwin':
      basePath = pathApi.join(input.homePath, 'Library', 'Caches')
      break
    case 'linux': {
      const xdgCacheHome = input.env.XDG_CACHE_HOME
      basePath = xdgCacheHome != null && pathApi.isAbsolute(xdgCacheHome)
        ? xdgCacheHome
        : pathApi.join(input.homePath, '.cache')
      break
    }
    default:
      throw new Error('local_cache_platform_unsupported')
  }
  return pathApi.join(basePath, PROJECT_IDENTITY.userDataDirName)
}

const isOutsideRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative == '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

export const assertContainedPath = (rootPath: string, candidatePath: string): string => {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(candidatePath)
  if (isOutsideRoot(root, candidate)) throw new Error('path_outside_root')

  let current = candidate
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('path_link_not_allowed')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code == 'ENOENT')) throw error
    }
    if (path.relative(root, current) == '') break
    const parent = path.dirname(current)
    if (parent == current) throw new Error('path_outside_root')
    current = parent
  }
  return candidate
}

export const resolveStoragePaths = (input: StoragePathResolutionInput): ResolvedStoragePaths => {
  if (input.portableRoot != null) {
    const portableRoot = path.resolve(input.portableRoot)
    const runtimeRoot = path.join(portableRoot, 'runtime')
    return Object.freeze({
      portableRoot,
      profileRoot: path.join(portableRoot, 'profile'),
      cacheRoot: path.join(portableRoot, 'cache'),
      runtimeRoot,
      sessionDataRoot: path.join(runtimeRoot, 'session-data'),
      tempRoot: path.join(portableRoot, 'temp'),
      backupsRoot: path.join(portableRoot, 'backups'),
    })
  }

  const profileRoot = path.resolve(input.profileRoot)
  const applicationCacheRoot = path.resolve(input.applicationCacheRoot)
  const runtimeRoot = path.join(applicationCacheRoot, 'runtime')
  return Object.freeze({
    portableRoot: null,
    profileRoot,
    cacheRoot: path.join(applicationCacheRoot, 'cache'),
    runtimeRoot,
    sessionDataRoot: path.join(runtimeRoot, 'session-data'),
    tempRoot: path.join(path.resolve(input.tempBase), PROJECT_IDENTITY.appId),
    backupsRoot: path.join(profileRoot, 'backups'),
  })
}

const isMissing = (error: unknown): boolean =>
  error != null && typeof error == 'object' && 'code' in error && error.code == 'ENOENT'

const ensureDirectDirectory = (directoryPath: string): DirectDirectoryGuard => {
  const resolved = path.resolve(directoryPath)
  try {
    fs.lstatSync(resolved, { bigint: true })
    return validateDirectDirectory(resolved)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const parentPath = path.dirname(resolved)
  if (parentPath == resolved) throw new Error('direct_directory_invalid')
  const parent = ensureDirectDirectory(parentPath)
  try {
    return createDirectChildDirectory(parent, path.basename(resolved), { mode: 0o700 })
  } finally {
    closeDirectDirectory(parent)
  }
}

const validateAndCreateRequiredRoots = async(resolved: ResolvedStoragePaths): Promise<void> => {
  const roots = [resolved.profileRoot, resolved.tempRoot, resolved.runtimeRoot, resolved.sessionDataRoot]
  for (const root of roots) {
    const guard = ensureDirectDirectory(root)
    closeDirectDirectory(guard)
  }
}

const validateOptionalRootIfPresent = async(rootPath: string): Promise<void> => {
  try {
    fs.lstatSync(rootPath, { bigint: true })
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  const guard = validateDirectDirectory(rootPath)
  closeDirectDirectory(guard)
}

export const initializeStoragePaths = async(input: StoragePathResolutionInput): Promise<InitializedStoragePaths> => {
  const resolved = resolveStoragePaths(input)
  await validateAndCreateRequiredRoots(resolved)
  await validateOptionalRootIfPresent(resolved.cacheRoot)
  await validateOptionalRootIfPresent(resolved.backupsRoot)
  const { prepareRunTempLifecycle, scavengeRunTempRoots } = await import('./tempLifecycle')
  await scavengeRunTempRoots(resolved.tempRoot)
  const runTempReservation = await prepareRunTempLifecycle({ tempRoot: resolved.tempRoot })
  return {
    paths: Object.freeze({ ...resolved, runTempRoot: runTempReservation.runTempRoot }),
    runTempReservation,
  }
}
