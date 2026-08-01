import {
  isEmpty,
  playerResourceController,
  setPause,
  setPlay,
  type PlayerResourceController,
} from '@renderer/plugins/player'
import { isPlay, playedList, playInfo, playMusicInfo, tempPlayList, musicInfo as _musicInfo } from '@renderer/store/player/state'
import {
  getList,
  clearPlayedList,
  clearTempPlayeList,
  setPlayMusicInfo,
  addPlayedList,
  setMusicInfo,
  setAllStatus,
  removeTempPlayList,
  setPlayListId,
  removePlayedList,
} from '@renderer/store/player/action'
import { appSetting } from '@renderer/store/setting'
import { party } from '@renderer/store/party'
import { getPicPath, getLyricInfo } from '../music/index'
import { filterList } from './utils'
import { getRandom } from '@renderer/utils/index'
import { addListMusics, removeListMusics } from '@renderer/store/list/action'
import { loveList } from '@renderer/store/list/state'
import { addDislikeInfo } from '@renderer/core/dislikeList'
import { createPlaybackSourceError, isPlaybackSourceError } from '@common/utils/playbackSourceError'
import {
  getPlaybackSongIdentity,
  playbackResolutionCoordinator,
  type ForegroundCancelReason,
  type ForegroundPlaybackRequestInput,
  type PlaybackResolutionCoordinator,
  type PlaybackResource,
} from '@renderer/core/music/playback'

export interface SetMusicUrlOptions {
  reason?: ForegroundPlaybackRequestInput['reason']
  startTime?: number
  shouldPlay?: boolean
}

interface PlayMusicByInfoOptions extends SetMusicUrlOptions {
  listId?: string | null
  isTempPlay?: boolean
  clearTempList?: boolean
}

const createMusicIdentity = (musicInfo: LX.Player.PlayMusicInfo['musicInfo'] | LX.Music.MusicInfo | null) => {
  if (!musicInfo) return ''
  const targetMusicInfo = 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
  return `${targetMusicInfo.source}:${targetMusicInfo.id}`
}

const isSameMusicIdentity = (
  left: LX.Player.PlayMusicInfo['musicInfo'] | LX.Music.MusicInfo | LX.Download.ListItem | null | undefined,
  right: LX.Player.PlayMusicInfo['musicInfo'] | LX.Music.MusicInfo | LX.Download.ListItem | null | undefined,
) => createMusicIdentity(left ?? null) === createMusicIdentity(right ?? null)

const normalizeSetMusicUrlOptions = (
  options: SetMusicUrlOptions = {},
): Required<SetMusicUrlOptions> => ({
  reason: options.reason ?? 'initial',
  startTime: options.startTime ?? 0,
  shouldPlay: options.shouldPlay ?? true,
})

const normalizePlayMusicByInfoOptions = (options?: PlayMusicByInfoOptions): Required<PlayMusicByInfoOptions> => {
  return {
    reason: options?.reason ?? 'initial',
    startTime: options?.startTime ?? 0,
    shouldPlay: options?.shouldPlay ?? true,
    listId: options?.listId ?? null,
    isTempPlay: options?.isTempPlay ?? true,
    clearTempList: options?.clearTempList ?? true,
  }
}

const createDelayNextTimeout = (delay: number) => {
  let timeout: NodeJS.Timeout | null
  const clearDelayNextTimeout = () => {
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
  }

  const addDelayNextTimeout = () => {
    clearDelayNextTimeout()
    timeout = setTimeout(() => {
      timeout = null
      if (window.lx.isPlayedStop) return
      console.warn('delay next timeout timeout', delay)
      void playNext(true)
    }, delay)
  }

  return {
    clearDelayNextTimeout,
    addDelayNextTimeout,
  }
}

const { addDelayNextTimeout, clearDelayNextTimeout } = createDelayNextTimeout(5000)
const { clearDelayNextTimeout: clearLoadTimeout } = createDelayNextTimeout(100000)

const getPartyQueueCurrentIndex = () => {
  const room = party.room
  if (!room?.playback.queue.length) return -1
  const currentIdentity = createMusicIdentity(playMusicInfo.musicInfo)
  if (!currentIdentity) return room.playback.currentIndex
  const currentIndex = room.playback.queue.findIndex(item => createMusicIdentity(item.musicInfo) === currentIdentity)
  return currentIndex > -1 ? currentIndex : room.playback.currentIndex
}

