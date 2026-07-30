import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { canonicalJson, type JsonValue } from '../../../common/storage/canonicalJson'
import type { LegacyCredentialSource } from './legacySources'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) == Object.prototype

const redactFile = async(filePath: string, sources: readonly LegacyCredentialSource[]): Promise<void> => {
  const stats = await fs.lstat(filePath)
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('Invalid legacy credential source path')
  const current: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'))
  if (!isRecord(current)) throw new Error('Invalid legacy credential source document')
  for (const source of sources) source.redact(current)
  const redacted = canonicalJson(current as unknown as JsonValue)
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.redacted-${randomBytes(12).toString('hex')}`)
  try {
    const handle = await fs.open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(redacted, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporaryPath, filePath)
  } finally {
    await fs.unlink(temporaryPath).catch(() => {})
  }
}

export const redactLegacySecrets = async(sources: readonly LegacyCredentialSource[]): Promise<void> => {
  const byPath = new Map<string, LegacyCredentialSource[]>()
  for (const source of sources) {
    const existing = byPath.get(source.documentPath) ?? []
    existing.push(source)
    byPath.set(source.documentPath, existing)
  }
  for (const [filePath, fileSources] of Array.from(byPath.entries())) await redactFile(filePath, fileSources)
}
