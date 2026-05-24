import { debounce } from '@common/utils'
import { onBeforeUnmount } from '@common/utils/vueTools'
import { setPlaybackRate as setLyricPlaybackRate } from '@renderer/core/lyric'
import { pause, play, playMusicByInfo, getLoadedMusicIdentity } from '@renderer/core/player'
import { setCurrentTime, setPlaybackRate as setTrackPlaybackRate } from '@renderer/plugins/player'
import { syncPartyPlayback, canControlPartyPlayback, loadPartyState } from '@renderer/core/party'
import { playProgress } from '@renderer/store/player/playProgress'
import { playbackRate } from '@renderer/store/player/playbackRate'
import { isPlay, playMusicInfo } from '@renderer/store/player/state'
import { party, setPartyState } from '@renderer/store/party'
import { onPartyAction } from '@renderer/utils/ipc'

const LOCAL_SYNC_GUARD_MS = 1_500
const LOCAL_MUSIC_SWITCH_PLAY_INTENT_MS = 15_000
const SEEK_DIFF_MAX_S = 1.2

const normalizeMusicInfo = (
  musicInfo: LX.Player.PlayMusicInfo['musicInfo'] | LX.Party.PlaybackState['currentMusic'],
): LX.Music.MusicInfo | null => {
  if (!musicInfo) return null
  return 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
}

const createMusicIdentity = (
  musicInfo: LX.Player.PlayMusicInfo['musicInfo'] | LX.Party.PlaybackState['currentMusic'],
) => {
  const targetMusicInfo = normalizeMusicInfo(musicInfo)
  return targetMusicInfo ? `${targetMusicInfo.source}:${targetMusicInfo.id}` : ''
}

const getQueueCurrentIndex = (
  room: LX.Party.RoomSnapshot | null,
  musicInfo: LX.Player.PlayMusicInfo['musicInfo'] | LX.Party.PlaybackState['currentMusic'],
) => {
  const identity = createMusicIdentity(musicInfo)
  if (!room || !identity || !room.playback.queue.length) return -1
  return room.playback.queue.findIndex(item => createMusicIdentity(item.musicInfo) === identity)
}

const isSameMusic = (
  left: LX.Player.PlayMusicInfo['musicInfo'] | LX.Music.MusicInfo | null,
  right: LX.Music.MusicInfo | null,
) => {
  const current = normalizeMusicInfo(left)
  if (!current || !right) return current == right
  return current.id === right.id && current.source === right.source
}

const getRemoteProgress = (playback: LX.Party.PlaybackState) => {
  if (!playback.playing) return playback.progress
  return playback.progress + Math.max(0, Date.now() - playback.progressAt) * playback.rate
}