const getPartyQueuePlayMusicInfo = (offset: number): LX.Player.PlayMusicInfo | null => {
  const room = party.room
  if (!room?.playback.queue.length) return null

  const currentIndex = getPartyQueueCurrentIndex()
  let nextIndex = currentIndex
  if (currentIndex < 0) {
    if (offset < 0) return null
    nextIndex = 0
  } else {
    nextIndex += offset
  }
  if (nextIndex < 0 || nextIndex >= room.playback.queue.length) return null

  return {
    listId: null,
    musicInfo: room.playback.queue[nextIndex].musicInfo,
    isTempPlay: true,
  }
}

export interface PlaybackActionController {
  setMusicUrl: (
    info: LX.Music.MusicInfo | LX.Download.ListItem,
    options?: SetMusicUrlOptions,
  ) => Promise<void>
  setLoadedMusicIdentity: (identity: string) => void
  getLoadedMusicIdentity: () => string
  cancel: (reason: ForegroundCancelReason) => void
  dispose: () => void
}

export type CreatePlaybackActionController = (deps: {
  coordinator: PlaybackResolutionCoordinator
  resource: PlayerResourceController
  getCurrentMusicInfo: () => LX.Player.PlayMusicInfo['musicInfo'] | null
  isPlayedStop: () => boolean
  autoSkipOnError: () => boolean
  setAllStatus: (value: string) => void
  emitVisibleError: () => void
  scheduleAutoSkip: () => void
  clearLoadTimeout: () => void
}) => PlaybackActionController

export const createPlaybackActionController: CreatePlaybackActionController = deps => {
  interface ActiveForegroundBinding {
    token: number
    songIdentity: string
    options: Required<SetMusicUrlOptions>
    terminalFailureEmitted: boolean
  }
  let nextToken = 0
  let active: ActiveForegroundBinding | null = null
  let loadedMusicIdentity = ''

  const isCurrent = (binding: ActiveForegroundBinding) => {
    const current = deps.getCurrentMusicInfo()
    return active === binding && !deps.isPlayedStop() && current != null &&
      getPlaybackSongIdentity(current) == binding.songIdentity
  }
  const bind = (binding: ActiveForegroundBinding, resource: PlaybackResource) => {
    if (!isCurrent(binding) || resource.songIdentity != binding.songIdentity) return
    deps.resource.setResource(resource.url, {
      startTime: binding.options.startTime,
      shouldPlay: binding.options.shouldPlay,
      resource,
    })
  }
  const fail = (binding: ActiveForegroundBinding, error: LX.Playback.SourceError) => {
    if (!isCurrent(binding) || binding.terminalFailureEmitted ||
        (error.scope == 'session' && error.kind == 'cancelled')) return
    binding.terminalFailureEmitted = true
    deps.clearLoadTimeout()
    deps.setAllStatus(error.message)
    deps.emitVisibleError()
    if (deps.autoSkipOnError()) deps.scheduleAutoSkip()
  }
  const clearActiveResource = () => {
    active = null
    loadedMusicIdentity = ''
    deps.resource.setStop()
  }
  const cancelInternal = (reason: ForegroundCancelReason) => {
    clearActiveResource()
    deps.coordinator.cancelForeground(reason)
  }

  deps.coordinator.setForegroundHandlers({
    resource(resource) {
      const binding = active
      if (binding) bind(binding, resource)
    },
    failure({ songIdentity, error }) {
      const binding = active
      if (binding?.songIdentity == songIdentity) fail(binding, error)
    },
  })

  return {
    async setMusicUrl(info, options = {}) {
      const normalized = normalizeSetMusicUrlOptions(options)
      const binding: ActiveForegroundBinding = {
        token: ++nextToken,
        songIdentity: getPlaybackSongIdentity(info),
        options: normalized,
        terminalFailureEmitted: false,
      }
      active = binding
      loadedMusicIdentity = ''
      deps.resource.setStop()
      try {
        const resource = await deps.coordinator.startForeground({
          musicInfo: info,
          reason: normalized.reason,
        })
        bind(binding, resource)
      } catch (error) {
        fail(binding, isPlaybackSourceError(error) ? error : createPlaybackSourceError({
          message: error instanceof Error ? error.message : 'Playback resolution failed',
          scope: 'candidate',
          kind: 'request',
          cause: error,
        }))
      }
    },
    setLoadedMusicIdentity(identity) { loadedMusicIdentity = identity },
    getLoadedMusicIdentity: () => loadedMusicIdentity,
    cancel(reason) { cancelInternal(reason) },
    dispose() {
      clearActiveResource()
      deps.coordinator.dispose()
    },
  }
}

