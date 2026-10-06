import { log } from '@common/utils'
import { createPlaybackSourceError, isPlaybackSourceError } from '@common/utils/playbackSourceError'
import { onBeforeUnmount, watch } from '@common/utils/vueTools'
import { getCurrentTime, onTimeupdate } from '@renderer/plugins/player'
import { playProgress } from '@renderer/store/player/playProgress'
import { musicInfo, playMusicInfo, playInfo, tempPlayList, playedList, playbackNotice } from '@renderer/store/player/state'
import { party } from '@renderer/store/party'
import { preloadFailureState } from '@renderer/core/player/preloadState'
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
  tick: (time: number, duration: number, stableTime?: number) => void
  musicToggled: () => void
  toggleModeChanged: () => void
  preloadFailed: () => void
  queueChanged: () => void
  dispose: () => void
}

export type CreateNextMusicPreloadScheduler = (deps: {
  selectNext: () => Promise<LX.Player.PlayMusicInfo | null>
  controller: NextMusicPreloadController
  resetRandomNextMusicInfo: () => void
  getCurrentProgress: () => number
  recordSelectionFailure: () => void
  onSelected?: (info: LX.Player.PlayMusicInfo | null) => void
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
  let lastSelectionProgress = -Infinity
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
      deps.onSelected?.(next)
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
    setProgress(time) { lastSelectionProgress = -Infinity },
    tick(time, duration, stableTime = time) {
      if (disposed || stableTime < 5) return
      void selectAndSchedule(time)
    },
    musicToggled() {
      invalidateSelection()
      lastSelectionProgress = -Infinity
      scheduledIdentity = null
    },
    toggleModeChanged() {
      deps.resetRandomNextMusicInfo()
      invalidateSelection()
      if (scheduledIdentity) deps.controller.cancel('preloadReplaced')
      scheduledIdentity = null
      lastSelectionProgress = deps.getCurrentProgress()
    },
    preloadFailed() {
      invalidateSelection()
      scheduledIdentity = null
      lastSelectionProgress = -Infinity
    },
    queueChanged() {
      invalidateSelection()
      lastSelectionProgress = -Infinity
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
  let selected: LX.Player.PlayMusicInfo | null = null
  let selectionCache: Promise<LX.Player.PlayMusicInfo | null> | null = null
  let stableSince: number | null = null
  let initialized = false
  const enabled = () => appSetting['player.preloadNext']
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
    async selectNext() {
      if (!enabled() || preloadFailureState.stopped) return null
      const excluded = new Set(appSetting['player.autoSkipOnError'] ? preloadFailureState.failed : [])
      if (excluded.size && playMusicInfo.musicInfo) excluded.add(getPlaybackSongIdentity(playMusicInfo.musicInfo))
      if (!selectionCache) {
        const pending = getNextPlayMusicInfo(excluded)
        selectionCache = pending
        void pending.catch(() => { if (selectionCache == pending) selectionCache = null })
      }
      return selectionCache
    },
    onSelected: info => { selected = info },
    controller,
    resetRandomNextMusicInfo,
    getCurrentProgress: () => playProgress.nowPlayTime,
    recordSelectionFailure: () => log.debug('next music selection failed'),
  })
  const handleSetProgress = (time: number) => {
    if (musicInfo.id) scheduler.setProgress(time)
    stableSince = null
  }
  const handleMusicToggled = () => {
    scheduler.musicToggled()
    stableSince = null
    initialized = false
    selected = null
    selectionCache = null
  }
  const handlePlaying = () => { stableSince ??= performance.now() }
  const handleUnstable = () => { stableSince = null }
  const handleStop = () => {
    handleUnstable()
    controller.cancel('preloadReplaced')
    scheduler.musicToggled()
    selectionCache = null
  }
  const stopFailures = playbackResolutionCoordinator.onPreloadFailure(identity => {
    if (!enabled() || !selected || getPlaybackSongIdentity(selected.musicInfo) != identity) return
    const info = selected.musicInfo
    const name = 'progress' in info ? info.metadata.musicInfo.name : info.name
    const autoSkip = appSetting['player.autoSkipOnError']
    if (autoSkip && !preloadFailureState.add(info)) return
    playbackNotice.value = window.i18n.t(autoSkip ? 'player__preload_skipped' : 'player__preload_failed', { name })
    if (!autoSkip) return
    if (preloadFailureState.stopped) playbackNotice.value = window.i18n.t('player__preload_stopped')
    selectionCache = null
    scheduler.preloadFailed()
    if (stableSince != null) scheduler.tick(getCurrentTime(), playProgress.maxPlayTime, (performance.now() - stableSince) / 1000)
  })
  const stopToggleWatch = watch(
    () => [
      appSetting['player.togglePlayMethod'], appSetting['player.preloadNext'],
      appSetting['player.playQuality'], appSetting['common.apiSource'],
      [...appSetting['common.apiFallbackSources']], appSetting['player.autoSkipOnError'],
    ],
    () => {
      controller.cancel('preloadReplaced')
      scheduler.toggleModeChanged()
      preloadFailureState.reset()
      playbackNotice.value = ''
      selected = null
      selectionCache = null
    },
    { deep: true },
  )
  // Early preloading must not scan a large playlist on every progress update.
  // Invalidate the preview only when its queue inputs change.
  const handleQueueChanged = () => {
    selectionCache = null
    scheduler.queueChanged()
  }
  const handleListChanged = (ids: string[]) => {
    if (playInfo.playerListId && ids.includes(playInfo.playerListId)) handleQueueChanged()
  }
  const stopQueueWatch = watch(
    () => [
      ...tempPlayList, ...playedList,
      ...(party.room?.playback.queue.map(item => item.musicInfo) ?? []),
      party.room?.playback.currentIndex,
    ],
    handleQueueChanged,
  )
  window.app_event.on('myListUpdate', handleListChanged)
  window.app_event.on('downloadListUpdate', handleQueueChanged)
  window.app_event.on('setProgress', handleSetProgress)
  window.app_event.on('musicToggled', handleMusicToggled)
  window.app_event.on('playerPlaying', handlePlaying)
  window.app_event.on('playerWaiting', handleUnstable)
  window.app_event.on('playerPause', handleUnstable)
  window.app_event.on('playerSeeking', handleUnstable)
  window.app_event.on('playerSeeked', handlePlaying)
  window.app_event.on('stop', handleStop)
  const stopTimeupdate = onTimeupdate(() => {
    if (stableSince == null || performance.now() - stableSince < 5_000) return
    if (!initialized) {
      initialized = true
      preloadFailureState.reset()
      playbackNotice.value = ''
    }
    if (!enabled()) return
    scheduler.tick(getCurrentTime(), playProgress.maxPlayTime, (performance.now() - stableSince) / 1000)
  })
  onBeforeUnmount(() => {
    stopToggleWatch()
    stopQueueWatch()
    stopTimeupdate()
    stopFailures()
    window.app_event.off('setProgress', handleSetProgress)
    window.app_event.off('musicToggled', handleMusicToggled)
    window.app_event.off('playerPlaying', handlePlaying)
    window.app_event.off('playerWaiting', handleUnstable)
    window.app_event.off('playerPause', handleUnstable)
    window.app_event.off('playerSeeking', handleUnstable)
    window.app_event.off('playerSeeked', handlePlaying)
    window.app_event.off('stop', handleStop)
    window.app_event.off('myListUpdate', handleListChanged)
    window.app_event.off('downloadListUpdate', handleQueueChanged)
    scheduler.dispose()
  })
}
