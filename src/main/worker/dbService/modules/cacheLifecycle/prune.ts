import type Database from 'better-sqlite3'
import type {
  CachePruneInputV1,
  CachePruneReportV1,
  CachePruneResultV1,
} from '../../../../../common/storage/cache'
import {
  runCacheImmediate,
  type CacheExecutionResult,
  type CacheRepositoryGate,
} from '../../cacheDb'

export const CACHE_POLICY = {
  musicUrls: { fallbackTtlMs: 15 * 60 * 1000, maxEntries: 5_000 },
  rawLyrics: {
    maxBytes: 100 * 1024 * 1024,
    maxTracks: 20_000,
    maxIdleMs: 180 * 24 * 60 * 60 * 1000,
  },
  otherSources: { ttlMs: 30 * 24 * 60 * 60 * 1000, maxBytes: 50 * 1024 * 1024 },
} as const

export interface CachePolicyLimits {
  musicUrls: { fallbackTtlMs: number, maxEntries: number }
  rawLyrics: { maxBytes: number, maxTracks: number, maxIdleMs: number }
  otherSources: { ttlMs: number, maxBytes: number }
}

type RunImmediate = CacheRepositoryGate['runCacheImmediate']

interface UrlRow {
  provider: string
  accountScope: string
  sourceTrackId: string
  quality: string
}

interface OwnerRow {
  provider: string
  trackId: string
  byteSize: number
}

interface Counts {
  musicUrls: { rows: number }
  rawLyrics: { rows: number, ownerGroups: number, bytes: number }
  otherSources: { rows: number, ownerGroups: number, bytes: number }
}

interface BatchResult {
  before: Counts
  after: Counts
  selected: number
  effects: DeletionEffects
  musicExpired: string[]
  musicEvicted: string[]
  rawExpired: string[]
  rawEvicted: string[]
  otherExpired: string[]
  otherEvicted: string[]
}

interface DeletionEffects {
  musicUrlRows: number
  rawLyricRows: number
  rawLyricOwners: number
  rawLyricBytes: number
  otherSourceRows: number
  otherSourceOwners: number
  otherSourceBytes: number
}

const invalidInput = (): Error & { code: 'cache_prune_input_invalid' } =>
  Object.assign(new Error('cache_prune_input_invalid'), { code: 'cache_prune_input_invalid' as const })

const validateInput = (input: CachePruneInputV1): void => {
  if (input == null || typeof input != 'object' || Array.isArray(input) ||
    Object.getPrototypeOf(input) != Object.prototype ||
    Object.keys(input).length != 2 || !Object.hasOwn(input, 'nowMs') || !Object.hasOwn(input, 'batchSize') ||
    !Number.isSafeInteger(input.nowMs) || input.nowMs < 0 ||
    !Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 500) throw invalidInput()
}

const safeCount = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('cache_policy_accounting_invalid')
  return value as number
}

const validateGroupAccounting = (
  db: Database.Database,
  utf8ByteLength?: (value: string) => number,
): void => {
  const invalidRaw = db.prepare(`
    SELECT count(*) AS count FROM raw_lyric_groups AS owner
    WHERE owner.byte_size != (
      SELECT coalesce(sum(row.byte_size), 0) FROM raw_lyrics AS row
      WHERE row.provider = owner.provider AND row.source_track_id = owner.source_track_id
    )
  `).get() as { count: unknown }
  const invalidOther = db.prepare(`
    SELECT count(*) AS count FROM other_source_groups AS owner
    WHERE owner.byte_size != (
      SELECT coalesce(sum(row.byte_size), 0) FROM other_sources AS row
      WHERE row.original_provider = owner.original_provider
        AND row.original_track_id = owner.original_track_id
    )
  `).get() as { count: unknown }
  if (safeCount(invalidRaw.count) != 0 || safeCount(invalidOther.count) != 0) {
    throw new Error('cache_policy_accounting_invalid')
  }
  if (utf8ByteLength != null) {
    const rawRows = db.prepare('SELECT text, byte_size AS byteSize FROM raw_lyrics').all() as Array<{
      text: unknown
      byteSize: unknown
    }>
    const otherRows = db.prepare('SELECT candidate_json AS json, byte_size AS byteSize FROM other_sources').all() as Array<{
      json: unknown
      byteSize: unknown
    }>
    if (rawRows.some(row => typeof row.text != 'string' || safeCount(row.byteSize) != utf8ByteLength(row.text)) ||
      otherRows.some(row => typeof row.json != 'string' || safeCount(row.byteSize) != utf8ByteLength(row.json))) {
      throw new Error('cache_policy_accounting_invalid')
    }
    return
  }
  const invalidRows = db.prepare(`
    SELECT
      (SELECT count(*) FROM raw_lyrics
        WHERE byte_size != length(CAST(text AS BLOB))) +
      (SELECT count(*) FROM other_sources
        WHERE byte_size != length(CAST(candidate_json AS BLOB))) AS count
  `).get() as { count: unknown }
  if (safeCount(invalidRows.count) != 0) throw new Error('cache_policy_accounting_invalid')
}