let actionControllerInstance: PlaybackActionController | null = null

const requireActionController = (): PlaybackActionController => {
  if (!actionControllerInstance) throw new Error('Playback action controller is not initialized')
  return actionControllerInstance
}

export const initializePlaybackActionController = (): PlaybackActionController => {
  actionControllerInstance ??= createPlaybackActionController({
    coordinator: playbackResolutionCoordinator,
    resource: playerResourceController,
    getCurrentMusicInfo: () => playMusicInfo.musicInfo,
    isPlayedStop: () => window.lx.isPlayedStop,
    autoSkipOnError: () => appSetting['player.autoSkipOnError'],
    setAllStatus,
    emitVisibleError: () => window.app_event.error(),
    scheduleAutoSkip: addDelayNextTimeout,
    clearLoadTimeout,
  })
  return actionControllerInstance
}

export const disposePlaybackActionController = () => {
  actionControllerInstance?.dispose()
  actionControllerInstance = null
}

export const setMusicUrl: PlaybackActionController['setMusicUrl'] = async(...args) => (
  requireActionController().setMusicUrl(...args)
)
export const setLoadedMusicIdentity = (identity: string) => { requireActionController().setLoadedMusicIdentity(identity) }
export const getLoadedMusicIdentity = () => requireActionController().getLoadedMusicIdentity()

const loadMusicMeta = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, listId: string | null) => {
  void getPicPath({ musicInfo, listId }).then((url: string) => {
    if (!isSameMusicIdentity(musicInfo, playMusicInfo.musicInfo) || url == _musicInfo.pic) return
    setMusicInfo({ pic: url })
    window.app_event.picUpdated()
  }).catch(_ => _)

  void getLyricInfo({ musicInfo }).then(lyricInfo => {
    if (!isSameMusicIdentity(musicInfo, playMusicInfo.musicInfo)) return
    setMusicInfo({
      lrc: lyricInfo.lyric,
      tlrc: lyricInfo.tlyric,
      lxlrc: lyricInfo.lxlyric,
      rlrc: lyricInfo.rlyric,
      rawlrc: lyricInfo.rawlrcInfo.lyric,
    })
    window.app_event.lyricUpdated()
  }).catch(err => {
    console.log(err)
    if (!isSameMusicIdentity(musicInfo, playMusicInfo.musicInfo)) return
    setAllStatus(window.i18n.t('lyric__load_error'))
  })
}

const handleRestorePlay = async(restorePlayInfo: LX.Player.SavedPlayInfo) => {
  const currentMusicInfo = playMusicInfo.musicInfo
  if (!currentMusicInfo) return

  setImmediate(() => {
    if (!isSameMusicIdentity(currentMusicInfo, playMusicInfo.musicInfo)) return
    window.app_event.setProgress(appSetting['player.isSavePlayTime'] ? restorePlayInfo.time : 0, restorePlayInfo.maxTime)
    window.app_event.pause()
  })

  loadMusicMeta(currentMusicInfo, playMusicInfo.listId)

  if (appSetting['player.togglePlayMethod'] == 'random' && !playMusicInfo.isTempPlay) {
    addPlayedList({ ...playMusicInfo as LX.Player.PlayMusicInfo })
  }
}

