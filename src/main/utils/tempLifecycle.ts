import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertContainedPath } from '@main/utils/storagePaths'

const OWNER_MARKER = '.owner.v1.json'
const runChildren = new Set(['theme-editor', 'local-artwork', 'backup-import'])

export type RunTempChild = 'theme-editor' | 'local-artwork' | 'backup-import'

export interface RunTempHandle {
  runTempRoot: string
  createChild: (name: RunTempChild) => Promise<string>
  cleanup: () => Promise<void>
}

interface RunOwnership {
  tempRoot: string
  runTempRoot: string
  runId: string
}

const lstat = async(targetPath: string) => await fs.lstat(targetPath)
const markerPath = (runTempRoot: string) => path.join(runTempRoot, OWNER_MARKER)

const assertDirectDirectory = async(rootPath: string, childPath: string): Promise<void> => {
  assertContainedPath(rootPath, childPath)
  if (path.dirname(path.resolve(childPath)) != path.resolve(rootPath)) throw new Error('run_temp_root_invalid')
  const stat = await lstat(childPath)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('run_temp_root_invalid')
}

const readOwner = async(ownership: RunOwnership): Promise<void> => {
  await assertDirectDirectory(ownership.tempRoot, ownership.runTempRoot)
  const marker = markerPath(ownership.runTempRoot)
  assertContainedPath(ownership.runTempRoot, marker)
  const stat = await lstat(marker)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('run_temp_owner_invalid')
  const value = JSON.parse(await fs.readFile(marker, 'utf8')) as { version?: number, runId?: string }
  if (value.version != 1 || value.runId != ownership.runId) throw new Error('run_temp_owner_invalid')
}

const removeOwnedRun = async(ownership: RunOwnership): Promise<void> => {
  await readOwner(ownership)
  // Re-read immediately before deletion so a replacement race never expands ownership.
  await readOwner(ownership)
  await fs.rm(ownership.runTempRoot, { recursive: true, force: false, maxRetries: 1 })
}

export const scavengeRunTempRoots = async(tempRoot: string): Promise<void> => {
  const resolvedRoot = path.resolve(tempRoot)
  const rootStat = await lstat(resolvedRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('run_temp_root_invalid')
  for (const entry of await fs.readdir(resolvedRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith('run-') || entry.isSymbolicLink() || !entry.isDirectory()) continue
    const runTempRoot = path.join(resolvedRoot, entry.name)
    const owner = markerPath(runTempRoot)
    try {
      const ownerStat = await lstat(owner)
      if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) continue
      const value = JSON.parse(await fs.readFile(owner, 'utf8')) as { version?: number, runId?: string }
      if (value.version != 1 || typeof value.runId != 'string' || value.runId.length == 0) continue
      await removeOwnedRun({ tempRoot: resolvedRoot, runTempRoot, runId: value.runId })
    } catch {
      // A malformed, replaced, or inaccessible candidate is never owned by this process.
    }
  }
}

export const createRunTempHandle = async(input: {
  tempRoot: string
  runTempRoot: string
  runId?: string
}): Promise<RunTempHandle> => {
  const ownership: RunOwnership = {
    tempRoot: path.resolve(input.tempRoot),
    runTempRoot: path.resolve(input.runTempRoot),
    runId: input.runId ?? crypto.randomUUID(),
  }
  await assertDirectDirectory(ownership.tempRoot, ownership.runTempRoot)
  const marker = markerPath(ownership.runTempRoot)
  assertContainedPath(ownership.runTempRoot, marker)
  await fs.writeFile(marker, JSON.stringify({ version: 1, runId: ownership.runId }), { encoding: 'utf8', flag: 'wx' })

  return {
    runTempRoot: ownership.runTempRoot,
    createChild: async(name) => {
      if (!runChildren.has(name)) throw new Error('run_temp_child_invalid')
      await readOwner(ownership)
      const child = path.join(ownership.runTempRoot, name)
      assertContainedPath(ownership.runTempRoot, child)
      await fs.mkdir(child, { recursive: true })
      const stat = await lstat(child)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('run_temp_child_invalid')
      await readOwner(ownership)
      return child
    },
    cleanup: async() => { await removeOwnedRun(ownership) },
  }
}
