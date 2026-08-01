import { log } from '@common/utils'
import { createPlaybackSourceError, isPlaybackSourceError } from '@common/utils/playbackSourceError'
import { onBeforeUnmount, watch } from '@common/utils/vueTools'
import { getCurrentTime, onTimeupdate } from '@renderer/plugins/player'
import { playProgress } from '@renderer/store/player/playProgress'
import { musicInfo } from '@renderer/store/player/state'
import { getNextPlayMusicInfo, resetRandomNextMusicInfo } from '@renderer/core/player'
import {
  getPlaybackSongIdentity,
  playbackResolutionCoordinator,
  type PlaybackResolutionCoordinator,
  type PreloadCancelReason,
} from '@renderer/core/music/playback'
import { appSetting } from '@renderer/store/setting'

export interface NextMusicPreloadController {
  start: (info: LX.Music.MusicInfo | LX.Download.ListItem) => Promise<void>
  cancel: (reason: PreloadCancelReason) => void
  dispose: () => void
}

export type CreateNextMusicPreloadController = (deps: {
  coordinator: Pick<PlaybackResolutionCoordinator, 'startPreload' | 'cancelPreload'>
  setLoading: (value: boolean) => void
  recordFailure: (error: LX.Playback.SourceError) => void
}) => NextMusicPreloadController

export interface NextMusicPreloadScheduler {
  setProgress: (time: number) => void
  tick: (time: number, duration: number) => void
  musicToggled: () => void
  toggleModeChanged: () => void
  dispose: () => void
}

export type CreateNextMusicPreloadScheduler = (deps: {
  selectNext: () => Promise<LX.Player.PlayMusicInfo | null>
  controller: NextMusicPreloadController
  resetRandomNextMusicInfo: () => void
  getCurrentProgress: () => number
  recordSelectionFailure: () => void
}) => NextMusicPreloadScheduler

export const createNextMusicPreloadController: CreateNextMusicPreloadController = deps => {
  let token = 0
  let disposed = false
  return {
    async start(info) {
      if (disposed) return
      const current = ++token
      deps.setLoading(true)
      try {
        await deps.coordinator.startPreload(info)
      } catch (error) {
        const failure = isPlaybackSourceError(error) ? error : createPlaybackSourceError({
          message: error instanceof Error ? error.message : 'Preload resolution failed',
          scope: 'candidate',
          kind: 'request',
          cause: error,
        })
        if (!disposed && current == token &&
            !(failure.scope == 'session' && failure.kind == 'cancelled')) {
          deps.recordFailure(failure)
        }
      } finally {
        if (!disposed && current == token) deps.setLoading(false)
      }
    },
    cancel(reason) {
      if (disposed) return
      token++
      deps.coordinator.cancelPreload(reason)
      deps.setLoading(false)
    },
    dispose() {
      if (disposed) return
      disposed = true
      token++
      deps.coordinator.cancelPreload('preloadReplaced')
      deps.setLoading(false)
    },
  }
}

export const createNextMusicPreloadScheduler: CreateNextMusicPreloadScheduler = deps => {
  let lastSelectionProgress = 0
  let scheduledIdentity: string | null = null
  let selectionPending = false
  let selectionGeneration = 0
  let disposed = false

  const invalidateSelection = () => {
    selectionGeneration++
    selectionPending = false
  }
  const finishSelection = (generation: number) => {
    if (generation == selectionGeneration) selectionPending = false
  }
  const selectAndSchedule = async(time: number) => {
    if (disposed || selectionPending || time - lastSelectionProgress < 3) return
    selectionPending = true
    lastSelectionProgress = time
    const generation = ++selectionGeneration
    try {
      const next = await deps.selectNext()
      if (disposed || generation != selectionGeneration) return
      const identity = next ? getPlaybackSongIdentity(next.musicInfo) : null
      if (identity == scheduledIdentity) return
      if (scheduledIdentity) deps.controller.cancel('preloadReplaced')
      scheduledIdentity = identity
      if (next) void deps.controller.start(next.musicInfo)
    } catch {
      if (!disposed && generation == selectionGeneration) deps.recordSelectionFailure()
    } finally {
      finishSelection(generation)
    }
  }

  return {
    setProgress(time) { lastSelectionProgress = time },
    tick(time, duration) {
      if (disposed || duration <= 10 || duration - time >= 10) return
      void selectAndSchedule(time)
    },
    musicToggled() {
      invalidateSelection()
      lastSelectionProgress = 0
      scheduledIdentity = null
    },
    toggleModeChanged() {
      deps.resetRandomNextMusicInfo()
      invalidateSelection()
      if (scheduledIdentity) deps.controller.cancel('preloadReplaced')
      scheduledIdentity = null
      lastSelectionProgress = deps.getCurrentProgress()
    },
    dispose() {
      if (disposed) return
      disposed = true
      invalidateSelection()
      scheduledIdentity = null
      deps.controller.dispose()
    },
  }
}

export default () => {
  const controller = createNextMusicPreloadController({
    coordinator: playbackResolutionCoordinator,
    setLoading() {},
    recordFailure(error) {
      log.debug('next music preload failed', {
        scope: error.scope,
        kind: error.kind,
        apiId: error.apiId,
        platform: error.platform,
        statusCode: error.statusCode,
      })
    },
  })
  const scheduler = createNextMusicPreloadScheduler({
    selectNext: getNextPlayMusicInfo,
    controller,
    resetRandomNextMusicInfo,
    getCurrentProgress: () => playProgress.nowPlayTime,
    recordSelectionFailure: () => log.debug('next music selection failed'),
  })
  const handleSetProgress = (time: number) => {
    if (musicInfo.id) scheduler.setProgress(time)
  }
  const handleMusicToggled = () => { scheduler.musicToggled() }
  const stopToggleWatch = watch(
    () => appSetting['player.togglePlayMethod'],
    () => { scheduler.toggleModeChanged() },
  )
  window.app_event.on('setProgress', handleSetProgress)
  window.app_event.on('musicToggled', handleMusicToggled)
  const stopTimeupdate = onTimeupdate(() => {
    scheduler.tick(getCurrentTime(), playProgress.maxPlayTime)
  })
  onBeforeUnmount(() => {
    stopToggleWatch()
    stopTimeupdate()
    window.app_event.off('setProgress', handleSetProgress)
    window.app_event.off('musicToggled', handleMusicToggled)
    scheduler.dispose()
  })
}