const handlePlay = (options?: SetMusicUrlOptions) => {
  window.lx.isPlayedStop &&= false

  resetRandomNextMusicInfo()
  if (window.lx.restorePlayInfo) {
    void handleRestorePlay(window.lx.restorePlayInfo)
    window.lx.restorePlayInfo = null
    return
  }

  const currentMusicInfo = playMusicInfo.musicInfo
  if (!currentMusicInfo) return

  window.app_event.pause()
  clearDelayNextTimeout()
  clearLoadTimeout()

  if (appSetting['player.togglePlayMethod'] == 'random' && !playMusicInfo.isTempPlay) {
    addPlayedList({ ...(playMusicInfo as LX.Player.PlayMusicInfo) })
  }

  void setMusicUrl(currentMusicInfo, options)
  loadMusicMeta(currentMusicInfo, playMusicInfo.listId)
}

export const playListById = (listId: string, id: string) => {
  const prevListId = playInfo.playerListId
  setPlayListId(listId)
  const currentMusicInfo = getList(listId).find(m => m.id == id)
  if (!currentMusicInfo) return
  setPlayMusicInfo(listId, currentMusicInfo)
  if (appSetting['player.isAutoCleanPlayedList'] || prevListId != listId) clearPlayedList()
  clearTempPlayeList()
  handlePlay()
}

export const playList = (listId: string, index: number) => {
  const prevListId = playInfo.playerListId
  setPlayListId(listId)
  setPlayMusicInfo(listId, getList(listId)[index])
  if (appSetting['player.isAutoCleanPlayedList'] || prevListId != listId) clearPlayedList()
  clearTempPlayeList()
  handlePlay()
}

export const playMusicByInfo = (musicInfo: LX.Music.MusicInfo, options?: PlayMusicByInfoOptions) => {
  const normalizedOptions = normalizePlayMusicByInfoOptions(options)
  if (normalizedOptions.listId != null || !normalizedOptions.isTempPlay) {
    setPlayListId(normalizedOptions.listId)
  }
  setPlayMusicInfo(normalizedOptions.listId, musicInfo, normalizedOptions.isTempPlay)
  if (normalizedOptions.clearTempList) clearTempPlayeList()
  handlePlay({
    reason: normalizedOptions.reason,
    startTime: normalizedOptions.startTime,
    shouldPlay: normalizedOptions.shouldPlay,
  })
}

const handleToggleStop = () => {
  stop()
  setTimeout(() => {
    setPlayMusicInfo(null, null)
  })
}

const randomNextMusicInfo = {
  info: null as LX.Player.PlayMusicInfo | null,
}

export const resetRandomNextMusicInfo = () => {
  if (randomNextMusicInfo.info) randomNextMusicInfo.info = null
}

export const getNextPlayMusicInfo = async(): Promise<LX.Player.PlayMusicInfo | null> => {
  const partyQueuePlayMusicInfo = getPartyQueuePlayMusicInfo(1)
  if (partyQueuePlayMusicInfo) return partyQueuePlayMusicInfo

  if (tempPlayList.length) return tempPlayList[0]
  if (playMusicInfo.musicInfo == null) return null
  if (randomNextMusicInfo.info) return randomNextMusicInfo.info

  const currentListId = playInfo.playerListId
  if (!currentListId) return null
  const currentList = getList(currentListId)

  if (playedList.length) {
    let currentId: string
    if (playMusicInfo.isTempPlay) {
      const currentMusicInfo = currentList[playInfo.playerPlayIndex]
      if (currentMusicInfo) currentId = currentMusicInfo.id
    } else {
      currentId = playMusicInfo.musicInfo.id
    }

    let index
    for (index = playedList.findIndex(m => m.musicInfo.id === currentId) + 1; index < playedList.length; index++) {
      const currentPlayMusicInfo = playedList[index]
      const playedMusicId = currentPlayMusicInfo.musicInfo.id
      if (currentPlayMusicInfo.listId == currentListId && !currentList.some(m => m.id === playedMusicId)) {
        removePlayedList(index)
        continue
      }
      break
    }

    if (index < playedList.length) return playedList[index]
  }

  let { filteredList, playerIndex } = await filterList({
    listId: currentListId,
    list: currentList,
    playedList,
    playerMusicInfo: currentList[playInfo.playerPlayIndex],
    isNext: true,
  })

  if (!filteredList.length) return null
  if (playerIndex == -1 && filteredList.length) playerIndex = 0
  let nextIndex = playerIndex

  const togglePlayMethod = appSetting['player.togglePlayMethod']
  switch (togglePlayMethod) {
    case 'listLoop':
      nextIndex = playerIndex === filteredList.length - 1 ? 0 : playerIndex + 1
      break
    case 'random':
      nextIndex = getRandom(0, filteredList.length)
      break
    case 'list':
      nextIndex = playerIndex === filteredList.length - 1 ? -1 : playerIndex + 1
      break
    case 'singleLoop':
      break
    default:
      return null
  }
  if (nextIndex < 0) return null

  const nextPlayMusicInfo = {
    musicInfo: filteredList[nextIndex],
    listId: currentListId,
    isTempPlay: false,
  }

  if (togglePlayMethod == 'random') randomNextMusicInfo.info = nextPlayMusicInfo
  return nextPlayMusicInfo
}

