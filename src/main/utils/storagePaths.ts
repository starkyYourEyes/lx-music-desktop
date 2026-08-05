import fs from 'node:fs'
import path from 'node:path'
import { PROJECT_IDENTITY } from '../../common/projectIdentity'
import {
  closeDirectDirectory,
  createDirectChildDirectory,
  revalidateDirectDirectory,
  validateDirectDirectory,
  type DirectDirectoryGuard,
} from '../storage/directDirectory'
import type { RunTempReservation } from './tempLifecycle'

export interface StoragePaths {
  profileRoot: string
  cacheRoot: string
  runtimeRoot: string
  electronUserDataRoot: string
  sessionDataRoot: string
  tempRoot: string
  runTempRoot: string
  backupsRoot: string
  portableRoot: string | null
}

export interface StoragePathResolutionInput {
  profileRoot: string
  applicationCacheRoot: string
  applicationRuntimeRoot?: string
  tempBase: string
  portableRoot: string | null
}

export interface ElectronBootstrapPathInput {
  applicationRuntimeRoot: string
  portableRoot: string | null
}

export type ElectronBootstrapPaths = Readonly<Pick<
StoragePaths,
'runtimeRoot' | 'electronUserDataRoot' | 'sessionDataRoot'
>>

export interface ApplicationCacheRootInput {
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
  homePath: string
}

export interface ApplicationRuntimeRootInput extends ApplicationCacheRootInput {
  appDataPath: string
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

export const resolveApplicationRuntimeRoot = (input: ApplicationRuntimeRootInput): string => {
  const pathApi = input.platform == 'win32' ? path.win32 : path.posix
  if (input.platform == 'win32') return pathApi.join(resolveApplicationCacheRoot(input), 'runtime')
  if (input.platform != 'darwin' && input.platform != 'linux') {
    throw new Error('local_runtime_platform_unsupported')
  }
  if (!pathApi.isAbsolute(input.appDataPath)) throw new Error('local_runtime_app_data_invalid')
  return pathApi.join(input.appDataPath, `${PROJECT_IDENTITY.userDataDirName}-runtime`)
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

const resolveElectronBootstrapPaths = (input: ElectronBootstrapPathInput): ElectronBootstrapPaths => {
  const runtimeRoot = input.portableRoot == null
    ? path.resolve(input.applicationRuntimeRoot)
    : path.join(path.resolve(input.portableRoot), 'runtime')
  return Object.freeze({
    runtimeRoot,
    electronUserDataRoot: path.join(runtimeRoot, 'electron-user-data'),
    sessionDataRoot: path.join(runtimeRoot, 'session-data'),
  })
}

export const resolveStoragePaths = (input: StoragePathResolutionInput): ResolvedStoragePaths => {
  if (input.portableRoot != null) {
    const portableRoot = path.resolve(input.portableRoot)
    const electronPaths = resolveElectronBootstrapPaths({
      applicationRuntimeRoot: input.applicationRuntimeRoot ?? path.join(portableRoot, 'runtime'),
      portableRoot,
    })
    return Object.freeze({
      portableRoot,
      profileRoot: path.join(portableRoot, 'profile'),
      cacheRoot: path.join(portableRoot, 'cache'),
      ...electronPaths,
      tempRoot: path.join(portableRoot, 'temp'),
      backupsRoot: path.join(portableRoot, 'backups'),
    })
  }

  const profileRoot = path.resolve(input.profileRoot)
  const applicationCacheRoot = path.resolve(input.applicationCacheRoot)
  const electronPaths = resolveElectronBootstrapPaths({
    applicationRuntimeRoot: input.applicationRuntimeRoot ?? path.join(applicationCacheRoot, 'runtime'),
    portableRoot: null,
  })
  return Object.freeze({
    portableRoot: null,
    profileRoot,
    cacheRoot: path.join(applicationCacheRoot, 'cache'),
    ...electronPaths,
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

export const prepareElectronBootstrapPaths = (input: ElectronBootstrapPathInput): ElectronBootstrapPaths => {
  const resolved = resolveElectronBootstrapPaths(input)
  let runtimeGuard: DirectDirectoryGuard | null = null
  let electronUserDataGuard: DirectDirectoryGuard | null = null
  let sessionDataGuard: DirectDirectoryGuard | null = null
  try {
    runtimeGuard = ensureDirectDirectory(resolved.runtimeRoot)
    electronUserDataGuard = createDirectChildDirectory(runtimeGuard, 'electron-user-data', { mode: 0o700 })
    sessionDataGuard = createDirectChildDirectory(runtimeGuard, 'session-data', { mode: 0o700 })
    revalidateDirectDirectory(runtimeGuard)
    revalidateDirectDirectory(electronUserDataGuard)
    revalidateDirectDirectory(sessionDataGuard)
    return resolved
  } finally {
    if (sessionDataGuard != null) closeDirectDirectory(sessionDataGuard)
    if (electronUserDataGuard != null) closeDirectDirectory(electronUserDataGuard)
    if (runtimeGuard != null) closeDirectDirectory(runtimeGuard)
  }
}

const closeGuards = (guards: DirectDirectoryGuard[]): void => {
  for (const guard of guards.reverse()) closeDirectDirectory(guard)
}

const validateAndCreateRequiredRoots = async(resolved: ResolvedStoragePaths): Promise<DirectDirectoryGuard[]> => {
  const roots = [
    resolved.profileRoot,
    resolved.tempRoot,
    resolved.runtimeRoot,
    resolved.electronUserDataRoot,
    resolved.sessionDataRoot,
  ]
  const guards: DirectDirectoryGuard[] = []
  try {
    for (const root of roots) guards.push(ensureDirectDirectory(root))
    return guards
  } catch (error) {
    closeGuards(guards)
    throw error
  }
}

const validateOptionalRootIfPresent = async(rootPath: string): Promise<DirectDirectoryGuard | null> => {
  try {
    fs.lstatSync(rootPath, { bigint: true })
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  return validateDirectDirectory(rootPath)
}

export const initializeStoragePaths = async(input: StoragePathResolutionInput): Promise<InitializedStoragePaths> => {
  const resolved = resolveStoragePaths(input)
  const guards = await validateAndCreateRequiredRoots(resolved)
  try {
    const cacheGuard = await validateOptionalRootIfPresent(resolved.cacheRoot)
    if (cacheGuard != null) guards.push(cacheGuard)
    const backupsGuard = await validateOptionalRootIfPresent(resolved.backupsRoot)
    if (backupsGuard != null) guards.push(backupsGuard)
    const { prepareRunTempLifecycle, scavengeRunTempRoots } = await import('./tempLifecycle')
    await scavengeRunTempRoots(resolved.tempRoot)
    const runTempReservation = await prepareRunTempLifecycle({ tempRoot: resolved.tempRoot })
    for (const guard of guards) revalidateDirectDirectory(guard)
    return {
      paths: Object.freeze({ ...resolved, runTempRoot: runTempReservation.runTempRoot }),
      runTempReservation,
    }
  } finally {
    closeGuards(guards)
  }
}
