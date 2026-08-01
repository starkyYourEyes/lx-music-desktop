export type PlaybackStartReason =
  | 'select' | 'next' | 'previous' | 'auto' | 'restore' | 'remote'
  | 'day_boundary' | 'statistics_clear'

export type PlaybackPauseReason = 'user' | 'system' | 'remote' | 'recovery'
export type PlaybackSeekOrigin =
  | 'bar' | 'hotkey' | 'media_session' | 'lyric'
  | 'party' | 'restore' | 'buffer_recovery'
export type PlaybackSkipReason =
  | 'next' | 'previous' | 'select' | 'dislike' | 'stop' | 'error'
  | 'load_timeout' | 'buffer_timeout' | 'queue_removed'
export type PlaybackEndReason = PlaybackSkipReason | 'natural_end' | 'day_boundary' | 'statistics_clear'

export interface PlaybackSelectionIntent {
  track: PlaybackTrackV1
  context: PlaybackStartCommandV1['context']
  resume: PlaybackStartCommandV1['resume']
  startReason: PlaybackStartReason
  startPositionMs: number
}

export type PlaybackSelectionOptions = Pick<PlaybackSelectionIntent, 'startReason' | 'startPositionMs'>

export interface PlaybackSeekIntent {
  origin: PlaybackSeekOrigin
  fromMs: number
  toMs: number
}

export interface PlaybackCheckpointV1 {
  playbackGroupUuid: string
  checkpointSeq: number
  cumulativePlayedMs: number
  cumulativeActiveMs: number
  positionMs: number
  durationMs: number | null
  occurredAtMs: number
}

export interface PlaybackCheckpointAckV1 {
  playbackGroupUuid: string
  sessionUuid: string
  segmentNo: number
  checkpointSeq: number
  cumulativePlayedMs: number
  cumulativeActiveMs: number
}

export interface PlaybackTrackV1 {
  source: string
  sourceTrackId: string
  name: string
  singer: string
  durationMs: number | null
  playablePayload: LX.Music.MusicInfo | null
}

export interface PlaybackStartCommandV1 {
  version: 1
  playbackGroupUuid: string
  track: PlaybackTrackV1
  context: { type: string | null, id: string | null }
  resume: { listId: string | null, indexHint: number | null }
  startReason: PlaybackStartReason
  startPositionMs: number
  occurredAtMs: number
  consent: {
    recentAllowed: boolean
    statsAllowed: boolean
    privateMode: boolean
  }
}

export type PlaybackFactV1 =
  | { version: 1, type: 'play_start', reason: PlaybackStartReason }
  | { version: 1, type: 'pause' | 'resume', reason: PlaybackPauseReason }
  | { version: 1, type: 'seek', origin: PlaybackSeekOrigin, fromMs: number, toMs: number }
  | { version: 1, type: 'skip', reason: PlaybackSkipReason, automatic: boolean }
  | { version: 1, type: 'play_end', reason: 'natural_end' }
  | {
    version: 1
    type: 'error'
    stage: 'url' | 'load' | 'decode' | 'buffer' | 'output' | 'unknown'
    code: number | null
    recoverable: boolean
    attempt: number
  }

export type PlaybackErrorIntent = Omit<Extract<PlaybackFactV1, { type: 'error' }>, 'version' | 'type'>

export interface PlaybackPreplayFailureV1 {
  version: 1
  playbackGroupUuid: string
  track: PlaybackTrackV1
  context: { type: string | null, id: string | null }
  resume: { listId: string | null, indexHint: number | null }
  startReason: PlaybackStartReason
  startPositionMs: number
  occurredAtMs: number
  error: Extract<PlaybackFactV1, { type: 'error' }>
  consent: PlaybackStartCommandV1['consent']
}

export interface PlaybackResumeUpdateV1 {
  version: 1
  playbackGroupUuid: string
  checkpointSeq: number
  track: Pick<PlaybackTrackV1, 'source' | 'sourceTrackId'>
  listId: string | null
  indexHint: number | null
  positionMs: number
  durationMs: number | null
  updatedAtMs: number
}

export interface PlaybackResumeAckV1 {
  playbackGroupUuid: string
  checkpointSeq: number
  positionMs: number
}

export type PlaybackStartResultV1 =
  | { mode: 'activity', ack: PlaybackCheckpointAckV1 }
  | { mode: 'resume-only', ack: PlaybackResumeAckV1 }
  | { mode: 'private', playbackGroupUuid: string, checkpointSeq: number }

export type PlaybackCommitRequestV1 =
  | { version: 1, checkpoint: PlaybackCheckpointV1, fact?: PlaybackFactV1 }
  | {
    version: 1
    checkpoint: PlaybackCheckpointV1
    boundary: { type: 'day_boundary', nextLocalDay: string, utcOffsetMinutes: number }
  }

export type PlaybackRecorderCommandV1 =
  | { kind: 'start', request: PlaybackStartCommandV1 }
  | { kind: 'commit', request: PlaybackCommitRequestV1 }
  | { kind: 'resume', request: PlaybackResumeUpdateV1 }
  | { kind: 'preplay_failure', request: PlaybackPreplayFailureV1 }

export interface RecentTrackV1 extends PlaybackTrackV1 {
  version: 1
  lastPlayedAtMs: number | null
  legacyRank: number | null
}

export interface ListeningBucketV1 {
  baselinePlayedMs: number
  livePlayedMs: number
  baselineActiveMs: number
  liveActiveMs: number
  playedMs: number
  activeMs: number
}

export interface ListeningStatsV1 {
  version: 1
  total: ListeningBucketV1
  daily: Array<ListeningBucketV1 & { localDay: string }>
  tracks: Array<ListeningBucketV1 & Omit<PlaybackTrackV1, 'playablePayload'>>
  updatedAtMs: number
}

export interface PlaybackResumeV1 {
  version: 1
  source: string
  sourceTrackId: string
  listId: string | null
  indexHint: number | null
  positionMs: number
  durationMs: number | null
  updatedAtMs: number
}
