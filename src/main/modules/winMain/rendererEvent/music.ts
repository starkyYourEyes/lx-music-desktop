import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import {
  parseMusicUrlGetInput,
  parseMusicUrlPutInput,
  parseOtherSourcesGetInput,
  parseOtherSourcesPutInput,
} from '@common/storage/cacheValidation'
import type { CacheReadResultV1, CacheWriteResultV1 } from '@common/storage/cache'


export default () => {
  // =========================歌词=========================
  mainHandle<LX.Music.LyricInfoQuery, LX.Player.LyricInfo>(WIN_MAIN_RENDERER_EVENT_NAME.get_palyer_lyric, async({ params }) => {
    // return (getStore(LRC_EDITED, true, false).get(id) as LX.Music.LyricInfo | undefined) ??
    // getStore(LRC_RAW, true, false).get(id, {}) as LX.Music.LyricInfo
    return global.lx.worker.dbService.getPlayerLyric(params)
  })

  // 原始歌词
  mainHandle<LX.Music.LyricInfoQuery, LX.Music.LyricInfo>(WIN_MAIN_RENDERER_EVENT_NAME.get_lyric_raw, async({ params }) => {
    const result = await global.lx.worker.dbService.getRawLyric(params)
    return result.status == 'hit' ? result.value : { lyric: '' }
  })
  mainHandle<LX.Music.LyricInfoSave>(WIN_MAIN_RENDERER_EVENT_NAME.save_lyric_raw, async({ params: { id, provider, lyrics } }) => {
    await global.lx.worker.dbService.rawLyricAdd({ provider, sourceTrackId: id, lyrics, nowMs: Date.now() })
  })
  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.clear_lyric_raw, async() => {
    await global.lx.worker.dbService.rawLyricClear()
  })
  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.get_lyric_raw_count, async() => {
    const result = await global.lx.worker.dbService.rawLyricCount()
    return result.status == 'hit' ? result.value.rows : 0
  })

  // 已编辑的歌词
  mainHandle<string, LX.Music.LyricInfo>(WIN_MAIN_RENDERER_EVENT_NAME.get_lyric_edited, async({ params: id }) => {
    return global.lx.worker.dbService.getEditedLyric(id)
  })
  mainHandle<LX.Music.LyricInfoSave>(WIN_MAIN_RENDERER_EVENT_NAME.save_lyric_edited, async({ params: { id, lyrics } }) => {
    await global.lx.worker.dbService.editedLyricUpdateAddAndUpdate(id, lyrics)
  })
  mainHandle<string>(WIN_MAIN_RENDERER_EVENT_NAME.remove_lyric_edited, async({ params: id }) => {
    await global.lx.worker.dbService.editedLyricRemove([id])
  })
  mainHandle<string>(WIN_MAIN_RENDERER_EVENT_NAME.clear_lyric_edited, async() => {
    await global.lx.worker.dbService.editedLyricClear()
  })
  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.get_lyric_edited_count, async() => {
    return global.lx.worker.dbService.editedLyricCount()
  })


  // =========================歌曲URL=========================
  mainHandle<unknown, CacheReadResultV1<string>>(WIN_MAIN_RENDERER_EVENT_NAME.music_url_get, async({ params }) => {
    return global.lx.worker.dbService.musicUrlGet(parseMusicUrlGetInput(params))
  })
  mainHandle<unknown, CacheWriteResultV1>(WIN_MAIN_RENDERER_EVENT_NAME.music_url_put, async({ params }) => {
    return global.lx.worker.dbService.musicUrlPut(parseMusicUrlPutInput(params))
  })
  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.music_url_clear, async() => {
    return global.lx.worker.dbService.musicUrlClear()
  })
  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.music_url_count, async() => {
    const result = await global.lx.worker.dbService.musicUrlCount()
    return result.status == 'hit' ? result.value : 0
  })

  // =========================换源歌曲=========================
  mainHandle<unknown, CacheReadResultV1<LX.Music.MusicInfoOnline[]>>(WIN_MAIN_RENDERER_EVENT_NAME.other_sources_get, async({ params }) => {
    return global.lx.worker.dbService.otherSourcesGet(parseOtherSourcesGetInput(params))
  })
  mainHandle<unknown, CacheWriteResultV1>(WIN_MAIN_RENDERER_EVENT_NAME.other_sources_put, async({ params }) => {
    return global.lx.worker.dbService.otherSourcesPut(parseOtherSourcesPutInput(params))
  })
  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.other_sources_clear, async() => {
    return global.lx.worker.dbService.otherSourcesClear()
  })
  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.other_sources_count, async() => {
    const result = await global.lx.worker.dbService.otherSourcesCount()
    return result.status == 'hit' ? result.value : 0
  })

  // mainHandle<string[]>(WIN_MAIN_RENDERER_EVENT_NAME.remove_dislike_music_infos, async({ params: ids }) => {
  //   await global.lx.worker.dbService.dislikeInfoRemove(ids)
  // })
  // mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.clear_dislike_music_infos, async() => {
  //   await global.lx.worker.dbService.dislikeInfoClear()
  // })


  // =========================我的列表=========================
  // mainHandle<boolean>(WIN_MAIN_RENDERER_EVENT_NAME.get_playlist, async({ params: isIgnoredError = false }) => {
  //   const electronStore_list = getStore('playList', isIgnoredError, false)

  //   return {
  //     defaultList: electronStore_list.get('defaultList'),
  //     loveList: electronStore_list.get('loveList'),
  //     tempList: electronStore_list.get('tempList'),
  //     userList: electronStore_list.get('userList'),
  //     downloadList: getStore('downloadList').get('list'),
  //   }
  // })

  // const handleSaveList = ({ defaultList, loveList, userList, tempList }: Partial<LX.List.MyAllList>) => {
  //   let data: Partial<LX.List.MyAllList> = {}
  //   if (defaultList != null) data.defaultList = defaultList
  //   if (loveList != null) data.loveList = loveList
  //   if (userList != null) data.userList = userList
  //   if (tempList != null) data.tempList = tempList
  //   getStore('playList').set(data)
  // }
  // mainOn<LX.List.ListSaveInfo>(WIN_MAIN_RENDERER_EVENT_NAME.save_playlist, ({ params }) => {
  //   switch (params.type) {
  //     case 'myList':
  //       handleSaveList(params.data)
  //       global.lx.event_app.save_my_list(params.data)
  //       break
  //     case 'downloadList':
  //       getStore('downloadList').set('list', params.data)
  //       break
  //   }
  // })
}