const handlePlayNext = (nextPlayMusicInfo: LX.Player.PlayMusicInfo) => {
  setPlayMusicInfo(nextPlayMusicInfo.listId, nextPlayMusicInfo.musicInfo, nextPlayMusicInfo.isTempPlay)
  handlePlay()
}

export const playNext = async(isAutoToggle = false): Promise<void> => {
  const partyQueuePlayMusicInfo = getPartyQueuePlayMusicInfo(1)
  if (partyQueuePlayMusicInfo) {
    handlePlayNext(partyQueuePlayMusicInfo)
    return
  }

  if (tempPlayList.length) {
    const currentPlayMusicInfo = tempPlayList[0]
    removeTempPlayList(0)
    handlePlayNext(currentPlayMusicInfo)
    return
  }

  if (playMusicInfo.musicInfo == null) {
    handleToggleStop()
    return
  }

  const currentListId = playInfo.playerListId
  if (!currentListId) {
    handleToggleStop()
    return
  }
  const currentList = getList(currentListId)

  if (playedList.length) {
    let currentId: string
    if (playMusicInfo.isTempPlay) {
      const currentMusicInfo = currentList[playInfo.playerPlayIndex]
      if (currentMusicInfo) currentId = currentMusicInfo.id
    } else {
      currentId = playMusicInfo.musicInfo.id
    }

    let index
    for (index = playedList.findIndex(m => m.musicInfo.id === currentId) + 1; index < playedList.length; index++) {
      const currentPlayMusicInfo = playedList[index]
      const playedMusicId = currentPlayMusicInfo.musicInfo.id
      if (currentPlayMusicInfo.listId == currentListId && !currentList.some(m => m.id === playedMusicId)) {
        removePlayedList(index)
        continue
      }
      break
    }

    if (index < playedList.length) {
      handlePlayNext(playedList[index])
      return
    }
  }

  if (randomNextMusicInfo.info) {
    handlePlayNext(randomNextMusicInfo.info)
    return
  }

  let { filteredList, playerIndex } = await filterList({
    listId: currentListId,
    list: currentList,
    playedList,
    playerMusicInfo: currentList[playInfo.playerPlayIndex],
    isNext: true,
  })

  if (!filteredList.length) {
    handleToggleStop()
    return
  }
  if (playerIndex == -1 && filteredList.length) playerIndex = 0
  let nextIndex = playerIndex

  let togglePlayMethod = appSetting['player.togglePlayMethod']
  if (!isAutoToggle) {
    switch (togglePlayMethod) {
      case 'list':
      case 'singleLoop':
      case 'none':
        togglePlayMethod = 'listLoop'
    }
  }
  switch (togglePlayMethod) {
    case 'listLoop':
      nextIndex = playerIndex === filteredList.length - 1 ? 0 : playerIndex + 1
      break
    case 'random':
      nextIndex = getRandom(0, filteredList.length)
      break
    case 'list':
      nextIndex = playerIndex === filteredList.length - 1 ? -1 : playerIndex + 1
      break
    case 'singleLoop':
      break
    default:
      return
  }
  if (nextIndex < 0) return

  handlePlayNext({
    musicInfo: filteredList[nextIndex],
    listId: currentListId,
    isTempPlay: false,
  })
}

