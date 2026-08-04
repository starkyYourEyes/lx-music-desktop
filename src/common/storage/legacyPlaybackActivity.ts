import { sha256Canonical, type JsonValue } from './canonicalJson'
import type { LegacyListeningImportV1 } from './legacyListening'
import type { PlaybackTrackV1 } from './playback'

export interface LegacyPlaybackActivityHashInputV1 {
  recent: Array<{ track: PlaybackTrackV1, legacyRank: number }>
  listening: LegacyListeningImportV1
  resume: {
    listId: string
    indexHint: number
    positionMs: number
    durationMs: number
  } | null
}

export const LEGACY_PLAYBACK_ACTIVITY_HASH_VERSION = 1 as const

export const canonicalLegacyPlaybackActivityPayload = (
  input: LegacyPlaybackActivityHashInputV1,
): JsonValue => ({
  version: LEGACY_PLAYBACK_ACTIVITY_HASH_VERSION,
  recent: input.recent,
  listening: input.listening,
  resume: input.resume,
}) as unknown as JsonValue

export const legacyPlaybackActivitySha256 = (input: LegacyPlaybackActivityHashInputV1): string =>
  sha256Canonical(canonicalLegacyPlaybackActivityPayload(input))

export const compareCanonicalText = (left: string, right: string): number =>
  left == right ? 0 : left < right ? -1 : 1

export const legacyPlaybackTrackKey = (source: string, sourceTrackId: string): string =>
  JSON.stringify([source, sourceTrackId])

export const compareLegacyPlaybackTrack = (
  left: { source: string, sourceTrackId: string },
  right: { source: string, sourceTrackId: string },
): number => compareCanonicalText(left.source, right.source) ||
  compareCanonicalText(left.sourceTrackId, right.sourceTrackId)
