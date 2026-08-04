import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { rendererInvoke } from '@common/rendererIpc'
import type {
  ListeningStatsV1,
  PlaybackCheckpointAckV1,
  PlaybackCommitRequestV1,
  PlaybackPreplayFailureV1,
  PlaybackRecorderCommandV1,
  PlaybackResumeAckV1,
  PlaybackResumeUpdateV1,
  PlaybackResumeV1,
  PlaybackStartCommandV1,
  PlaybackStartResultV1,
  RecentTrackV1,
} from '@common/storage/playback'

export const startPlayback = (request: PlaybackStartCommandV1) => rendererInvoke<PlaybackStartCommandV1, PlaybackStartResultV1>(
  WIN_MAIN_RENDERER_EVENT_NAME.playback_start,
  request,
)

export const commitPlayback = (request: PlaybackCommitRequestV1) => rendererInvoke<PlaybackCommitRequestV1, PlaybackCheckpointAckV1>(
  WIN_MAIN_RENDERER_EVENT_NAME.playback_commit,
  request,
)

export const updatePlaybackResume = (request: PlaybackResumeUpdateV1) => rendererInvoke<PlaybackResumeUpdateV1, PlaybackResumeAckV1>(
  WIN_MAIN_RENDERER_EVENT_NAME.playback_resume_update,
  request,
)

export const recordPlaybackPreplayFailure = (request: PlaybackPreplayFailureV1) => rendererInvoke<PlaybackPreplayFailureV1, PlaybackCheckpointAckV1>(
  WIN_MAIN_RENDERER_EVENT_NAME.playback_preplay_failure,
  request,
)

export const getRecentPlayback = (limit: number) => rendererInvoke<{ version: 1, limit: number }, RecentTrackV1[]>(
  WIN_MAIN_RENDERER_EVENT_NAME.playback_recent_get,
  { version: 1, limit },
)

export const getListeningPlayback = () => rendererInvoke<ListeningStatsV1>(WIN_MAIN_RENDERER_EVENT_NAME.playback_listening_get)

export const getPlaybackResume = () => rendererInvoke<PlaybackResumeV1 | null>(WIN_MAIN_RENDERER_EVENT_NAME.playback_resume_get)

export const sendPlaybackCommand = async(command: PlaybackRecorderCommandV1): Promise<unknown> => {
  switch (command.kind) {
    case 'start': return startPlayback(command.request)
    case 'commit': return commitPlayback(command.request)
    case 'resume': return updatePlaybackResume(command.request)
    case 'preplay_failure': return recordPlaybackPreplayFailure(command.request)
  }
}