export const playPrev = async(isAutoToggle = false): Promise<void> => {
  const partyQueuePlayMusicInfo = getPartyQueuePlayMusicInfo(-1)
  if (partyQueuePlayMusicInfo) {
    handlePlayNext(partyQueuePlayMusicInfo)
    return
  }

  if (playMusicInfo.musicInfo == null) {
    handleToggleStop()
    return
  }

  const currentListId = playInfo.playerListId
  if (!currentListId) {
    handleToggleStop()
    return
  }
  const currentList = getList(currentListId)

  if (playedList.length) {
    let currentId: string
    if (playMusicInfo.isTempPlay) {
      const currentMusicInfo = currentList[playInfo.playerPlayIndex]
      if (currentMusicInfo) currentId = currentMusicInfo.id
    } else {
      currentId = playMusicInfo.musicInfo.id
    }

    let index
    for (index = playedList.findIndex(m => m.musicInfo.id === currentId) - 1; index > -1; index--) {
      const currentPlayMusicInfo = playedList[index]
      const playedMusicId = currentPlayMusicInfo.musicInfo.id
      if (currentPlayMusicInfo.listId == currentListId && !currentList.some(m => m.id === playedMusicId)) {
        removePlayedList(index)
        continue
      }
      break
    }

    if (index > -1) {
      handlePlayNext(playedList[index])
      return
    }
  }

  let { filteredList, playerIndex } = await filterList({
    listId: currentListId,
    list: currentList,
    playedList,
    playerMusicInfo: currentList[playInfo.playerPlayIndex],
    isNext: false,
  })
  if (!filteredList.length) {
    handleToggleStop()
    return
  }

  if (playerIndex == -1 && filteredList.length) playerIndex = 0
  let nextIndex = playerIndex
  if (!playMusicInfo.isTempPlay) {
    let togglePlayMethod = appSetting['player.togglePlayMethod']
    if (!isAutoToggle) {
      switch (togglePlayMethod) {
        case 'list':
        case 'singleLoop':
        case 'none':
          togglePlayMethod = 'listLoop'
      }
    }
    switch (togglePlayMethod) {
      case 'random':
        nextIndex = getRandom(0, filteredList.length)
        break
      case 'listLoop':
      case 'list':
        nextIndex = playerIndex === 0 ? filteredList.length - 1 : playerIndex - 1
        break
      case 'singleLoop':
        break
      default:
        return
    }
    if (nextIndex < 0) return
  }

  handlePlayNext({
    musicInfo: filteredList[nextIndex],
    listId: currentListId,
    isTempPlay: false,
  })
}

export const play = () => {
  window.lx.isPlayedStop &&= false
  if (playMusicInfo.musicInfo == null) return
  if (isEmpty()) {
    void setMusicUrl(playMusicInfo.musicInfo)
    return
  }
  setPlay()
}

export const pause = () => {
  setPause()
}

export const stop = () => {
  requireActionController().cancel('stop')
  setTimeout(() => {
    window.app_event.stop()
  })
}

export const togglePlay = () => {
  window.lx.isPlayedStop &&= false
  if (isPlay.value) pause()
  else play()
}

export const collectMusic = () => {
  if (!playMusicInfo.musicInfo) return
  void addListMusics(loveList.id, ['progress' in playMusicInfo.musicInfo ? playMusicInfo.musicInfo.metadata.musicInfo : playMusicInfo.musicInfo])
}

export const uncollectMusic = () => {
  if (!playMusicInfo.musicInfo) return
  if (playMusicInfo.listId == loveList.id) playMusicInfo.isTempPlay = true
  void removeListMusics({ listId: loveList.id, ids: ['progress' in playMusicInfo.musicInfo ? playMusicInfo.musicInfo.metadata.musicInfo.id : playMusicInfo.musicInfo.id] })
}

export const dislikeMusic = async() => {
  if (!playMusicInfo.musicInfo) return
  const currentMusicInfo = 'progress' in playMusicInfo.musicInfo ? playMusicInfo.musicInfo.metadata.musicInfo : playMusicInfo.musicInfo
  await addDislikeInfo([{ name: currentMusicInfo.name, singer: currentMusicInfo.singer }])
  await playNext(true)
}