const counts = (db: Database.Database): Counts => {
  const music = db.prepare('SELECT count(*) AS rows FROM music_urls').get() as { rows: unknown }
  const rawRows = db.prepare('SELECT count(*) AS rows FROM raw_lyrics').get() as { rows: unknown }
  const rawGroups = db.prepare(`
    SELECT count(*) AS ownerGroups, coalesce(sum(byte_size), 0) AS bytes FROM raw_lyric_groups
  `).get() as { ownerGroups: unknown, bytes: unknown }
  const otherRows = db.prepare('SELECT count(*) AS rows FROM other_sources').get() as { rows: unknown }
  const otherGroups = db.prepare(`
    SELECT count(*) AS ownerGroups, coalesce(sum(byte_size), 0) AS bytes FROM other_source_groups
  `).get() as { ownerGroups: unknown, bytes: unknown }
  return {
    musicUrls: { rows: safeCount(music.rows) },
    rawLyrics: {
      rows: safeCount(rawRows.rows),
      ownerGroups: safeCount(rawGroups.ownerGroups),
      bytes: safeCount(rawGroups.bytes),
    },
    otherSources: {
      rows: safeCount(otherRows.rows),
      ownerGroups: safeCount(otherGroups.ownerGroups),
      bytes: safeCount(otherGroups.bytes),
    },
  }
}

const urlKey = (row: UrlRow): string =>
  `${row.provider}:${row.accountScope}:${row.sourceTrackId}:${row.quality}`

const ownerKey = (row: OwnerRow): string => `${row.provider}:${row.trackId}`

const deleteUrls = (
  db: Database.Database,
  rows: readonly UrlRow[],
): void => {
  const remove = db.prepare(`
    DELETE FROM music_urls
    WHERE provider = ? AND account_scope = ? AND source_track_id = ? AND quality = ?
  `)
  for (const row of rows) {
    if (remove.run(row.provider, row.accountScope, row.sourceTrackId, row.quality).changes != 1) {
      throw new Error('cache_policy_accounting_invalid')
    }
  }
}

const deleteOwners = (
  db: Database.Database,
  table: 'raw_lyric_groups' | 'other_source_groups',
  rows: readonly OwnerRow[],
): void => {
  const columns = table == 'raw_lyric_groups'
    ? ['provider', 'source_track_id'] as const
    : ['original_provider', 'original_track_id'] as const
  const remove = db.prepare(`DELETE FROM ${table} WHERE ${columns[0]} = ? AND ${columns[1]} = ?`)
  for (const row of rows) {
    if (remove.run(row.provider, row.trackId).changes != 1) throw new Error('cache_policy_accounting_invalid')
  }
}

const selectExpiredUrls = (db: Database.Database, nowMs: number, limit: number): UrlRow[] => db.prepare(`
  SELECT provider, account_scope AS accountScope, source_track_id AS sourceTrackId, quality
  FROM music_urls WHERE expires_at_ms <= ?
  ORDER BY expires_at_ms, provider COLLATE BINARY, account_scope COLLATE BINARY,
    source_track_id COLLATE BINARY, quality COLLATE BINARY
  LIMIT ?
`).all(nowMs, limit) as UrlRow[]

const selectLruUrls = (db: Database.Database, limit: number): UrlRow[] => db.prepare(`
  SELECT provider, account_scope AS accountScope, source_track_id AS sourceTrackId, quality
  FROM music_urls
  ORDER BY last_accessed_at_ms, created_at_ms, provider COLLATE BINARY,
    account_scope COLLATE BINARY, source_track_id COLLATE BINARY, quality COLLATE BINARY
  LIMIT ?
`).all(limit) as UrlRow[]