export default () => {
  let localSyncGuardUntil = 0
  let localMusicSwitchPlayUntil = 0
  let localMusicSwitchIdentity = ''
  let lastAppliedPlaybackKey = ''

  const guardLocalSync = () => {
    localSyncGuardUntil = Date.now() + LOCAL_SYNC_GUARD_MS
  }

  const markLocalMusicSwitchPlayIntent = () => {
    if (Date.now() < localSyncGuardUntil) return
    localMusicSwitchIdentity = createMusicIdentity(playMusicInfo.musicInfo)
    localMusicSwitchPlayUntil = Date.now() + LOCAL_MUSIC_SWITCH_PLAY_INTENT_MS
  }

  const clearLocalMusicSwitchPlayIntent = () => {
    localMusicSwitchPlayUntil = 0
    localMusicSwitchIdentity = ''
  }

  const hasLocalMusicSwitchPlayIntent = () => {
    return Date.now() < localMusicSwitchPlayUntil &&
      !!localMusicSwitchIdentity &&
      localMusicSwitchIdentity === createMusicIdentity(playMusicInfo.musicInfo)
  }

  const buildPlaybackPayload = (): LX.Party.PlaybackUpdateInput => {
    const musicInfo = normalizeMusicInfo(playMusicInfo.musicInfo)
    const currentIndex = getQueueCurrentIndex(party.room, playMusicInfo.musicInfo)
    return {
      currentMusic: musicInfo,
      currentIndex,
      playing: musicInfo ? isPlay.value || hasLocalMusicSwitchPlayIntent() : false,
      progress: Math.round(playProgress.nowPlayTime * 1000),
      progressAt: Date.now(),
      duration: playProgress.maxPlayTime ? Math.round(playProgress.maxPlayTime * 1000) : null,
      rate: playbackRate.value,
    }
  }

  const syncPlaybackNow = async(force = false) => {
    if (Date.now() < localSyncGuardUntil) return
    if (!party.room) return
    if (!force && !canControlPartyPlayback()) return
    try {
      await syncPartyPlayback(buildPlaybackPayload())
    } catch {}
  }

  const syncPlayback = debounce((force = false) => {
    void syncPlaybackNow(force)
  }, 260)

  const trySeedRoomPlayback = (room: LX.Party.RoomSnapshot | null) => {
    if (!room) return
    if (room.playback.currentMusic) return
    if (!normalizeMusicInfo(playMusicInfo.musicInfo)) return
    if (!canControlPartyPlayback(room)) return
    syncPlayback(true)
  }

  const applyRemotePlayback = (room: LX.Party.RoomSnapshot | null) => {
    if (!room?.playback.currentMusic) return
    if (room.playback.operator?.clientId && room.playback.operator.clientId === party.selfClientId) return

    const playbackKey = `${room.roomId}:${room.playback.version}`
    if (lastAppliedPlaybackKey === playbackKey) return
    lastAppliedPlaybackKey = playbackKey

    const remoteMusic = room.playback.currentMusic
    const remoteProgress = getRemoteProgress(room.playback) / 1000
    const remoteDuration = room.playback.duration == null ? undefined : room.playback.duration / 1000
    const remoteMusicIdentity = createMusicIdentity(remoteMusic)
    const shouldReplaceMusic =
      !isSameMusic(playMusicInfo.musicInfo, remoteMusic) ||
      getLoadedMusicIdentity() !== remoteMusicIdentity
    const shouldSeek =
      shouldReplaceMusic ||
      !isPlay.value ||
      !room.playback.playing ||
      Math.abs(playProgress.nowPlayTime - remoteProgress) > SEEK_DIFF_MAX_S

    guardLocalSync()

    if (shouldReplaceMusic) {
      playMusicByInfo(remoteMusic, {
        listId: null,
        isTempPlay: true,
        clearTempList: true,
        startTime: remoteProgress,
      })
    }

    window.app_event.setPlaybackRate(room.playback.rate)
    setTrackPlaybackRate(room.playback.rate)
    setLyricPlaybackRate(room.playback.rate)

    if (shouldSeek) {
      window.app_event.setProgress(remoteProgress, remoteDuration)
      setCurrentTime(remoteProgress)
    }

    if (!shouldReplaceMusic) {
      if (room.playback.playing) play()
      else if (isPlay.value) pause()
    }
  }

  const handlePartyState = (state: LX.Party.StatePayload, shouldApplyPlayback = true) => {
    setPartyState(state)
    if (!state.room) lastAppliedPlaybackKey = ''
    trySeedRoomPlayback(state.room)
    if (shouldApplyPlayback) applyRemotePlayback(state.room)
  }

  const removePartyAction = onPartyAction(({ params }) => {
    if (params.action !== 'state') return
    handlePartyState(params.data)
  })

  const handleSyncPlayback = () => {
    syncPlayback()
  }
  const handleMusicToggled = () => {
    markLocalMusicSwitchPlayIntent()
    syncPlayback()
  }
  const handlePlay = () => {
    clearLocalMusicSwitchPlayIntent()
    syncPlayback()
  }

  window.app_event.on('musicToggled', handleMusicToggled)
  window.app_event.on('play', handlePlay)
  window.app_event.on('pause', handleSyncPlayback)
  window.app_event.on('stop', handleSyncPlayback)
  window.app_event.on('setProgress', handleSyncPlayback)
  window.app_event.on('setPlaybackRate', handleSyncPlayback)

  onBeforeUnmount(() => {
    removePartyAction()
    window.app_event.off('musicToggled', handleMusicToggled)
    window.app_event.off('play', handlePlay)
    window.app_event.off('pause', handleSyncPlayback)
    window.app_event.off('stop', handleSyncPlayback)
    window.app_event.off('setProgress', handleSyncPlayback)
    window.app_event.off('setPlaybackRate', handleSyncPlayback)
  })

  return async() => {
    const state = await loadPartyState()
    handlePartyState(state)
  }
}
