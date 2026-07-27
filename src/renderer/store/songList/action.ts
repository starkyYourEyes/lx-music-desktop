// import { getSongListSetting } from '@renderer/utils/data'
import { deduplicationList, toNewMusicInfo } from '@renderer/utils'
import musicSdk from '@renderer/utils/musicSdk'
import { getNeteasePlaylistDetail, getQQMusicPlaylistDetail } from '@renderer/utils/ipc'
import { getQQMusicAccountKey } from '@renderer/store/qqMusic'
import { getDailyRecommendPlaylistDetail, loadDailyRecommendSongs } from '@renderer/store/dailyRecommend/action'
import { DAILY_RECOMMEND_TEMP_LIST_ID } from '@renderer/store/dailyRecommend/state'
import { getQQDailyRecommendPlaylistDetail } from '@renderer/store/qqDailyRecommend/action'
import { QQ_DAILY_RECOMMEND_LIST_ID, qqDailyRecommendGeneration } from '@renderer/store/qqDailyRecommend/state'
import { markRaw, markRawList } from '@common/utils/vueTools'
import {
  tags,
  listInfo,
  listDetailInfo,
  selectListInfo,
  isVisibleListDetail,
  openSongListInputInfo,
} from './state'
import type {
  ListDetailInfo,
  ListInfoItem,
  ListInfo,
  TagInfo,
} from './state'

const cache = new Map<string, any>()
const neteasePrivateRadarPlaylistId = '3136952023'

const isNeteasePrivateRadarPlaylist = (id: string, source: LX.OnlineSource) => {
  return source == 'wy' && id == neteasePrivateRadarPlaylistId
}

const isNeteaseDailyRecommendPlaylist = (id: string, source: LX.OnlineSource) => {
  return source == 'wy' && id == DAILY_RECOMMEND_TEMP_LIST_ID
}

const isQQDailyRecommendPlaylist = (id: string, source: LX.OnlineSource) => {
  return source == 'tx' && id == QQ_DAILY_RECOMMEND_LIST_ID
}

const shouldUseNeteasePlaylistDetail = (id: string, source: LX.OnlineSource) => {
  return source == 'wy' && !isNeteaseDailyRecommendPlaylist(id, source)
}

const getListDetailCacheKey = (id: string, source: LX.OnlineSource, page: number) => {
  const detailType = isQQDailyRecommendPlaylist(id, source)
    ? `qq_daily_recommend__${getQQMusicAccountKey() ?? 'guest'}__${qqDailyRecommendGeneration.value}`
    : isNeteaseDailyRecommendPlaylist(id, source)
      ? 'netease_daily_recommend'
      : shouldUseNeteasePlaylistDetail(id, source)
        ? isNeteasePrivateRadarPlaylist(id, source) ? 'netease_user_sdetail' : 'netease_sdetail'
        : source == 'tx'
          ? `qq_sdetail__${getQQMusicAccountKey() ?? 'guest'}`
          : 'sdetail'
  return `${detailType}__${source}__${id}__${page}`
}

const normalizeMusicSdkListDetail = (result: ListDetailInfo): ListDetailInfo => {
  result.list = markRawList(deduplicationList(result.list.map(m => toNewMusicInfo(m)) as LX.Music.MusicInfoOnline[]))
  return result
}

const normalizeIpcListDetail = (
  result: LX.Netease.PlaylistDetailInfo | LX.QQMusic.PlaylistDetailInfo,
): ListDetailInfo => {
  return {
    ...result,
    source: result.source,
    info: {
      ...result.info,
      desc: result.info.desc ?? undefined,
    },
    list: markRawList(deduplicationList(result.list)),
  }
}

const loadMusicSdkListDetail = async(id: string, source: LX.OnlineSource, page: number) => {
  return normalizeMusicSdkListDetail(await musicSdk[source]?.songList.getListDetail(id, page))
}

const loadNeteasePlaylistDetail = async(id: string, source: LX.OnlineSource, page: number) => {
  if (!shouldUseNeteasePlaylistDetail(id, source)) return loadMusicSdkListDetail(id, source, page)

  return getNeteasePlaylistDetail(id, page)
    .then(normalizeIpcListDetail)
    .catch(async err => {
      console.warn('Load NetEase playlist detail failed, fallback to source sdk:', err)
      return loadMusicSdkListDetail(id, source, page)
    })
}

const loadQQMusicPlaylistDetail = async(id: string, source: LX.OnlineSource, page: number) => {
  if (source != 'tx') return loadNeteasePlaylistDetail(id, source, page)

  return getQQMusicPlaylistDetail(id, page)
    .then(normalizeIpcListDetail)
    .catch(async err => {
      console.warn('Load QQ Music playlist detail failed, fallback to source sdk:', err)
      return loadMusicSdkListDetail(id, source, page)
    })
}

