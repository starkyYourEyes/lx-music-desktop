import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  closeDirectDirectory,
  revalidateDirectDirectory,
  validateDirectDirectory,
  type NodeIdentity,
} from '../storage/directDirectory'

const OWNER_MARKER = '.owner.v1.json'
const runChildren = new Set(['theme-editor', 'local-artwork', 'backup-import'])

export type RunTempChild = 'theme-editor' | 'local-artwork' | 'backup-import'

export type PathIdentity = NodeIdentity

export interface RunTempReservation {
  tempRoot: string
  tempRootIdentity: NodeIdentity
  runTempRoot: string
  runTempIdentity: NodeIdentity
  markerPath: string
  markerIdentity: NodeIdentity
  markerRaw: string
  runId: string
}

export interface RunTempChildOwnership {
  runTempRoot: string
  runTempIdentity: PathIdentity
  childPath: string
  childIdentity: PathIdentity
}

export interface RunTempHandle {
  runTempRoot: string
  createChild: (name: RunTempChild) => Promise<string>
  getChildOwnership: (name: RunTempChild) => Promise<RunTempChildOwnership>
  cleanup: () => Promise<void>
}

interface RootOwnership {
  tempRoot: string
  tempRootIdentity: PathIdentity
}

interface RunOwnership extends RootOwnership {
  runTempRoot: string
  runTempIdentity: PathIdentity
  markerIdentity: PathIdentity
  markerRaw: string
  runId: string
}

interface ChildOwnership {
  childPath: string
  childIdentity: PathIdentity
}

interface MarkerDocument {
  version: 1
  runId: string
  directoryIdentity: PathIdentity
}

interface ReservationMetadata {
  tempAncestry: ReadonlyArray<{ path: string, identity: NodeIdentity }>
  runAncestry: ReadonlyArray<{ path: string, identity: NodeIdentity }>
}

const reservationMetadata = new WeakMap<RunTempReservation, ReservationMetadata>()

const inspect = async(targetPath: string) => await fs.lstat(targetPath, { bigint: true })
const identityOf = (stat: Awaited<ReturnType<typeof inspect>>): PathIdentity => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
})
const sameIdentity = (left: PathIdentity, right: PathIdentity): boolean =>
  left.dev == right.dev && left.ino == right.ino
const sameAncestry = (
  left: ReadonlyArray<{ path: string, identity: NodeIdentity }>,
  right: ReadonlyArray<{ path: string, identity: NodeIdentity }>,
): boolean => left.length == right.length && left.every((entry, index) =>
  pathKey(entry.path) == pathKey(right[index].path) && sameIdentity(entry.identity, right[index].identity))
const markerPath = (runTempRoot: string): string => path.join(runTempRoot, OWNER_MARKER)
const pathKey = (value: string): string => process.platform == 'win32' ? value.toLowerCase() : value

const invalidRoot = (): Error => new Error('run_temp_root_invalid')
const invalidOwner = (): Error => new Error('run_temp_owner_invalid')
const invalidChild = (): Error => new Error('run_temp_child_invalid')

const assertDirectChildPath = (rootPath: string, childPath: string, error: () => Error): void => {
  if (pathKey(path.dirname(path.resolve(childPath))) != pathKey(path.resolve(rootPath))) throw error()
}

const captureRoot = async(tempRoot: string): Promise<RootOwnership> => {
  const resolvedRoot = path.resolve(tempRoot)
  let guard
  try {
    guard = validateDirectDirectory(resolvedRoot)
    return { tempRoot: resolvedRoot, tempRootIdentity: { ...guard.identity } }
  } catch {
    throw invalidRoot()
  } finally {
    if (guard != null) closeDirectDirectory(guard)
  }
}

const assertRoot = async(ownership: RootOwnership): Promise<void> => {
  let guard
  try {
    guard = validateDirectDirectory(ownership.tempRoot)
    revalidateDirectDirectory(guard)
    if (!sameIdentity(guard.identity, ownership.tempRootIdentity)) throw invalidRoot()
  } catch {
    throw invalidRoot()
  } finally {
    if (guard != null) closeDirectDirectory(guard)
  }
}

const parseMarker = (raw: string): MarkerDocument => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw invalidOwner()
  }
  if (value == null || typeof value != 'object' || Array.isArray(value)) throw invalidOwner()
  const marker = value as Partial<MarkerDocument>
  if (marker.version != 1 || typeof marker.runId != 'string' || marker.runId.length == 0 ||
    marker.directoryIdentity == null || typeof marker.directoryIdentity.dev != 'string' ||
    typeof marker.directoryIdentity.ino != 'string') throw invalidOwner()
  return marker as MarkerDocument
}

