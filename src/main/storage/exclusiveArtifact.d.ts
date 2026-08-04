import type { DirectDirectoryGuard, NodeIdentity } from './directDirectory'

export type ArtifactKind =
  | 'database-backup-v1'
  | 'theme-image-v1'
  | 'portable-smoke-v1'
  | 'test-v1'

export interface BoundedByteSource {
  byteLength: number
  read: (offset: number, maximumBytes: number) => Buffer
}

export interface ExclusiveArtifactReservation {
  root: DirectDirectoryGuard
  path: string
  basename: string
  descriptor: number
  identity: NodeIdentity
  artifactKind: ArtifactKind
}

export interface ImmutableArtifactGuard extends ExclusiveArtifactReservation {
  sha256: string
  byteLength: number
}

export function reserveExclusiveArtifact(
  root: DirectDirectoryGuard,
  options: {
    prefix: string
    suffix: string
    artifactKind: ArtifactKind
    randomBytes?: (size: number) => Buffer
  },
): ExclusiveArtifactReservation

export function completeExclusiveArtifact(
  reservation: ExclusiveArtifactReservation,
  source: BoundedByteSource,
  options?: {
    chunkBytes?: number
    verifyReadOnly?: (input: {
      path: string
      readDescriptor: number
      sha256: string
      byteLength: number
    }) => void
  },
): ImmutableArtifactGuard

export function closeArtifactReservation(reservation: ExclusiveArtifactReservation): void
export function revalidateImmutableArtifact(guard: ImmutableArtifactGuard): void
export function closeArtifactGuard(guard: ImmutableArtifactGuard): void
