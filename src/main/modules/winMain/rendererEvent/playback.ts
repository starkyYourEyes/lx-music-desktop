import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import type {
  ListeningStatsV1,
  PlaybackCheckpointAckV1,
  PlaybackCommitRequestV1,
  PlaybackPreplayFailureV1,
  PlaybackResumeAckV1,
  PlaybackResumeUpdateV1,
  PlaybackResumeV1,
  PlaybackStartCommandV1,
  PlaybackStartResultV1,
  RecentTrackV1,
} from '@common/storage/playback'
import {
  parseListeningStats,
  parsePlaybackCheckpointAck,
  parsePlaybackCommitRequest,
  parsePlaybackPreplayFailure,
  parsePlaybackResume,
  parsePlaybackResumeAck,
  parsePlaybackResumeUpdate,
  parsePlaybackStartCommand,
  parsePlaybackStartResult,
  parseRecentTrack,
} from '@common/storage/playbackValidation'
import { assertRecord } from '@common/storage/validation'

type Awaitable<T> = Promise<T> | T
interface PlaybackRecentQueryV1 { version: 1, limit: number }

export interface PlaybackHandlerDependencies {
  playbackStart: (request: PlaybackStartCommandV1) => Awaitable<PlaybackStartResultV1>
  playbackCommit: (request: PlaybackCommitRequestV1) => Awaitable<PlaybackCheckpointAckV1>
  playbackUpdateResume: (request: PlaybackResumeUpdateV1) => Awaitable<PlaybackResumeAckV1>
  playbackRecordPreplayFailure: (request: PlaybackPreplayFailureV1) => Awaitable<PlaybackCheckpointAckV1>
  playbackGetRecent: (request: PlaybackRecentQueryV1) => Awaitable<RecentTrackV1[]>
  playbackGetListeningStats: () => Awaitable<ListeningStatsV1>
  playbackGetResume: () => Awaitable<PlaybackResumeV1 | null>
}

const invalidRecentQuery = (): never => {
  throw new Error('Invalid playback recent query')
}

const assertPlaybackRecord: (value: unknown, field: string) => asserts value is Record<string, unknown> = assertRecord

const parseRecentQuery = (value: unknown): PlaybackRecentQueryV1 => {
  try {
    assertPlaybackRecord(value, 'playback recent query')
    const keys = Object.keys(value)
    if (keys.length != 2 || !Object.hasOwn(value, 'version') || !Object.hasOwn(value, 'limit')) invalidRecentQuery()
    if (value.version !== 1 || !Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 520) invalidRecentQuery()
    return { version: 1, limit: value.limit as number }
  } catch {
    return invalidRecentQuery()
  }
}

const parseRecentResult = (value: unknown): RecentTrackV1[] => {
  try {
    if (!Array.isArray(value)) throw new Error('Invalid playback recent result')
    return value.map(parseRecentTrack)
  } catch {
    throw new Error('Invalid playback recent result')
  }
}

const requireAbsent = (value: unknown, name: string): void => {
  if (value !== undefined) throw new Error(`Invalid playback ${name} query`)
}

const validateWorkerResult = async<T>(
  endpoint: string,
  invoke: () => Awaitable<T>,
  validate: (value: unknown) => unknown,
): Promise<T> => {
  try {
    const result = await invoke()
    validate(result)
    return result
  } catch {
    throw new Error(`Invalid playback ${endpoint} result`)
  }
}

export const createPlaybackHandlers = (deps: PlaybackHandlerDependencies) => ({
  start: async(value: unknown): Promise<PlaybackStartResultV1> => {
    const request = parsePlaybackStartCommand(value)
    return validateWorkerResult('start', async() => deps.playbackStart(request), parsePlaybackStartResult)
  },
  commit: async(value: unknown): Promise<PlaybackCheckpointAckV1> => {
    const request = parsePlaybackCommitRequest(value)
    return validateWorkerResult('commit', async() => deps.playbackCommit(request), parsePlaybackCheckpointAck)
  },
  resumeUpdate: async(value: unknown): Promise<PlaybackResumeAckV1> => {
    const request = parsePlaybackResumeUpdate(value)
    return validateWorkerResult('resume update', async() => deps.playbackUpdateResume(request), parsePlaybackResumeAck)
  },
  preplayFailure: async(value: unknown): Promise<PlaybackCheckpointAckV1> => {
    const request = parsePlaybackPreplayFailure(value)
    return validateWorkerResult('preplay failure', async() => deps.playbackRecordPreplayFailure(request), parsePlaybackCheckpointAck)
  },
  recentGet: async(value: unknown): Promise<RecentTrackV1[]> => {
    const request = parseRecentQuery(value)
    return validateWorkerResult('recent', async() => deps.playbackGetRecent(request), parseRecentResult)
  },
  listeningGet: async(value: unknown): Promise<ListeningStatsV1> => {
    requireAbsent(value, 'listening')
    return validateWorkerResult('listening', async() => deps.playbackGetListeningStats(), parseListeningStats)
  },
  resumeGet: async(value: unknown): Promise<PlaybackResumeV1 | null> => {
    requireAbsent(value, 'resume')
    return validateWorkerResult('resume', async() => deps.playbackGetResume(), result => {
      if (result != null) parsePlaybackResume(result)
    })
  },
})

export default () => {
  const handlers = createPlaybackHandlers({
    playbackStart: request => global.lx.worker.dbService.playbackStart(request),
    playbackCommit: request => global.lx.worker.dbService.playbackCommit(request),
    playbackUpdateResume: request => global.lx.worker.dbService.playbackUpdateResume(request),
    playbackRecordPreplayFailure: request => global.lx.worker.dbService.playbackRecordPreplayFailure(request),
    playbackGetRecent: request => global.lx.worker.dbService.playbackGetRecent(request),
    playbackGetListeningStats: () => global.lx.worker.dbService.playbackGetListeningStats(),
    playbackGetResume: () => global.lx.worker.dbService.playbackGetResume(),
  })

  mainHandle<unknown, PlaybackStartResultV1>(WIN_MAIN_RENDERER_EVENT_NAME.playback_start, async({ params }) => handlers.start(params))
  mainHandle<unknown, PlaybackCheckpointAckV1>(WIN_MAIN_RENDERER_EVENT_NAME.playback_commit, async({ params }) => handlers.commit(params))
  mainHandle<unknown, PlaybackResumeAckV1>(WIN_MAIN_RENDERER_EVENT_NAME.playback_resume_update, async({ params }) => handlers.resumeUpdate(params))
  mainHandle<unknown, PlaybackCheckpointAckV1>(WIN_MAIN_RENDERER_EVENT_NAME.playback_preplay_failure, async({ params }) => handlers.preplayFailure(params))
  mainHandle<unknown, RecentTrackV1[]>(WIN_MAIN_RENDERER_EVENT_NAME.playback_recent_get, async({ params }) => handlers.recentGet(params))
  mainHandle<unknown, ListeningStatsV1>(WIN_MAIN_RENDERER_EVENT_NAME.playback_listening_get, async({ params }) => handlers.listeningGet(params))
  mainHandle<unknown, PlaybackResumeV1 | null>(WIN_MAIN_RENDERER_EVENT_NAME.playback_resume_get, async({ params }) => handlers.resumeGet(params))
}