const loadListDetail = async(id: string, source: LX.OnlineSource, page: number, isRefresh = false): Promise<ListDetailInfo> => {
  const key = getListDetailCacheKey(id, source, page)
  const isQQDailyRecommend = isQQDailyRecommendPlaylist(id, source)
  const qqAccountKey = isQQDailyRecommend ? getQQMusicAccountKey() : null
  const qqPlaylistAccountKey = source == 'tx' && !isQQDailyRecommend ? getQQMusicAccountKey() : null
  if (isRefresh && cache.has(key)) cache.delete(key)
  if (!isRefresh && cache.has(key)) return cache.get(key)

  let result: ListDetailInfo
  let qqDailyGeneration: number | null = null
  if (isQQDailyRecommend) {
    const detail = getQQDailyRecommendPlaylistDetail(isRefresh, qqAccountKey)
    qqDailyGeneration = qqDailyRecommendGeneration.value
    result = normalizeIpcListDetail(await detail)
  } else if (isNeteaseDailyRecommendPlaylist(id, source)) {
    result = normalizeIpcListDetail(await getDailyRecommendPlaylistDetail(isRefresh))
  } else {
    result = await loadQQMusicPlaylistDetail(id, source, page)
  }

  const isCurrentQQDailyRecommend = !isQQDailyRecommend || (
    qqAccountKey == getQQMusicAccountKey() &&
    qqDailyGeneration == qqDailyRecommendGeneration.value
  )
  const isCurrentQQPlaylist = source != 'tx' || isQQDailyRecommend ||
    qqPlaylistAccountKey == getQQMusicAccountKey()
  if (isCurrentQQDailyRecommend && isCurrentQQPlaylist) {
    cache.set(isQQDailyRecommend ? getListDetailCacheKey(id, source, page) : key, result)
  }
  return result
}

export const setTags = (tagInfo: TagInfo, source: LX.OnlineSource) => {
  tags[source] = markRaw(tagInfo)
}

export const clearList = () => {
  listInfo.list = []
  listInfo.total = 0
  listInfo.noItemLabel = ''
  listInfo.page = 1
  listInfo.key = ''
}

export const setList = (result: ListInfo, tagId: string, sortId: string, page: number) => {
  listInfo.list = markRaw([...result.list])
  if (page == 1 || (result.total && result.list.length)) listInfo.total = result.total
  else listInfo.total = result.limit * page
  listInfo.limit = result.limit
  listInfo.page = page
  listInfo.source = result.source
  listInfo.tagId = tagId
  listInfo.sortId = sortId
  if (result.list.length) listInfo.noItemLabel = ''
  else if (page == 1) listInfo.noItemLabel = window.i18n.t('no_item')
}
export const setListDetail = (result: ListDetailInfo, id: string, page: number) => {
  listDetailInfo.list = markRaw([...result.list])
  listDetailInfo.id = id
  listDetailInfo.source = result.source
  if (page == 1 || (result.total && result.list.length)) listDetailInfo.total = result.total
  else listDetailInfo.total = result.limit * page
  listDetailInfo.limit = result.limit
  listDetailInfo.page = page
  listDetailInfo.info = markRaw({ ...result.info })
  if (result.list.length) listDetailInfo.noItemLabel = ''
  else if (page == 1) listDetailInfo.noItemLabel = window.i18n.t('no_item')
}

export const setSelectListInfo = (info: ListInfoItem) => {
  selectListInfo.author = info.author
  selectListInfo.desc = info.desc
  selectListInfo.id = info.id
  selectListInfo.img = info.img
  selectListInfo.name = info.name
  selectListInfo.play_count = info.play_count
  selectListInfo.source = info.source
}
export const clearListDetail = () => {
  listDetailInfo.list = []
  listDetailInfo.id = ''
  listDetailInfo.source = 'kw'
  listDetailInfo.total = 0
  listDetailInfo.limit = 30
  listDetailInfo.page = 1
  listDetailInfo.key = null
  listDetailInfo.info = {}
  listDetailInfo.noItemLabel = ''
}

export const getTags = async<T extends LX.OnlineSource>(source: T) => {
  return musicSdk[source]?.songList.getTags() as Promise<TagInfo<T>>
}


/**
 * 获取歌单列表
 * @param source 歌单源
 * @param tabId 类型id
 * @param sortId 排序
 * @param page 页数
 * @param isRefresh 是否跳过缓存
 * @returns
 */
