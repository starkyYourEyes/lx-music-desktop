import type fs from 'node:fs'
import type path from 'node:path'

export interface NodeIdentity {
  dev: string
  ino: string
}

export interface DirectDirectoryGuard {
  path: string
  realPath: string
  descriptor: number
  identity: NodeIdentity
  ancestry: ReadonlyArray<{ path: string, identity: NodeIdentity }>
}

export type DirectDirectoryObservation =
  | { status: 'present', guard: DirectDirectoryGuard }
  | { status: 'absent', parent: DirectDirectoryGuard, path: string, basename: string }

export function validateDirectDirectory(
  directoryPath: string,
  options?: { fsApi?: typeof fs, pathApi?: typeof path },
): DirectDirectoryGuard

export function observeDirectChild(parent: DirectDirectoryGuard, basename: string): DirectDirectoryObservation
export function createDirectChildDirectory(
  parent: DirectDirectoryGuard,
  basename: string,
  options?: { mode?: number },
): DirectDirectoryGuard
export function revalidateDirectDirectory(guard: DirectDirectoryGuard): void
export function closeDirectDirectory(guard: DirectDirectoryGuard): void