const selectRawExpired = (db: Database.Database, threshold: number, limit: number): OwnerRow[] => db.prepare(`
  SELECT provider, source_track_id AS trackId, byte_size AS byteSize
  FROM raw_lyric_groups WHERE last_accessed_at_ms <= ?
  ORDER BY last_accessed_at_ms, created_at_ms, provider COLLATE BINARY, source_track_id COLLATE BINARY
  LIMIT ?
`).all(threshold, limit) as OwnerRow[]

const selectRawLru = (db: Database.Database, limit: number): OwnerRow[] => db.prepare(`
  SELECT provider, source_track_id AS trackId, byte_size AS byteSize
  FROM raw_lyric_groups
  ORDER BY last_accessed_at_ms, created_at_ms, provider COLLATE BINARY, source_track_id COLLATE BINARY
  LIMIT ?
`).all(limit) as OwnerRow[]

const selectOtherExpired = (db: Database.Database, nowMs: number, limit: number): OwnerRow[] => db.prepare(`
  SELECT original_provider AS provider, original_track_id AS trackId, byte_size AS byteSize
  FROM other_source_groups WHERE expires_at_ms <= ?
  ORDER BY expires_at_ms, original_provider COLLATE BINARY, original_track_id COLLATE BINARY
  LIMIT ?
`).all(nowMs, limit) as OwnerRow[]

const selectOtherLru = (db: Database.Database, limit: number): OwnerRow[] => db.prepare(`
  SELECT original_provider AS provider, original_track_id AS trackId, byte_size AS byteSize
  FROM other_source_groups
  ORDER BY last_accessed_at_ms, created_at_ms,
    original_provider COLLATE BINARY, original_track_id COLLATE BINARY
  LIMIT ?
`).all(limit) as OwnerRow[]

const quotaOwners = (
  rows: readonly OwnerRow[],
  current: { ownerGroups: number, bytes: number },
  maxOwners: number,
  maxBytes: number,
): OwnerRow[] => {
  const selected: OwnerRow[] = []
  let ownerGroups = current.ownerGroups
  let bytes = current.bytes
  for (const row of rows) {
    if (ownerGroups <= maxOwners && bytes <= maxBytes) break
    selected.push(row)
    ownerGroups--
    bytes -= safeCount(row.byteSize)
  }
  return selected
}

const deletionEffects = (before: Counts, after: Counts): DeletionEffects => {
  const effects = {
    musicUrlRows: before.musicUrls.rows - after.musicUrls.rows,
    rawLyricRows: before.rawLyrics.rows - after.rawLyrics.rows,
    rawLyricOwners: before.rawLyrics.ownerGroups - after.rawLyrics.ownerGroups,
    rawLyricBytes: before.rawLyrics.bytes - after.rawLyrics.bytes,
    otherSourceRows: before.otherSources.rows - after.otherSources.rows,
    otherSourceOwners: before.otherSources.ownerGroups - after.otherSources.ownerGroups,
    otherSourceBytes: before.otherSources.bytes - after.otherSources.bytes,
  }
  if (Object.values(effects).some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('cache_policy_accounting_invalid')
  }
  return effects
}