export const getAndSetList = async(source: LX.OnlineSource, tabId: string, sortId: string, page: number, isRefresh = false) => {
  // let source = rootState.setting.songList.source
  // let tabId = rootState.setting.songList.tagInfo.id
  // let sortId = rootState.setting.songList.sortId
  // console.log(sortId)
  let key = `slist__${source}__${sortId}__${tabId}__${page}`
  // if (state.list.list.length && state.list.key == key) return
  if (!isRefresh) {
    if (listInfo.key == key && listInfo.list.length) return
    if (cache.has(key)) {
      listInfo.key = key
      setList(cache.get(key), tabId, sortId, page)
      return
    }
  }
  listInfo.noItemLabel = window.i18n.t('list__loading')
  listInfo.key = key
  // clearList()
  return musicSdk[source]?.songList.getList(sortId, tabId, page).then((result: ListInfo) => {
    cache.set(key, result)
    if (key != listInfo.key) return
    setList(result, tabId, sortId, page)
  }).catch((error: any) => {
    clearList()
    listInfo.noItemLabel = window.i18n.t('list__load_failed')
    console.log(error)
    throw error
  })
}

/**
 * 获取歌单内单页歌曲
 * @param id 歌单id
 * @param source 歌单源
 * @param isRefresh 是否跳过缓存
 * @returns
 */
export const getListDetail = async(id: string, source: LX.OnlineSource, page: number, isRefresh = false): Promise<ListDetailInfo> => {
  return loadListDetail(id, source, page, isRefresh)
}

/**
 * 获取歌单内全部歌曲
 * @param id 歌单id
 * @param source 歌单源
 * @param isRefresh 是否跳过缓存
 * @returns
 */
export const getListDetailAll = async(id: string, source: LX.OnlineSource, isRefresh = false): Promise<LX.Music.MusicInfoOnline[]> => {
  // console.log(source, id)
  if (isQQDailyRecommendPlaylist(id, source)) {
    const detail = await getQQDailyRecommendPlaylistDetail(isRefresh, getQQMusicAccountKey())
    return deduplicationList(detail.list)
  }
  if (isNeteaseDailyRecommendPlaylist(id, source)) {
    return deduplicationList(await loadDailyRecommendSongs(isRefresh))
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  const loadData = (id: string, page: number): Promise<ListDetailInfo> => {
    return loadListDetail(id, source, page, isRefresh)
  }
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  return loadData(id, 1).then((result: ListDetailInfo) => {
    if (result.total <= result.limit) return result.list

    let maxPage = Math.ceil(result.total / result.limit)
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    const loadDetail = (loadPage = 2): Promise<ListDetailInfo['list']> => {
      return loadPage == maxPage
        ? loadData(id, loadPage).then((result: ListDetailInfo) => result.list)
        // eslint-disable-next-line @typescript-eslint/promise-function-async
        : loadData(id, loadPage).then((result1: ListDetailInfo) => loadDetail(++loadPage).then((result2: ListDetailInfo['list']) => [...result1.list, ...result2]))
    }
    return loadDetail().then(result2 => [...result.list, ...result2])
  }).then((list: ListDetailInfo['list']) => deduplicationList(list))
}


/**
 * 获取并设置歌单内单页歌曲
 * @param id 歌单id
 * @param source 歌单源
 * @param isRefresh 是否跳过缓存
 * @returns
 */
export const getAndSetListDetail = async(id: string, source: LX.OnlineSource, page: number, isRefresh = false) => {
  let key = getListDetailCacheKey(id, source, page)
  const qqAccountKey = source == 'tx' ? getQQMusicAccountKey() : null
  const isCurrentRequest = () => key == listDetailInfo.key &&
    (source != 'tx' || qqAccountKey == getQQMusicAccountKey())

  if (!isRefresh && listDetailInfo.key == key && listDetailInfo.list.length) return

  listDetailInfo.key = key
  listDetailInfo.noItemLabel = window.i18n.t('list__loading')

  return getListDetail(id, source, page, isRefresh).then((result: ListDetailInfo) => {
    if (!isCurrentRequest()) return
    setListDetail(result, id, page)
  }).catch((error: any) => {
    if (isCurrentRequest()) {
      clearListDetail()
      listDetailInfo.noItemLabel = window.i18n.t('list__load_failed')
      console.log(error)
    }
    throw error
  })
}

export const setVisibleListDetail = (visible: boolean) => {
  isVisibleListDetail.value = visible
}

export const setOpenSongListInputInfo = (text: string, source: string) => {
  openSongListInputInfo.text = text
  openSongListInputInfo.source = source
}
