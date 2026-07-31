import fs from 'node:fs/promises'
import path from 'node:path'
import { canonicalJson, type JsonValue } from '../../../common/storage/canonicalJson'
import type { LegacyCredentialSource, SourceFileIdentity, VersionedSyncMetadataSource } from './legacySources'
import { createSyncMetadataRecoveryError, type CredentialMigrationRecoveryError } from './recoveryError'
import { isVersionedSyncMetadataDocument, preflightVersionedSyncMetadata } from './syncMetadataPreflight'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) == Object.prototype

const identityOf = (stats: Awaited<ReturnType<typeof fs.lstat>>): SourceFileIdentity => ({
  dev: stats.dev,
  ino: stats.ino,
  size: stats.size,
  mtimeMs: stats.mtimeMs,
  ctimeMs: stats.ctimeMs,
  birthtimeMs: stats.birthtimeMs,
})

const sameIdentity = (left: SourceFileIdentity, right: SourceFileIdentity): boolean =>
  left.dev == right.dev && left.ino == right.ino && left.size == right.size &&
  left.mtimeMs == right.mtimeMs && left.ctimeMs == right.ctimeMs && left.birthtimeMs == right.birthtimeMs

const sameStableIdentity = (left: SourceFileIdentity, right: SourceFileIdentity): boolean =>
  left.dev == right.dev && left.ino == right.ino && left.birthtimeMs == right.birthtimeMs

const assertContained = (root: string, candidate: string): void => {
  const relative = path.relative(root, path.resolve(candidate))
  if (relative == '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Invalid legacy credential source path')
  }
}

interface PreparedRedaction {
  filePath: string
  handle: Awaited<ReturnType<typeof fs.open>>
  identity: SourceFileIdentity
  redacted: string | null
  recoveryError: CredentialMigrationRecoveryError | null
}

interface RedactionTarget {
  filePath: string
  sources: LegacyCredentialSource[]
  versionedDocument?: VersionedSyncMetadataSource
}

const changedVersionedSourceError = (
  source: LegacyCredentialSource | VersionedSyncMetadataSource,
): CredentialMigrationRecoveryError | null => source.documentKind == 'generic'
  ? null
  : createSyncMetadataRecoveryError(
    'credentials.sync_metadata_changed_after_inventory',
    source.trustedRoot,
    source.documentPath,
  )

const validateOpenedIdentity = async(prepared: PreparedRedaction, contentMayDiffer = false): Promise<void> => {
  try {
    const opened = identityOf(await prepared.handle.stat())
    const targetStats = await fs.lstat(prepared.filePath)
    const matches = contentMayDiffer ? sameStableIdentity : sameIdentity
    if (targetStats.isSymbolicLink() || !targetStats.isFile() ||
        !matches(opened, prepared.identity) || !matches(identityOf(targetStats), prepared.identity)) {
      throw new Error('Legacy credential source identity changed')
    }
  } catch (error) {
    throw prepared.recoveryError ?? error
  }
}

const preflight = async(target: RedactionTarget): Promise<PreparedRedaction> => {
  const { filePath, sources, versionedDocument } = target
  const reference = versionedDocument ?? sources[0]
  const trustedRoot = reference.trustedRoot
  if (sources.some(source => source.trustedRoot != trustedRoot || source.documentPath != filePath)) {
    throw new Error('Invalid legacy credential source inventory')
  }
  if (versionedDocument != null && versionedDocument.documentPath != filePath) {
    throw new Error('Invalid legacy credential source inventory')
  }
  assertContained(trustedRoot, filePath)
  const recoveryError = changedVersionedSourceError(reference)
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(filePath, sources.length > 0 ? 'r+' : 'r')
  } catch (error) {
    throw recoveryError ?? error
  }
  try {
    const identity = identityOf(await handle.stat())
    if (!sameIdentity(identity, reference.documentIdentity) ||
        sources.some(source => !sameIdentity(source.documentIdentity, identity))) {
      throw recoveryError ?? new Error('Legacy credential source identity changed')
    }
    let current: unknown
    try {
      current = JSON.parse(await handle.readFile('utf8'))
    } catch (error) {
      throw recoveryError ?? error
    }
    if (!isRecord(current)) throw recoveryError ?? new Error('Invalid legacy credential source document')
    if (versionedDocument != null && preflightVersionedSyncMetadata(versionedDocument.documentKind, current) == null) {
      throw recoveryError ?? new Error('Legacy credential source metadata changed')
    }
    for (const source of sources) {
      const currentValue = source.read(current)
      if (currentValue == null || canonicalJson(currentValue) != canonicalJson(source.value)) {
        throw changedVersionedSourceError(source) ?? new Error('Legacy credential source value changed')
      }
    }
    for (const source of sources) source.redact(current)
    const redacted = sources.length > 0 ? canonicalJson(current as unknown as JsonValue) : null
    if (versionedDocument != null && redacted != null &&
        !isVersionedSyncMetadataDocument(versionedDocument.documentKind, JSON.parse(redacted))) {
      throw recoveryError ?? new Error('Legacy credential source metadata changed')
    }
    return {
      filePath,
      handle,
      identity,
      redacted,
      recoveryError,
    }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

export const redactLegacySecrets = async(
  sources: readonly LegacyCredentialSource[],
  versionedDocuments: readonly VersionedSyncMetadataSource[] = [],
): Promise<void> => {
  const byPath = new Map<string, RedactionTarget>()
  for (const document of versionedDocuments) {
    if (byPath.has(document.documentPath)) throw new Error('Invalid legacy credential source inventory')
    byPath.set(document.documentPath, {
      filePath: document.documentPath,
      sources: [],
      versionedDocument: document,
    })
  }
  for (const source of sources) {
    const target = byPath.get(source.documentPath) ?? { filePath: source.documentPath, sources: [] }
    target.sources.push(source)
    byPath.set(source.documentPath, target)
  }
  const prepared: PreparedRedaction[] = []
  try {
    for (const target of Array.from(byPath.values())) {
      prepared.push(await preflight(target))
    }
    for (const target of prepared) {
      await validateOpenedIdentity(target)
      if (target.redacted == null) continue
      const bytes = Buffer.from(target.redacted, 'utf8')
      await target.handle.write(bytes, 0, bytes.length, 0)
      await target.handle.truncate(bytes.length)
      await target.handle.sync()
      await validateOpenedIdentity(target, true)
    }
  } finally {
    await Promise.all(prepared.map(async target => target.handle.close().catch(() => {})))
  }
}
