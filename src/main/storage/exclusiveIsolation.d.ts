import type { DirectDirectoryGuard, NodeIdentity } from './directDirectory'

export interface OwnedDirectNode {
  root: DirectDirectoryGuard
  path: string
  basename: string
  identity: NodeIdentity
  kind: 'file' | 'directory'
}

export interface IsolationReservation {
  root: DirectDirectoryGuard
  isolationPath: string
  isolationBasename: string
  isolationIdentity: NodeIdentity
  payloadPath: string
}

export interface IsolatedPayloadGuard extends IsolationReservation {
  sourcePath: string
  expectedIdentity: NodeIdentity
  payloadIdentity: NodeIdentity
  kind: 'file' | 'directory'
}

export type IsolationResult =
  | { state: 'absent' }
  | { state: 'isolated', guard: IsolatedPayloadGuard }
  | { state: 'conflict', reservation: IsolationReservation, error: Error }

export function reserveExclusiveIsolation(input: {
  root: DirectDirectoryGuard
  prefix: string
  randomBytes?: (size: number) => Buffer
}): Promise<IsolationReservation>

export function reopenExclusiveIsolation(input: {
  root: DirectDirectoryGuard
  isolationBasename: string
  isolationIdentity: NodeIdentity
}): Promise<IsolationReservation>

export function isolateOwnedPath(input: {
  source: OwnedDirectNode
  reservation?: IsolationReservation
  prefix?: string
  onReserved?: (reservation: IsolationReservation) => Promise<void>
  verifySource?: (sourcePath: string) => Promise<void>
  beforeStableAbsenceCheck?: () => Promise<void> | void
}): Promise<IsolationResult>

export function reclaimIsolatedPayload(input: {
  guard: IsolatedPayloadGuard
  verifyPayload?: (payloadPath: string) => Promise<void>
}): Promise<
  { state: 'reclaimed' } |
  { state: 'retained', error: Error }
>
