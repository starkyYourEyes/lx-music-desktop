import { isEmpty, setPause, setPlay, setResource, setStop } from '@renderer/plugins/player'
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
import { getMusicUrl, getPicPath, getLyricInfo } from '../music/index'
import { filterList } from './utils'
import { requestMsg } from '@renderer/utils/message'
import { getRandom, toNewMusicInfo } from '@renderer/utils/index'
import { addListMusics, removeListMusics } from '@renderer/store/list/action'
import { loveList } from '@renderer/store/list/state'
import { addDislikeInfo } from '@renderer/core/dislikeList'
import musicSdk from '@renderer/utils/musicSdk'

interface SetMusicUrlOptions {
  isRefresh?: boolean
  startTime?: number
  shouldPlay?: boolean
}

interface PlayMusicByInfoOptions extends SetMusicUrlOptions {
  listId?: string | null
  isTempPlay?: boolean
  clearTempList?: boolean
}

let gettingUrlId = ''
let loadedMusicIdentity = ''

const createGettingUrlId = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem) => {
  const targetMusicInfo = 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
  const tInfo = targetMusicInfo.meta.toggleMusicInfo
  return `${targetMusicInfo.source}:${targetMusicInfo.id}_${tInfo?.source ?? ''}:${tInfo?.id ?? ''}`
}

const createMusicIdentity = (musicInfo: LX.Player.PlayMusicInfo['musicInfo'] | LX.Music.MusicInfo | null) => {
  if (!musicInfo) return ''
  const targetMusicInfo = 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
  return `${targetMusicInfo.source}:${targetMusicInfo.id}`
}

const getSourceMusicInfo = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem) => {
  return 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
}

const isSameMusicIdentity = (
  left: LX.Player.PlayMusicInfo['musicInfo'] | LX.Music.MusicInfo | LX.Download.ListItem | null | undefined,
  right: LX.Player.PlayMusicInfo['musicInfo'] | LX.Music.MusicInfo | LX.Download.ListItem | null | undefined,
) => createMusicIdentity(left ?? null) === createMusicIdentity(right ?? null)

const normalizeSetMusicUrlOptions = (options?: boolean | SetMusicUrlOptions): Required<SetMusicUrlOptions> => {
  if (typeof options === 'boolean') {
    return {
      isRefresh: options,
      startTime: 0,
      shouldPlay: true,
    }
  }
  return {
    isRefresh: options?.isRefresh ?? false,
    startTime: options?.startTime ?? 0,
    shouldPlay: options?.shouldPlay ?? true,
  }
}