const inspectRun = async(root: RootOwnership, runPath: string): Promise<RunOwnership> => {
  await assertRoot(root)
  assertDirectChildPath(root.tempRoot, runPath, invalidRoot)
  const runBefore = await inspect(runPath)
  if (runBefore.isSymbolicLink() || !runBefore.isDirectory()) throw invalidRoot()
  const marker = markerPath(runPath)
  assertDirectChildPath(runPath, marker, invalidOwner)
  const markerBefore = await inspect(marker)
  if (markerBefore.isSymbolicLink() || !markerBefore.isFile()) throw invalidOwner()
  const markerRaw = await fs.readFile(marker, 'utf8')
  const markerAfter = await inspect(marker)
  const runAfter = await inspect(runPath)
  const runIdentity = identityOf(runBefore)
  const markerIdentity = identityOf(markerBefore)
  if (!sameIdentity(identityOf(runAfter), runIdentity) ||
    !sameIdentity(identityOf(markerAfter), markerIdentity)) throw invalidOwner()
  const document = parseMarker(markerRaw)
  if (!sameIdentity(document.directoryIdentity, runIdentity)) throw invalidOwner()
  await assertRoot(root)
  return {
    ...root,
    runTempRoot: runPath,
    runTempIdentity: runIdentity,
    markerIdentity,
    markerRaw,
    runId: document.runId,
  }
}

const assertOwnedRunAt = async(ownership: RunOwnership, runPath: string): Promise<void> => {
  const current = await inspectRun(ownership, runPath)
  if (!sameIdentity(current.runTempIdentity, ownership.runTempIdentity) ||
    !sameIdentity(current.markerIdentity, ownership.markerIdentity) ||
    current.markerRaw != ownership.markerRaw || current.runId != ownership.runId) throw invalidOwner()
}

const pathMissing = async(targetPath: string): Promise<boolean> => {
  try {
    await inspect(targetPath)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code == 'ENOENT') return true
    throw error
  }
}

const removeOwnedRun = async(ownership: RunOwnership): Promise<void> => {
  await assertOwnedRunAt(ownership, ownership.runTempRoot)
  const quarantinePath = path.join(
    ownership.tempRoot,
    `.${path.basename(ownership.runTempRoot)}.quarantine-${crypto.randomUUID()}`,
  )
  assertDirectChildPath(ownership.tempRoot, quarantinePath, invalidRoot)
  if (!await pathMissing(quarantinePath)) throw invalidRoot()
  await fs.rename(ownership.runTempRoot, quarantinePath)
  const movedIdentity = identityOf(await inspect(quarantinePath))
  try {
    await assertOwnedRunAt(ownership, quarantinePath)
    await fs.rm(quarantinePath, { recursive: true, force: false, maxRetries: 1 })
  } catch (error) {
    try {
      await assertRoot(ownership)
      const currentIdentity = identityOf(await inspect(quarantinePath))
      if (!sameIdentity(currentIdentity, movedIdentity)) throw invalidOwner()
      if (await pathMissing(ownership.runTempRoot)) await fs.rename(quarantinePath, ownership.runTempRoot)
    } catch {}
    throw error
  }
}

const isRunCandidate = (name: string): boolean =>
  name.startsWith('run-') || /^\.run-.+\.quarantine-[a-f0-9-]+$/i.test(name)

