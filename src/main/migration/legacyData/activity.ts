import { DATA_KEYS } from '../../../common/constants'
import { sha256Canonical, type JsonValue } from '../../../common/storage/canonicalJson'
import { convertLegacyListeningStats, type LegacyListeningImportV1 } from '../../../common/storage/legacyListening'
import type { PlaybackTrackV1 } from '../../../common/storage/playback'
import { parsePlaybackTrack, sanitizePlayableTrack } from '../../../common/storage/playbackValidation'
import type { CredentialVault } from '../../storage/credentials/credentialVault'
import type { LegacyQuarantinePayloadV1 } from '../../storage/credentials/types'
import type { MigrationMarker } from '../../worker/dbService/migrations/types'
import type {
  LegacyPlaybackActivityImportResultV1,
  LegacyPlaybackActivityImportV1,
  LegacyPlaybackResumeHintV1,
  PlaybackActivityImportFailPoint,
} from '../../worker/dbService/modules/playback'
import type { LegacyDataSnapshotV1 } from './source'

type Awaitable<T> = T | Promise<T>

export type LegacyPlaybackMigrationFailPoint =
  | 'after-quarantine'
  | 'before-transaction'
  | PlaybackActivityImportFailPoint
  | 'after-commit'

export interface LegacyPlaybackMigrationDeps {
  source: LegacyDataSnapshotV1 | null
  vault: Pick<CredentialVault, 'mode' | 'read' | 'write' | 'verify'> | null | undefined
  repository: {
    importLegacyPlaybackActivity: (
      input: LegacyPlaybackActivityImportV1,
    ) => Awaitable<LegacyPlaybackActivityImportResultV1>
    getPlaybackActivityMigrationMarker: () => Awaitable<MigrationMarker | null>
  }
  now?: () => number
  failAt?: LegacyPlaybackMigrationFailPoint
}

export type LegacyPlaybackMigrationResult =
  | {
    status: 'no-source'
    quarantineKeys: []
  }
  | (LegacyPlaybackActivityImportResultV1 & { quarantineKeys: string[] })

interface NormalizedActivity {
  sourceSha256: string
  recent: LegacyPlaybackActivityImportV1['recent']
  listening: LegacyListeningImportV1
  resume: LegacyPlaybackResumeHintV1 | null
}

const ACTIVITY_MARKER_NAME = 'legacy_data_v1.playback_activity'
const MAX_RECENT_TRACKS = 520
const MAX_TRACK_STRING_LENGTH = 256
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000
const SHA256_PATTERN = /^[0-9a-f]{64}$/

const knownLegacyKeys = new Set<string>([
  ...Object.values(DATA_KEYS),
  'listPosition',
  'ignoreVersion',
  'lastStartInfo',
])

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) == Object.prototype

const isTrackString = (value: unknown): value is string =>
  typeof value == 'string' && value.length > 0 && value.length <= MAX_TRACK_STRING_LENGTH

const secondsToDurationMs = (value: unknown): number | null => {
  if (typeof value != 'number' || !Number.isFinite(value) || value < 0) return null
  const milliseconds = Math.round(value * 1000)
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= MAX_DURATION_MS
    ? milliseconds
    : null
}

const saturatedMismatch = (total: number, values: readonly number[]): number => {
  const limit = BigInt(Number.MAX_SAFE_INTEGER)
  let result = BigInt(total)
  for (const value of values) {
    result -= BigInt(value)
    if (result <= -limit) return -Number.MAX_SAFE_INTEGER
  }
  return Number(result)
}

const normalizeRecent = (value: unknown): LegacyPlaybackActivityImportV1['recent'] => {
  if (!Array.isArray(value)) return []
  const result: LegacyPlaybackActivityImportV1['recent'] = []
  const identities = new Set<string>()
  for (const candidate of value) {
    let playablePayload: LX.Music.MusicInfo
    let track: PlaybackTrackV1
    try {
      playablePayload = sanitizePlayableTrack(candidate)
      track = parsePlaybackTrack({
        source: playablePayload.source,
        sourceTrackId: playablePayload.id,
        name: playablePayload.name,
        singer: playablePayload.singer,
        durationMs: null,
        playablePayload,
      })
    } catch {
      continue
    }
    const identity = `${track.source}\0${track.sourceTrackId}`
    if (identities.has(identity)) continue
    identities.add(identity)
    result.push({ track, legacyRank: result.length + 1 })
    if (result.length == MAX_RECENT_TRACKS) break
  }
  return result
}

const normalizeListening = (value: unknown): LegacyListeningImportV1 => {
  const converted = convertLegacyListeningStats(value)
  const daily = [...converted.daily].sort((left, right) => left.localDay.localeCompare(right.localDay))
  const tracks: LegacyListeningImportV1['tracks'] = []
  const identities = new Set<string>()
  for (const track of converted.tracks) {
    const identity = `${track.source}\0${track.sourceTrackId}`
    if (identities.has(identity)) continue
    identities.add(identity)
    tracks.push(track)
  }
  tracks.sort((left, right) => left.source.localeCompare(right.source) || left.sourceTrackId.localeCompare(right.sourceTrackId))
  return {
    totalPlayedMs: converted.totalPlayedMs,
    daily,
    tracks,
    mismatch: {
      totalVsDailyMs: saturatedMismatch(converted.totalPlayedMs, daily.map(entry => entry.baselinePlayedMs)),
      totalVsTracksMs: saturatedMismatch(converted.totalPlayedMs, tracks.map(entry => entry.baselinePlayedMs)),
    },
    baselineActiveTimeKnown: false,
  }
}

