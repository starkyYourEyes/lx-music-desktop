import fs from 'node:fs/promises'
import path from 'node:path'
import { canonicalJson, type JsonValue } from '../../../common/storage/canonicalJson'
import type { LegacyCredentialSource, SourceFileIdentity } from './legacySources'

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
  redacted: string
}

const validateOpenedIdentity = async(prepared: PreparedRedaction, contentMayDiffer = false): Promise<void> => {
  const opened = identityOf(await prepared.handle.stat())
  const targetStats = await fs.lstat(prepared.filePath)
  const matches = contentMayDiffer ? sameStableIdentity : sameIdentity
  if (targetStats.isSymbolicLink() || !targetStats.isFile() ||
      !matches(opened, prepared.identity) || !matches(identityOf(targetStats), prepared.identity)) {
    throw new Error('Legacy credential source identity changed')
  }
}

const preflight = async(filePath: string, sources: readonly LegacyCredentialSource[]): Promise<PreparedRedaction> => {
  const trustedRoot = sources[0].trustedRoot
  if (sources.some(source => source.trustedRoot != trustedRoot || source.documentPath != filePath)) {
    throw new Error('Invalid legacy credential source inventory')
  }
  assertContained(trustedRoot, filePath)
  const handle = await fs.open(filePath, 'r+')
  try {
    const identity = identityOf(await handle.stat())
    if (!sameIdentity(identity, sources[0].documentIdentity) ||
        sources.some(source => !sameIdentity(source.documentIdentity, identity))) {
      throw new Error('Legacy credential source identity changed')
    }
    const current: unknown = JSON.parse(await handle.readFile('utf8'))
    if (!isRecord(current)) throw new Error('Invalid legacy credential source document')
    for (const source of sources) {
      const currentValue = source.read(current)
      if (currentValue == null || canonicalJson(currentValue) != canonicalJson(source.value)) {
        throw new Error('Legacy credential source value changed')
      }
    }
    for (const source of sources) source.redact(current)
    return {
      filePath,
      handle,
      identity,
      redacted: canonicalJson(current as unknown as JsonValue),
    }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

export const redactLegacySecrets = async(sources: readonly LegacyCredentialSource[]): Promise<void> => {
  const byPath = new Map<string, LegacyCredentialSource[]>()
  for (const source of sources) {
    const existing = byPath.get(source.documentPath) ?? []
    existing.push(source)
    byPath.set(source.documentPath, existing)
  }
  const prepared: PreparedRedaction[] = []
  try {
    for (const [filePath, fileSources] of Array.from(byPath.entries())) {
      prepared.push(await preflight(filePath, fileSources))
    }
    for (const target of prepared) {
      await validateOpenedIdentity(target)
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