const runBatch = (
  db: Database.Database,
  input: CachePruneInputV1,
  policy: CachePolicyLimits,
  validateAccounting: boolean,
  utf8ByteLength?: (value: string) => number,
): BatchResult => {
  if (validateAccounting) validateGroupAccounting(db, utf8ByteLength)
  const before = counts(db)
  let remaining = input.batchSize
  let musicExpired: UrlRow[] = []
  let musicEvicted: UrlRow[] = []
  let rawExpired: OwnerRow[] = []
  let rawEvicted: OwnerRow[] = []
  let otherExpired: OwnerRow[] = []
  let otherEvicted: OwnerRow[] = []

  musicExpired = selectExpiredUrls(db, input.nowMs, remaining)
  deleteUrls(db, musicExpired)
  remaining -= musicExpired.length
  const rawThreshold = input.nowMs >= policy.rawLyrics.maxIdleMs
    ? input.nowMs - policy.rawLyrics.maxIdleMs
    : -1
  rawExpired = remaining == 0 ? [] : selectRawExpired(db, rawThreshold, remaining)
  deleteOwners(db, 'raw_lyric_groups', rawExpired)
  remaining -= rawExpired.length
  otherExpired = remaining == 0 ? [] : selectOtherExpired(db, input.nowMs, remaining)
  deleteOwners(db, 'other_source_groups', otherExpired)

  const expiredSelected = musicExpired.length + rawExpired.length + otherExpired.length
  if (expiredSelected == 0) {
    remaining = input.batchSize
    let current = counts(db)
    musicEvicted = selectLruUrls(
      db,
      Math.min(remaining, Math.max(0, current.musicUrls.rows - policy.musicUrls.maxEntries)),
    )
    deleteUrls(db, musicEvicted)
    remaining -= musicEvicted.length
    current = counts(db)
    rawEvicted = remaining == 0 ? [] : quotaOwners(
      selectRawLru(db, remaining),
      current.rawLyrics,
      policy.rawLyrics.maxTracks,
      policy.rawLyrics.maxBytes,
    )
    deleteOwners(db, 'raw_lyric_groups', rawEvicted)
    remaining -= rawEvicted.length
    current = counts(db)
    otherEvicted = remaining == 0 ? [] : quotaOwners(
      selectOtherLru(db, remaining),
      current.otherSources,
      Number.MAX_SAFE_INTEGER,
      policy.otherSources.maxBytes,
    )
    deleteOwners(db, 'other_source_groups', otherEvicted)
  }

  const selected = musicExpired.length + musicEvicted.length + rawExpired.length +
    rawEvicted.length + otherExpired.length + otherEvicted.length
  const after = counts(db)
  return {
    before,
    after,
    selected,
    effects: deletionEffects(before, after),
    musicExpired: musicExpired.map(urlKey),
    musicEvicted: musicEvicted.map(urlKey),
    rawExpired: rawExpired.map(ownerKey),
    rawEvicted: rawEvicted.map(ownerKey),
    otherExpired: otherExpired.map(ownerKey),
    otherEvicted: otherEvicted.map(ownerKey),
  }
}

const report = (
  before: Counts,
  after: Counts,
  aggregate: {
    effects: DeletionEffects
    musicExpired: string[]
    musicEvicted: string[]
    rawExpired: string[]
    rawEvicted: string[]
    otherExpired: string[]
    otherEvicted: string[]
  },
): CachePruneReportV1 => ({
  status: 'completed',
  musicUrls: {
    rowsBefore: before.musicUrls.rows,
    rowsAfter: after.musicUrls.rows,
    deletedRows: aggregate.effects.musicUrlRows,
    expiredKeys: aggregate.musicExpired,
    evictedKeys: aggregate.musicEvicted,
  },
  rawLyrics: {
    rowsBefore: before.rawLyrics.rows,
    rowsAfter: after.rawLyrics.rows,
    ownerGroupsBefore: before.rawLyrics.ownerGroups,
    ownerGroupsAfter: after.rawLyrics.ownerGroups,
    bytesBefore: before.rawLyrics.bytes,
    bytesAfter: after.rawLyrics.bytes,
    deletedRows: aggregate.effects.rawLyricRows,
    deletedOwners: aggregate.effects.rawLyricOwners,
    deletedBytes: aggregate.effects.rawLyricBytes,
    expiredOwners: aggregate.rawExpired,
    evictedOwners: aggregate.rawEvicted,
  },
  otherSources: {
    rowsBefore: before.otherSources.rows,
    rowsAfter: after.otherSources.rows,
    ownerGroupsBefore: before.otherSources.ownerGroups,
    ownerGroupsAfter: after.otherSources.ownerGroups,
    bytesBefore: before.otherSources.bytes,
    bytesAfter: after.otherSources.bytes,
    deletedRows: aggregate.effects.otherSourceRows,
    deletedOwners: aggregate.effects.otherSourceOwners,
    deletedBytes: aggregate.effects.otherSourceBytes,
    expiredOwners: aggregate.otherExpired,
    evictedOwners: aggregate.otherEvicted,
  },
})

