import type { PlaybackResumeV1 } from '@common/storage/playback'
import { getPlaybackResume } from '@renderer/utils/playback'
import music from '@renderer/utils/musicSdk'
import { log } from '@common/utils'
import { getListMusics, getUserLists, refreshWebDAVList, registerAction } from '@renderer/store/list/action'


import useInitUserApi from './useInitUserApi'
import { play, playList } from '@renderer/core/player'
import { onBeforeUnmount } from '@common/utils/vueTools'
import { appSetting } from '@renderer/store/setting'
import { playMusicInfo } from '@renderer/store/player/state'
import { initDislikeInfo, registerRemoteDislikeAction } from '@renderer/core/dislikeList'
import { initializeUserListGroups } from '@renderer/store/list/group'

const getMusicIdentity = (music: LX.Music.MusicInfo | LX.Download.ListItem) => {
  const musicInfo = 'progress' in music ? music.metadata.musicInfo : music
  return { source: musicInfo.source, sourceTrackId: musicInfo.id }
}

export const resolvePlaybackResume = (
  resume: PlaybackResumeV1,
  list: Array<LX.Music.MusicInfo | LX.Download.ListItem>,
): LX.Player.SavedPlayInfo | null => {
  if (resume.listId == null) return null
  const matches = (music: LX.Music.MusicInfo | LX.Download.ListItem | undefined) => {
    if (music == null) return false
    const identity = getMusicIdentity(music)
    return identity.source == resume.source && identity.sourceTrackId == resume.sourceTrackId
  }
  const index = resume.indexHint != null && matches(list[resume.indexHint])
    ? resume.indexHint
    : list.findIndex(matches)
  if (index < 0) return null
  return {
    listId: resume.listId,
    index,
    time: resume.positionMs / 1000,
    maxTime: (resume.durationMs ?? 0) / 1000,
  }
}

const initPrevPlayInfo = async() => {
  const resume = await getPlaybackResume()
  window.lx.restorePlayInfo = null
  if (resume?.listId == null) return
  const list = await getListMusics(resume.listId)
  const info = resolvePlaybackResume(resume, list)
  if (info == null) return
  window.lx.restorePlayInfo = info
  playList(info.listId, info.index, {
    automatic: false,
    reason: 'select',
    startReason: 'restore',
    startPositionMs: info.time * 1000,
  })

  if (appSetting['player.startupAutoPlay']) {
    const musicInfo = playMusicInfo.musicInfo
    if (!musicInfo) return
    setTimeout(() => {
      if (musicInfo.id == playMusicInfo.musicInfo?.id) play()
    })
  }
}

export default () => {
  const initUserApi = useInitUserApi()

  let unregister: null | (() => void) = null
  let unregisterDislikeEvent: null | (() => void) = null

  onBeforeUnmount(() => {
    if (unregister) unregister()
    if (unregisterDislikeEvent) unregisterDislikeEvent()
  })

  return async() => {
    await Promise.all([
      initUserApi(), // 自定义API
    ]).catch(err => {
      log.error(err)
    })
    void music.init() // 初始化音乐sdk
    unregister = registerAction((ids) => {
      window.app_event.myListUpdate(ids)
    })
    window.lxData.userLists = await getUserLists() // 获取用户列表
    await initializeUserListGroups(window.lxData.userLists)
    if (appSetting['webdav.autoRefresh']) {
      void refreshWebDAVList().catch(err => {
        log.error(err)
      })
    }
    unregisterDislikeEvent = registerRemoteDislikeAction()
    await initDislikeInfo() // 获取不喜欢列表
    await initPrevPlayInfo().catch(err => {
      log.error(err)
    }) // 初始化上次的歌曲播放信息
  }
}