export const scavengeRunTempRoots = async(tempRoot: string): Promise<void> => {
  const root = await captureRoot(tempRoot)
  for (const entry of await fs.readdir(root.tempRoot, { withFileTypes: true })) {
    if (!isRunCandidate(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) continue
    const runTempRoot = path.join(root.tempRoot, entry.name)
    try {
      const ownership = await inspectRun(root, runTempRoot)
      await removeOwnedRun(ownership)
    } catch {
      // Unstable, malformed, or replaced candidates are not owned by this process.
    }
  }
}

export const prepareRunTempLifecycle = async(input: {
  tempRoot: string
  runId?: string
}): Promise<RunTempReservation> => {
  const root = await captureRoot(input.tempRoot)
  const runId = input.runId ?? crypto.randomUUID()
  let tempGuard
  let runGuard
  try {
    tempGuard = validateDirectDirectory(root.tempRoot)
    revalidateDirectDirectory(tempGuard)
    const runTempRoot = path.join(root.tempRoot, `run-${crypto.randomUUID()}`)
    assertDirectChildPath(root.tempRoot, runTempRoot, invalidRoot)
    await fs.mkdir(runTempRoot, { mode: 0o700 })
    revalidateDirectDirectory(tempGuard)
    runGuard = validateDirectDirectory(runTempRoot)
    const marker = markerPath(runTempRoot)
    assertDirectChildPath(runTempRoot, marker, invalidOwner)
    const markerDocument: MarkerDocument = { version: 1, runId, directoryIdentity: { ...runGuard.identity } }
    const markerRaw = JSON.stringify(markerDocument)
    await fs.writeFile(marker, markerRaw, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    const ownership = await inspectRun(root, runTempRoot)
    revalidateDirectDirectory(tempGuard)
    revalidateDirectDirectory(runGuard)
    const reservation: RunTempReservation = Object.freeze({
      tempRoot: root.tempRoot,
      tempRootIdentity: Object.freeze({ ...root.tempRootIdentity }),
      runTempRoot,
      runTempIdentity: Object.freeze({ ...ownership.runTempIdentity }),
      markerPath: marker,
      markerIdentity: Object.freeze({ ...ownership.markerIdentity }),
      markerRaw: ownership.markerRaw,
      runId: ownership.runId,
    })
    reservationMetadata.set(reservation, {
      tempAncestry: tempGuard.ancestry.map(entry => ({ path: entry.path, identity: { ...entry.identity } })),
      runAncestry: runGuard.ancestry.map(entry => ({ path: entry.path, identity: { ...entry.identity } })),
    })
    return reservation
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('run_temp_')) throw error
    throw invalidRoot()
  } finally {
    if (runGuard != null) closeDirectDirectory(runGuard)
    if (tempGuard != null) closeDirectDirectory(tempGuard)
  }
}

const assertReservation = async(reservation: RunTempReservation): Promise<RunOwnership> => {
  const metadata = reservationMetadata.get(reservation)
  if (metadata == null) throw invalidOwner()
  let tempGuard
  let runGuard
  try {
    tempGuard = validateDirectDirectory(reservation.tempRoot)
    runGuard = validateDirectDirectory(reservation.runTempRoot)
    revalidateDirectDirectory(tempGuard)
    revalidateDirectDirectory(runGuard)
    if (!sameAncestry(tempGuard.ancestry, metadata.tempAncestry) ||
      !sameAncestry(runGuard.ancestry, metadata.runAncestry)) throw invalidOwner()
  } catch {
    throw invalidOwner()
  } finally {
    if (runGuard != null) closeDirectDirectory(runGuard)
    if (tempGuard != null) closeDirectDirectory(tempGuard)
  }
  const root: RootOwnership = {
    tempRoot: reservation.tempRoot,
    tempRootIdentity: reservation.tempRootIdentity,
  }
  const ownership = await inspectRun(root, reservation.runTempRoot)
  if (markerPath(reservation.runTempRoot) != reservation.markerPath ||
    !sameIdentity(ownership.runTempIdentity, reservation.runTempIdentity) ||
    !sameIdentity(ownership.markerIdentity, reservation.markerIdentity) ||
    ownership.markerRaw != reservation.markerRaw || ownership.runId != reservation.runId) throw invalidOwner()
  return ownership
}

export const createRunTempHandle = async(input: {
  reservation: RunTempReservation
}): Promise<RunTempHandle> => {
  const ownership = await assertReservation(input?.reservation)
  const children = new Map<RunTempChild, ChildOwnership>()

  const assertChild = async(child: ChildOwnership): Promise<void> => {
    await assertOwnedRunAt(ownership, ownership.runTempRoot)
    assertDirectChildPath(ownership.runTempRoot, child.childPath, invalidChild)
    const stat = await inspect(child.childPath)
    if (stat.isSymbolicLink() || !stat.isDirectory() ||
      !sameIdentity(identityOf(stat), child.childIdentity)) throw invalidChild()
    await assertOwnedRunAt(ownership, ownership.runTempRoot)
  }

  const createChild = async(name: RunTempChild): Promise<string> => {
    if (!runChildren.has(name)) throw invalidChild()
    const existing = children.get(name)
    if (existing != null) {
      await assertChild(existing)
      return existing.childPath
    }
    await assertOwnedRunAt(ownership, ownership.runTempRoot)
    const childPath = path.join(ownership.runTempRoot, name)
    assertDirectChildPath(ownership.runTempRoot, childPath, invalidChild)
    let childGuard
    try {
      await fs.mkdir(childPath, { mode: 0o700 })
      childGuard = validateDirectDirectory(childPath)
    } catch {
      throw invalidChild()
    } finally {
      if (childGuard != null) closeDirectDirectory(childGuard)
    }
    const stat = await inspect(childPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalidChild()
    const child = { childPath, childIdentity: identityOf(stat) }
    await assertChild(child)
    children.set(name, child)
    return childPath
  }

  return {
    runTempRoot: ownership.runTempRoot,
    createChild,
    getChildOwnership: async(name) => {
      await createChild(name)
      const child = children.get(name)
      if (child == null) throw invalidChild()
      await assertChild(child)
      return Object.freeze({
        runTempRoot: ownership.runTempRoot,
        runTempIdentity: { ...ownership.runTempIdentity },
        childPath: child.childPath,
        childIdentity: { ...child.childIdentity },
      })
    },
    cleanup: async() => { await removeOwnedRun(ownership) },
  }
}