const normalizeResume = (value: unknown): LegacyPlaybackResumeHintV1 | null => {
  if (!isPlainRecord(value) || !isTrackString(value.listId) ||
    !Number.isSafeInteger(value.index) || (value.index as number) < 0 || (value.index as number) > 1_000_000) return null
  const positionMs = secondsToDurationMs(value.time)
  const durationMs = secondsToDurationMs(value.maxTime)
  if (positionMs == null || durationMs == null || positionMs > durationMs) return null
  return {
    listId: value.listId,
    indexHint: value.index as number,
    positionMs,
    durationMs,
  }
}

const normalizeActivity = (source: LegacyDataSnapshotV1): NormalizedActivity => {
  const recent = normalizeRecent(source.parsed.recentPlayList)
  const listening = normalizeListening(source.parsed.listeningTimeStats)
  const resume = normalizeResume(source.parsed.playInfo)
  return {
    sourceSha256: sha256Canonical({ version: 1, recent, listening, resume } as unknown as JsonValue),
    recent,
    listening,
    resume,
  }
}

const quarantineFor = (source: LegacyDataSnapshotV1): LegacyQuarantinePayloadV1 => {
  const keys = Object.keys(source.parsed).filter(key => !knownLegacyKeys.has(key)).sort()
  return {
    version: 1,
    sourceSha256: source.fileSha256,
    keys,
    payload: Object.fromEntries(keys.map(key => [key, source.parsed[key] as JsonValue])),
  }
}

const assertMarker = (marker: MigrationMarker | null, sourceSha256: string): void => {
  if (marker == null) return
  if (marker.name != ACTIVITY_MARKER_NAME || typeof marker.sourceSha256 != 'string' ||
    !SHA256_PATTERN.test(marker.sourceSha256) || !Number.isSafeInteger(marker.completedAtMs) ||
    marker.completedAtMs < 0 || typeof marker.detailsJson != 'string') {
    throw new Error('Invalid playback activity migration marker')
  }
  if (marker.sourceSha256 != sourceSha256) {
    throw new Error(`Migration marker ${ACTIVITY_MARKER_NAME} source conflict`)
  }
}

const assertTimestamp = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid playback activity migration timestamp')
  return value
}

const failIfRequested = (deps: LegacyPlaybackMigrationDeps, point: LegacyPlaybackMigrationFailPoint): void => {
  if (deps.failAt == point) throw new Error('injected failure')
}

const persistQuarantine = async(
  vault: LegacyPlaybackMigrationDeps['vault'],
  quarantine: LegacyQuarantinePayloadV1,
): Promise<void> => {
  if (quarantine.keys.length == 0) return
  if (vault == null || vault.mode != 'encrypted') throw new Error('Persistent encrypted quarantine vault is unavailable')
  const ref = { kind: 'legacy-quarantine' as const, sourceSha256: quarantine.sourceSha256 }
  const existing = vault.read<LegacyQuarantinePayloadV1>(ref)
  if (existing.status == 'available') {
    if (!await vault.verify(ref, quarantine)) throw new Error('Persistent encrypted quarantine mismatch')
    return
  }
  if (existing.status != 'missing') throw new Error('Persistent encrypted quarantine is unavailable')
  const written = await vault.write(ref, quarantine)
  if (written.persistence != 'encrypted' || !await vault.verify(ref, quarantine)) {
    throw new Error('Persistent encrypted quarantine verification failed')
  }
  const readback = vault.read<LegacyQuarantinePayloadV1>(ref)
  if (readback.status != 'available') throw new Error('Persistent encrypted quarantine verification failed')
}

export const migrateLegacyPlaybackActivity = async(
  deps: LegacyPlaybackMigrationDeps,
): Promise<LegacyPlaybackMigrationResult> => {
  if (deps.source == null) return { status: 'no-source', quarantineKeys: [] }
  const normalized = normalizeActivity(deps.source)
  assertMarker(await deps.repository.getPlaybackActivityMigrationMarker(), normalized.sourceSha256)
  const quarantine = quarantineFor(deps.source)
  await persistQuarantine(deps.vault, quarantine)
  failIfRequested(deps, 'after-quarantine')
  failIfRequested(deps, 'before-transaction')
  const result = await deps.repository.importLegacyPlaybackActivity({
    ...normalized,
    completedAtMs: assertTimestamp((deps.now ?? Date.now)()),
    failAt: deps.failAt == 'inside-transaction' || deps.failAt == 'before-marker' ? deps.failAt : undefined,
  })
  failIfRequested(deps, 'after-commit')
  return { ...result, quarantineKeys: [...quarantine.keys] }
}