export const createCachePruner = ({
  runImmediate,
  policy = CACHE_POLICY,
  utf8ByteLength,
}: {
  runImmediate: RunImmediate
  policy?: CachePolicyLimits
  utf8ByteLength?: (value: string) => number
}) => ({
  async prune(input: CachePruneInputV1): Promise<CachePruneResultV1> {
    validateInput(input)
    let first: Counts | undefined
    let last: Counts | undefined
    const aggregate = {
      effects: {
        musicUrlRows: 0,
        rawLyricRows: 0,
        rawLyricOwners: 0,
        rawLyricBytes: 0,
        otherSourceRows: 0,
        otherSourceOwners: 0,
        otherSourceBytes: 0,
      },
      musicExpired: [] as string[],
      musicEvicted: [] as string[],
      rawExpired: [] as string[],
      rawEvicted: [] as string[],
      otherExpired: [] as string[],
      otherEvicted: [] as string[],
    }
    while (true) {
      const result = await runImmediate(db => runBatch(
        db,
        input,
        policy,
        first == null,
        utf8ByteLength,
      ))
      if (result.status == 'unavailable') return result
      first ??= result.value.before
      last = result.value.after
      for (const key of Object.keys(aggregate.effects) as Array<keyof DeletionEffects>) {
        aggregate.effects[key] += result.value.effects[key]
      }
      aggregate.musicExpired.push(...result.value.musicExpired)
      aggregate.musicEvicted.push(...result.value.musicEvicted)
      aggregate.rawExpired.push(...result.value.rawExpired)
      aggregate.rawEvicted.push(...result.value.rawEvicted)
      aggregate.otherExpired.push(...result.value.otherExpired)
      aggregate.otherEvicted.push(...result.value.otherEvicted)
      if (result.value.selected == 0) break
    }
    return report(first, last, aggregate)
  },
})

const productionPruner = createCachePruner({ runImmediate: runCacheImmediate })

// eslint-disable-next-line @typescript-eslint/promise-function-async -- Preserve the returned cache-operation promise identity.
export const cachePrune = (input: CachePruneInputV1): Promise<CachePruneResultV1> =>
  productionPruner.prune(input)

// eslint-disable-next-line @typescript-eslint/promise-function-async -- Preserve the returned cache-operation promise identity.
export const runCachePolicySnapshot = (): Promise<CacheExecutionResult<Counts>> =>
  runCacheImmediate(db => counts(db))

export type CachePolicyGroup = 'musicUrls' | 'rawLyrics' | 'otherSources'

const exceedsTrigger = (
  group: CachePolicyGroup,
  snapshot: Counts,
  policy: CachePolicyLimits,
): boolean => {
  switch (group) {
    case 'musicUrls':
      return snapshot.musicUrls.rows * 10 > policy.musicUrls.maxEntries * 11
    case 'rawLyrics':
      return snapshot.rawLyrics.ownerGroups * 10 > policy.rawLyrics.maxTracks * 11 ||
        snapshot.rawLyrics.bytes * 10 > policy.rawLyrics.maxBytes * 11
    case 'otherSources':
      return snapshot.otherSources.bytes * 10 > policy.otherSources.maxBytes * 11
  }
}

export const createCachePruneScheduler = ({
  policy = CACHE_POLICY,
  now = Date.now,
  schedule = task => setTimeout(task, 0),
  runSnapshot = runCachePolicySnapshot,
  prune = cachePrune,
  batchSize = 100,
}: {
  policy?: CachePolicyLimits
  now?: () => number
  schedule?: (task: () => void) => unknown
  runSnapshot?: () => Promise<CacheExecutionResult<Counts>>
  prune?: (input: CachePruneInputV1) => Promise<CachePruneResultV1>
  batchSize?: number
} = {}) => {
  let state: 'idle' | 'scheduled' | 'running' = 'idle'
  let idleRequested = false
  const writeGroups = new Set<CachePolicyGroup>()

  const requestRun = () => {
    if (state != 'idle') return
    state = 'scheduled'
    schedule(() => {
      state = 'running'
      const idle = idleRequested
      idleRequested = false
      const groups = [...writeGroups]
      writeGroups.clear()
      void (async() => {
        if (!idle) {
          const snapshot = await runSnapshot()
          if (snapshot.status == 'unavailable' ||
            !groups.some(group => exceedsTrigger(group, snapshot.value, policy))) return
        }
        await prune({ nowMs: now(), batchSize })
      })().catch(() => {}).finally(() => {
        state = 'idle'
        if (idleRequested || writeGroups.size > 0) requestRun()
      })
    })
  }

  return {
    requestAfterWrite(group: CachePolicyGroup): void {
      writeGroups.add(group)
      requestRun()
    },
    requestIdle(): void {
      idleRequested = true
      requestRun()
    },
  }
}

const productionScheduler = createCachePruneScheduler()

export const scheduleCachePruneAfterWrite = (group: CachePolicyGroup): void => {
  productionScheduler.requestAfterWrite(group)
}

export const scheduleIdleCachePrune = (): void => {
  productionScheduler.requestIdle()
}