const normalizePlayMusicByInfoOptions = (options?: PlayMusicByInfoOptions): Required<PlayMusicByInfoOptions> => {
  return {
    isRefresh: options?.isRefresh ?? false,
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
const { addDelayNextTimeout: addLoadTimeout, clearDelayNextTimeout: clearLoadTimeout } = createDelayNextTimeout(100000)

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

const diffCurrentMusicInfo = (curMusicInfo: LX.Music.MusicInfo | LX.Download.ListItem): boolean => {
  return gettingUrlId != createGettingUrlId(curMusicInfo) || !isSameMusicIdentity(curMusicInfo, playMusicInfo.musicInfo) || isPlay.value
}

const getIntervalSeconds = (interval: string | null | undefined): number => {
  if (!interval) return 0
  return interval.split(':').reduce((total, part) => {
    const value = Number.parseInt(part)
    return total * 60 + (Number.isNaN(value) ? 0 : value)
  }, 0)
}

const normalizeSearchText = (text: string | null | undefined): string => {
  return String(text ?? '').toLowerCase().replace(/\s|\.|,|'|"|\(|\)|\[|\]|-|_/g, '')
}

const findBestWySearchMusic = async(musicInfo: LX.Music.MusicInfo): Promise<LX.Music.MusicInfoOnline | null> => {
  if (musicInfo.source != 'wy') return null

  const keyword = `${musicInfo.name} ${musicInfo.singer || ''}`.trim()
  if (!keyword) return null

  setAllStatus(window.i18n.t('toggle_source_try'))
  const result = await musicSdk.wy.musicSearch.search(keyword, 1, 20).catch(() => null)
  const list = (result?.list ?? []).map((item: any) => toNewMusicInfo(item) as LX.Music.MusicInfoOnline)
  if (!list.length || window.lx.isPlayedStop || !isSameMusicIdentity(musicInfo, playMusicInfo.musicInfo)) return null

  const targetName = normalizeSearchText(musicInfo.name)
  const targetSinger = normalizeSearchText(musicInfo.singer)
  const targetInterval = getIntervalSeconds(musicInfo.interval)
  const isSameInterval = (interval: string | null) => {
    const currentInterval = getIntervalSeconds(interval)
    return !targetInterval || !currentInterval || Math.abs(targetInterval - currentInterval) < 5
  }
  const isSameSinger = (singer: string) => {
    const currentSinger = normalizeSearchText(singer)
    return !targetSinger || currentSinger.includes(targetSinger) || targetSinger.includes(currentSinger)
  }

  const playableSong = list.find((item: LX.Music.MusicInfoOnline) => normalizeSearchText(item.name) == targetName && isSameSinger(item.singer) && isSameInterval(item.interval)) ??
    list.find((item: LX.Music.MusicInfoOnline) => normalizeSearchText(item.name) == targetName && isSameSinger(item.singer)) ??
    list.find((item: LX.Music.MusicInfoOnline) => normalizeSearchText(item.name).includes(targetName) && isSameSinger(item.singer)) ??
    list[0]

  musicInfo.meta.toggleMusicInfo = playableSong
  gettingUrlId = createGettingUrlId(musicInfo)
  return playableSong
}

const getPlayableMusicUrl = async(options: Parameters<typeof getMusicUrl>[0]): Promise<string> => {
  const url = await getMusicUrl(options)
  if (!url) throw new Error(window.i18n.t('toggle_source_failed'))
  return url
}

const getDirectMusicUrl = async(musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, isRefresh: boolean): Promise<string> => {
  const targetMusicInfo = getSourceMusicInfo(musicInfo)
  const toggleMusicInfo = targetMusicInfo.meta.toggleMusicInfo

  if (toggleMusicInfo) {
    try {
      return await getPlayableMusicUrl({
        musicInfo: toggleMusicInfo,
        isRefresh,
        allowToggleSource: false,
      })
    } catch (err) {
      console.log(err)
      targetMusicInfo.meta.toggleMusicInfo = null
      gettingUrlId = createGettingUrlId(musicInfo)
    }
  }

  try {
    return await getPlayableMusicUrl({
      musicInfo,
      isRefresh,
      allowToggleSource: targetMusicInfo.source != 'wy',
      onToggleSource() {
        if (diffCurrentMusicInfo(musicInfo)) return
        setAllStatus(window.i18n.t('toggle_source_try'))
      },
    })
  } catch (err: any) {
    if (targetMusicInfo.source != 'wy' || err.message == requestMsg.tooManyRequests) throw err
  }

  const wySearchMusic = await findBestWySearchMusic(targetMusicInfo)
  if (wySearchMusic) {
    try {
      return await getPlayableMusicUrl({
        musicInfo: wySearchMusic,
        isRefresh,
        allowToggleSource: false,
      })
    } catch (err: any) {
      if (err.message == requestMsg.tooManyRequests) throw err
      console.log(err)
    }
  }

  return getPlayableMusicUrl({
    musicInfo,
    isRefresh,
    onToggleSource() {
      if (diffCurrentMusicInfo(musicInfo)) return
      setAllStatus(window.i18n.t('toggle_source_try'))
    },
  })
}

let cancelDelayRetry: (() => void) | null = null
const delayRetry = async(musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, isRefresh = false): Promise<string | null> => {
  return new Promise<string | null>((resolve, reject) => {
    const time = getRandom(2, 6)
    setAllStatus(window.i18n.t('player__getting_url_delay_retry', { time }))
    const timeout = setTimeout(() => {
      getMusicPlayUrl(musicInfo, isRefresh, true).then(result => {
        cancelDelayRetry = null
        resolve(result)
      }).catch((err: any) => {
        cancelDelayRetry = null
        reject(err)
      })
    }, time * 1000)
    cancelDelayRetry = () => {
      clearTimeout(timeout)
      cancelDelayRetry = null
      resolve(null)
    }
  })
}

const getMusicPlayUrl = async(musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, isRefresh = false, isRetryed = false): Promise<string | null> => {
  setAllStatus(window.i18n.t('player__getting_url'))
  if (appSetting['player.autoSkipOnError']) addLoadTimeout()

  return getDirectMusicUrl(musicInfo, isRefresh).then(url => {
    if (window.lx.isPlayedStop || diffCurrentMusicInfo(musicInfo)) return null
    return url
  }).catch(async err => {
    if (
      window.lx.isPlayedStop ||
      diffCurrentMusicInfo(musicInfo) ||
      err.message == requestMsg.cancelRequest
    ) return null

    if (err.message == requestMsg.tooManyRequests) return delayRetry(musicInfo, isRefresh)
    if (!isRetryed) return getMusicPlayUrl(musicInfo, isRefresh, true)
    throw err
  })
}

export const getLoadedMusicIdentity = () => loadedMusicIdentity

export const setMusicUrl = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, options?: boolean | SetMusicUrlOptions) => {
  if (!diffCurrentMusicInfo(musicInfo)) return

  const normalizedOptions = normalizeSetMusicUrlOptions(options)
  if (cancelDelayRetry) cancelDelayRetry()
  gettingUrlId = createGettingUrlId(musicInfo)

  void getMusicPlayUrl(musicInfo, normalizedOptions.isRefresh).then(url => {
    if (!url) return
    loadedMusicIdentity = createMusicIdentity(musicInfo)
    setResource(url, {
      startTime: normalizedOptions.startTime,
      shouldPlay: normalizedOptions.shouldPlay,
    })
  }).catch((err: any) => {
    console.log(err)
    setAllStatus(err.message)
    window.app_event.error()
    if (appSetting['player.autoSkipOnError']) addDelayNextTimeout()
  }).finally(() => {
    if (musicInfo === playMusicInfo.musicInfo) {
      gettingUrlId = ''
      clearLoadTimeout()
    }
  })
}

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

const handlePlay = (options?: boolean | SetMusicUrlOptions) => {
  window.lx.isPlayedStop &&= false

  resetRandomNextMusicInfo()
  if (window.lx.restorePlayInfo) {
    void handleRestorePlay(window.lx.restorePlayInfo)
    window.lx.restorePlayInfo = null
    return
  }

  const currentMusicInfo = playMusicInfo.musicInfo
  if (!currentMusicInfo) return

  setStop()
  window.app_event.pause()
  clearDelayNextTimeout()
  clearLoadTimeout()

  if (appSetting['player.togglePlayMethod'] == 'random' && !playMusicInfo.isTempPlay) {
    addPlayedList({ ...(playMusicInfo as LX.Player.PlayMusicInfo) })
  }

  setMusicUrl(currentMusicInfo, options)
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
    isRefresh: normalizedOptions.isRefresh,
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
    if (createGettingUrlId(playMusicInfo.musicInfo) != gettingUrlId) setMusicUrl(playMusicInfo.musicInfo)
    return
  }
  setPlay()
}

export const pause = () => {
  setPause()
}

export const stop = () => {
  loadedMusicIdentity = ''
  setStop()
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
