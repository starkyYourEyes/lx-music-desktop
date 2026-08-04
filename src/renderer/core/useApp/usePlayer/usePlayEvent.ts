import { onBeforeUnmount } from '@common/utils/vueTools'
import { useI18n } from '@renderer/plugins/i18n'
import { musicInfo, playMusicInfo } from '@renderer/store/player/state'
import { isEmpty, setStop } from '@renderer/plugins/player'
import { playNext, setMusicUrl, type SetMusicUrlOptions } from '@renderer/core/player'
import { setAllStatus } from '@renderer/store/player/action'
import { appSetting } from '@renderer/store/setting'
import {
  playbackResolutionCoordinator,
  type PlaybackClock,
  type PlaybackResolutionCoordinator,
} from '@renderer/core/music/playback'

export interface ValidationAwarePlayEventHandlers {
  loadstart: () => void
  loadeddata: () => void
  playing: () => void
  waiting: () => void
  emptied: () => void
  error: (code?: number) => void
  musicToggled: () => void
  dispose: () => void
}

type PlayEventTranslationKey =
  | 'player__loading'
  | 'player__buffering'
  | 'player__refresh_url'
  | 'player__error'

type PlaybackAutoAdvanceReason = 'load_timeout' | 'error'

export type CreateValidationAwarePlayEventHandlers = (deps: {
  coordinator: Pick<PlaybackResolutionCoordinator, 'isForegroundValidating'>
  isPlayedStop: () => boolean
  currentMusicId: () => string
  currentMusicInfo: () => LX.Player.PlayMusicInfo['musicInfo'] | null
  autoSkipOnError: () => boolean
  isDocumentHidden: () => boolean
  isPlayerEmpty: () => boolean
  setStop: () => void
  setMusicUrl: (info: NonNullable<LX.Player.PlayMusicInfo['musicInfo']>, options: SetMusicUrlOptions) => void
  playNext: (reason: PlaybackAutoAdvanceReason) => Promise<void>
  reportPlaybackError?: (error: {
    stage: 'load' | 'decode'
    code: number | null
    recoverable: boolean
    attempt: number
  }) => void
  setAllStatus: (value: string) => void
  translate: (key: PlayEventTranslationKey) => string
  clock: PlaybackClock
}) => ValidationAwarePlayEventHandlers

export const createValidationAwarePlayEventHandlers: CreateValidationAwarePlayEventHandlers = deps => {
  let retryNum = 0
  let previousTimeoutMusicId: string | null = null
  let loadingTimer: ReturnType<typeof setTimeout> | null = null
  let nextTimer: ReturnType<typeof setTimeout> | null = null
  const clearLoading = () => {
    if (loadingTimer != null) deps.clock.clearTimeout(loadingTimer)
    loadingTimer = null
  }
  const clearNext = () => {
    if (nextTimer != null) deps.clock.clearTimeout(nextTimer)
    nextTimer = null
  }
  const scheduleNext = () => {
    clearNext()
    nextTimer = deps.clock.setTimeout(() => { void deps.playNext('error') }, 5_000)
  }
  const startWatchdog = () => {
    clearLoading()
    const id = deps.currentMusicId()
    loadingTimer = deps.clock.setTimeout(() => {
      if (deps.isPlayedStop()) return
      const info = deps.currentMusicInfo()
      if (previousTimeoutMusicId == id) {
        deps.reportPlaybackError?.({ stage: 'load', code: null, recoverable: false, attempt: 2 })
        previousTimeoutMusicId = null
        void deps.playNext('load_timeout')
      } else if (info) {
        previousTimeoutMusicId = id
        deps.reportPlaybackError?.({ stage: 'load', code: null, recoverable: true, attempt: 1 })
        deps.setMusicUrl(info, { reason: 'postCommitError' })
      }
    }, 25_000)
  }
  return {
    loadstart() {
      if (deps.coordinator.isForegroundValidating() || deps.isPlayedStop()) return
      if (deps.autoSkipOnError()) startWatchdog()
      deps.setAllStatus(deps.translate('player__loading'))
    },
    loadeddata() {
      if (!deps.coordinator.isForegroundValidating()) deps.setAllStatus(deps.translate('player__loading'))
    },
    playing() {
      deps.setAllStatus('')
      clearLoading()
    },
    waiting() {
      if (!deps.coordinator.isForegroundValidating()) deps.setAllStatus(deps.translate('player__buffering'))
    },
    emptied() {
      clearNext()
      clearLoading()
    },
    error(code) {
      if (deps.coordinator.isForegroundValidating() || !deps.currentMusicId()) return
      clearLoading()
      if (deps.isPlayedStop()) return
      if (!deps.isPlayerEmpty()) deps.setStop()
      const info = deps.currentMusicInfo()
      const recoverable = info != null && code !== 1 && retryNum < 2
      deps.reportPlaybackError?.({
        stage: code == 3 ? 'decode' : 'load',
        code: code ?? null,
        recoverable,
        attempt: retryNum + 1,
      })
      if (recoverable && info) {
        retryNum++
        deps.setMusicUrl(info, { reason: 'postCommitError' })
        deps.setAllStatus(deps.translate('player__refresh_url'))
        return
      }
      if (!deps.autoSkipOnError()) return
      if (deps.isDocumentHidden()) void deps.playNext('error')
      else {
        deps.setAllStatus(deps.translate('player__error'))
        scheduleNext()
      }
    },
    musicToggled() {
      retryNum = 0
      previousTimeoutMusicId = null
      clearNext()
      clearLoading()
    },
    dispose() {
      clearNext()
      clearLoading()
    },
  }
}

export default () => {
  const t = useI18n()
  const handlers = createValidationAwarePlayEventHandlers({
    coordinator: playbackResolutionCoordinator,
    isPlayedStop: () => window.lx.isPlayedStop,
    currentMusicId: () => musicInfo.id ?? '',
    currentMusicInfo: () => playMusicInfo.musicInfo,
    autoSkipOnError: () => appSetting['player.autoSkipOnError'],
    isDocumentHidden: () => document.hidden,
    isPlayerEmpty: isEmpty,
    setStop,
    setMusicUrl,
    playNext: reason => playNext({ automatic: true, reason, startReason: 'auto' }),
    reportPlaybackError: error => window.app_event.playbackError(error),
    setAllStatus,
    translate: key => t(key),
    clock: {
      now: Date.now,
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
    },
  })
  const subscriptions = [
    ['playerLoadstart', handlers.loadstart],
    ['playerLoadeddata', handlers.loadeddata],
    ['playerPlaying', handlers.playing],
    ['playerWaiting', handlers.waiting],
    ['playerEmptied', handlers.emptied],
    ['playerError', handlers.error],
    ['musicToggled', handlers.musicToggled],
  ] as const
  for (const [name, handler] of subscriptions) window.app_event.on(name, handler)
  onBeforeUnmount(() => {
    for (const [name, handler] of subscriptions) window.app_event.off(name, handler)
    handlers.dispose()
  })
}
