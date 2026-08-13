import { apiSource, qualityList } from '@renderer/store'
import { isLoggedIn as isNeteaseLoggedIn } from '@renderer/store/netease'
import { isLoggedIn as isQQMusicLoggedIn } from '@renderer/store/qqMusic'
import type { AuthorizedMusicUrlKeyV1, TrackIdentityV1 } from '@common/storage/cache'
import { assertApiSupport } from '@renderer/store/utils'
import musicSdk from '@renderer/utils/musicSdk'
import {
  getOtherSourcesFromCache,
  putOtherSourcesInCache,
  getMusicUrl as getStoreMusicUrl,
  getPlayerLyric as getStoreLyric,
  requestMusicUrlAuthorization,
} from '@renderer/utils/ipc'
import { appSetting } from '@renderer/store/setting'
import { langS2T, toNewMusicInfo, toOldMusicInfo } from '@renderer/utils'
import { requestMsg } from '@renderer/utils/message'
import { apis } from '@renderer/utils/musicSdk/api-source'
import {
  createOnlineCandidateProvider,
  findPlaybackCandidates,
  selectPlaybackQuality,
} from './playback/candidates'
import { playbackUrlCache } from './playback/cache'


const getOtherSourcePromises = new Map()
let storageCacheGeneration = 0
export const existTimeExp = /\[\d{1,2}:.*\d{1,4}\]/

export const adoptCacheGeneration = (generation: number): void => {
  if (!Number.isSafeInteger(generation) || generation <= storageCacheGeneration) return
  storageCacheGeneration = generation
  playbackUrlCache.adoptCacheGeneration(generation)
  getOtherSourcePromises.clear()
}

const getTrackIdentity = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem): TrackIdentityV1 => {
  const info = 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
  return { originalProvider: info.source, originalTrackId: info.id }
}

const getTrackIdentityKey = (identity: TrackIdentityV1): string =>
  JSON.stringify([identity.originalProvider, identity.originalTrackId])

export const getMusicUrlCacheKey = async(
  musicInfo: LX.Music.MusicInfo,
  quality: LX.Quality,
  persistentCache = !/^user_api/.test(apiSource.value ?? ''),
): Promise<AuthorizedMusicUrlKeyV1 | null> => {
  if (!persistentCache) return null
  const provider = musicInfo.source == 'wy' || musicInfo.source == 'tx'
    ? musicInfo.source
    : null
  if (provider == null ||
    (provider == 'wy' && !isNeteaseLoggedIn.value) ||
    (provider == 'tx' && !isQQMusicLoggedIn.value)) return null
  return requestMusicUrlAuthorization(provider).then(authorization => authorization == null ? null : {
    authorization,
    sourceTrackId: musicInfo.id,
    quality,
  })
}

export const getOtherSource = async(musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, isRefresh = false): Promise<LX.Music.MusicInfoOnline[]> => {
  const startingGeneration = storageCacheGeneration
  const identity = getTrackIdentity(musicInfo)
  if (!isRefresh) {
    const persisted = await getOtherSourcesFromCache(identity)
    if (startingGeneration != storageCacheGeneration) return getOtherSource(musicInfo, isRefresh)
    if (persisted.length) return persisted
  }
  const key = getTrackIdentityKey(identity)
  let searchMusicInfo: {
    name: string
    singer: string
    source: string
    albumName: string
    interval: string
  }
  if ('progress' in musicInfo) {
    searchMusicInfo = {
      name: musicInfo.metadata.musicInfo.name,
      singer: musicInfo.metadata.musicInfo.singer,
      source: musicInfo.metadata.musicInfo.source,
      albumName: musicInfo.metadata.musicInfo.meta.albumName,
      interval: musicInfo.metadata.musicInfo.interval ?? '',
    }
  } else {
    searchMusicInfo = {
      name: musicInfo.name,
      singer: musicInfo.singer,
      source: musicInfo.source,
      albumName: musicInfo.meta.albumName,
      interval: musicInfo.interval ?? '',
    }
  }
  if (getOtherSourcePromises.has(key)) return getOtherSourcePromises.get(key)

  const promise = new Promise<LX.Music.MusicInfoOnline[]>((resolve, reject) => {
    let timeout: null | NodeJS.Timeout = setTimeout(() => {
      timeout = null
      reject(new Error('find music timeout'))
    }, 15_000)
    musicSdk.findMusic(searchMusicInfo).then((otherSource) => {
      const source = otherSource.map(toNewMusicInfo) as LX.Music.MusicInfoOnline[]
      resolve(source)
    }).catch(reject).finally(() => {
      if (timeout) clearTimeout(timeout)
    })
  }).then((otherSource) => {
    if (startingGeneration == storageCacheGeneration) {
      void putOtherSourcesInCache(identity, otherSource).catch(() => {})
    }
    return otherSource
  }).finally(() => {
    if (startingGeneration == storageCacheGeneration && getOtherSourcePromises.get(key) === promise) {
      getOtherSourcePromises.delete(key)
    }
  })
  getOtherSourcePromises.set(key, promise)
  return promise
}


export const buildLyricInfo = async(lyricInfo: MakeOptional<LX.Player.LyricInfo, 'rawlrcInfo'>): Promise<LX.Player.LyricInfo> => {
  if (!appSetting['player.isS2t']) {
    // @ts-expect-error
    if (lyricInfo.rawlrcInfo) return lyricInfo
    return { ...lyricInfo, rawlrcInfo: { ...lyricInfo } }
  }

  if (appSetting['player.isS2t']) {
    const tasks = [
      lyricInfo.lyric ? langS2T(lyricInfo.lyric) : Promise.resolve(''),
      lyricInfo.tlyric ? langS2T(lyricInfo.tlyric) : Promise.resolve(''),
      lyricInfo.rlyric ? langS2T(lyricInfo.rlyric) : Promise.resolve(''),
      lyricInfo.lxlyric ? langS2T(lyricInfo.lxlyric) : Promise.resolve(''),
    ]
    if (lyricInfo.rawlrcInfo) {
      tasks.push(lyricInfo.rawlrcInfo.lyric ? langS2T(lyricInfo.rawlrcInfo.lyric) : Promise.resolve(''))
      tasks.push(lyricInfo.rawlrcInfo.tlyric ? langS2T(lyricInfo.rawlrcInfo.tlyric) : Promise.resolve(''))
      tasks.push(lyricInfo.rawlrcInfo.rlyric ? langS2T(lyricInfo.rawlrcInfo.rlyric) : Promise.resolve(''))
      tasks.push(lyricInfo.rawlrcInfo.lxlyric ? langS2T(lyricInfo.rawlrcInfo.lxlyric) : Promise.resolve(''))
    }
    return Promise.all(tasks).then(([lyric, tlyric, rlyric, lxlyric, lyric_raw, tlyric_raw, rlyric_raw, lxlyric_raw]) => {
      const rawlrcInfo = lyricInfo.rawlrcInfo ? {
        lyric: lyric_raw,
        tlyric: tlyric_raw,
        rlyric: rlyric_raw,
        lxlyric: lxlyric_raw,
      } : {
        lyric,
        tlyric,
        rlyric,
        lxlyric,
      }
      return {
        lyric,
        tlyric,
        rlyric,
        lxlyric,
        rawlrcInfo,
      }
    })
  }

  // @ts-expect-error
  return lyricInfo.rawlrcInfo ? lyricInfo : { ...lyricInfo, rawlrcInfo: { ...lyricInfo } }
}

export const getCachedLyricInfo = async(musicInfo: LX.Music.MusicInfo): Promise<LX.Player.LyricInfo | null> => {
  let lrcInfo = await getStoreLyric(musicInfo)
  // lrcInfo = {} as unknown as LX.Player.LyricInfo
  if (existTimeExp.test(lrcInfo.lyric)) {
    if (lrcInfo.tlyric != null) {
      // if (musicInfo.lrc.startsWith('\ufeff[id:$00000000]')) {
      //   let str = musicInfo.lrc.replace('\ufeff[id:$00000000]\n', '')
      //   commit('setLrc', { musicInfo, lyric: str, tlyric: musicInfo.tlrc, lxlyric: musicInfo.tlrc })
      // } else if (musicInfo.lrc.startsWith('[id:$00000000]')) {
      //   let str = musicInfo.lrc.replace('[id:$00000000]\n', '')
      //   commit('setLrc', { musicInfo, lyric: str, tlyric: musicInfo.tlrc, lxlyric: musicInfo.tlrc })
      // }

      if (lrcInfo.lxlyric == null) {
        switch (musicInfo.source) { // 以下源支持lxlyric 重新获取
          case 'kg':
          case 'kw':
          case 'mg':
          case 'wy':
          case 'tx':
            break
          default:
            return lrcInfo
        }
      } else if (lrcInfo.rlyric == null) {
        // 以下源支持 rlyric 重新获取
        if (!['wy', 'kg', 'tx'].includes(musicInfo.source)) return lrcInfo
      } else return lrcInfo
    }
    if (musicInfo.source == 'local') return lrcInfo
  }
  return null
}

let localPrimaryActionStart = Promise.resolve()
const reserveLocalPrimaryAction = <T>() => {
  let provide!: (action: () => Promise<T>) => void
  const actionReady = new Promise<() => Promise<T>>(resolve => { provide = resolve })
  const previous = localPrimaryActionStart
  const result = previous.then(async() => {
    const action = await actionReady
    return action()
  })
  localPrimaryActionStart = result.then(() => undefined, () => undefined)
  return { provide, result }
}

export const getOnlineOtherSourceMusicUrlByLocal = async(musicInfo: LX.Music.MusicInfoLocal, isRefresh: boolean): Promise<{
  url: string
  quality: LX.Quality
  isFromCache: boolean
  persistentCache: boolean
  cacheKey: AuthorizedMusicUrlKeyV1 | null
}> => {
  const reserved = reserveLocalPrimaryAction<{
    url: string
    quality: LX.Quality
    isFromCache: boolean
    persistentCache: boolean
    cacheKey: AuthorizedMusicUrlKeyV1 | null
  }>()
  const quality = '128k'

  let cacheKey: AuthorizedMusicUrlKeyV1 | null
  let cachedUrl: string
  try {
    cacheKey = await getMusicUrlCacheKey(musicInfo, quality)
    cachedUrl = cacheKey == null ? '' : (await getStoreMusicUrl(cacheKey))?.url ?? ''
  } catch (error) {
    reserved.provide(async() => { throw error })
    return reserved.result
  }
  if (cachedUrl && !isRefresh) {
    reserved.provide(async() => ({
      url: cachedUrl,
      quality,
      isFromCache: true,
      persistentCache: true,
      cacheKey,
    }))
  } else {
    reserved.provide(async() => {
      let reqPromise
      try {
        reqPromise = apis('local').getMusicUrl(toOldMusicInfo(musicInfo), null).promise
      } catch (err: any) {
        reqPromise = Promise.reject(err)
      }
      return reqPromise.then(({ url, persistentCache = true }: LX.Playback.MusicUrlResult) => ({
        url,
        quality,
        isFromCache: false,
        persistentCache,
        cacheKey: persistentCache ? cacheKey : null,
      }))
    })
  }
  return reserved.result
}

export const getOnlineOtherSourceLyricByLocal = async(musicInfo: LX.Music.MusicInfoLocal, isRefresh: boolean): Promise<{
  lyricInfo: LX.Music.LyricInfo
  isFromCache: boolean
}> => {
  const reserved = reserveLocalPrimaryAction<{ lyricInfo: LX.Music.LyricInfo, isFromCache: boolean }>()
  let lyricInfo: LX.Player.LyricInfo | null
  try {
    lyricInfo = await getCachedLyricInfo(musicInfo)
  } catch (error) {
    reserved.provide(async() => { throw error })
    return reserved.result
  }
  if (lyricInfo && !isRefresh) {
    reserved.provide(async() => ({ lyricInfo, isFromCache: true }))
  } else {
    reserved.provide(async() => {
      let reqPromise
      try {
        reqPromise = apis('local').getLyric(toOldMusicInfo(musicInfo)).promise
      } catch (err: any) {
        reqPromise = Promise.reject(err)
      }
      return reqPromise.then((value: LX.Music.LyricInfo) => ({ lyricInfo: value, isFromCache: false }))
    })
  }
  return reserved.result
}

export const getOnlineOtherSourcePicByLocal = async(musicInfo: LX.Music.MusicInfoLocal): Promise<{
  url: string
}> => {
  const reserved = reserveLocalPrimaryAction<{ url: string }>()
  reserved.provide(async() => {
    let reqPromise
    try {
      reqPromise = apis('local').getPic(toOldMusicInfo(musicInfo)).promise
    } catch (err: any) {
      reqPromise = Promise.reject(err)
    }
    return reqPromise.then((url: string) => ({ url }))
  })
  return reserved.result
}

export const TRY_QUALITYS_LIST = ['flac24bit', 'flac', '320k'] as const
export const getPlayQuality = (highQuality: LX.Quality, musicInfo: LX.Music.MusicInfoOnline): LX.Quality => {
  return selectPlaybackQuality(
    highQuality,
    musicInfo,
    qualityList.value[musicInfo.source] ?? [],
  ) ?? '128k'
}

export const getOnlineOtherSourceMusicUrl = async({ musicInfos, quality, onToggleSource, isRefresh, retryedSource = [] }: {
  musicInfos: LX.Music.MusicInfoOnline[]
  quality?: LX.Quality
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  retryedSource?: LX.OnlineSource[]
}): Promise<{
  url: string
  musicInfo: LX.Music.MusicInfoOnline
  quality: LX.Quality
  isFromCache: boolean
  persistentCache: boolean
  cacheKey: AuthorizedMusicUrlKeyV1 | null
}> => {
  let musicInfo: LX.Music.MusicInfoOnline | null = null
  let itemQuality: LX.Quality | null = null
  // eslint-disable-next-line no-cond-assign
  while (musicInfo = (musicInfos.shift()!)) {
    if (retryedSource.includes(musicInfo.source)) continue
    retryedSource.push(musicInfo.source)
    if (!assertApiSupport(musicInfo.source)) continue
    itemQuality = selectPlaybackQuality(
      quality ?? appSetting['player.playQuality'],
      musicInfo,
      qualityList.value[musicInfo.source] ?? [],
    )
    if (!itemQuality) continue

    console.log('try toggle to: ', musicInfo.source, musicInfo.name, musicInfo.singer, musicInfo.interval)
    onToggleSource(musicInfo)
    break
  }
  if (!musicInfo || !itemQuality) throw new Error(window.i18n.t('toggle_source_failed'))

  const cacheKey = await getMusicUrlCacheKey(musicInfo, itemQuality)
  const cachedUrl = cacheKey == null ? '' : (await getStoreMusicUrl(cacheKey))?.url ?? ''
  if (cachedUrl && !isRefresh) {
    return { url: cachedUrl, musicInfo, quality: itemQuality, isFromCache: true, persistentCache: true, cacheKey }
  }

  let reqPromise
  try {
    reqPromise = musicSdk[musicInfo.source].getMusicUrl(toOldMusicInfo(musicInfo), itemQuality).promise
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }
  // retryedSource.includes(musicInfo.source)
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  return reqPromise.then(({ url, type, persistentCache = true }: LX.Playback.MusicUrlResult) => {
    const responseCacheKey = persistentCache && cacheKey != null ? { ...cacheKey, quality: type } : null
    return { musicInfo, url, quality: type, isFromCache: false, persistentCache, cacheKey: responseCacheKey }
    // eslint-disable-next-line @typescript-eslint/promise-function-async
  }).catch((err: any) => {
    if (err.message == requestMsg.tooManyRequests) throw err
    console.log(err)
    return getOnlineOtherSourceMusicUrl({ musicInfos, quality, onToggleSource, isRefresh, retryedSource })
  })
}

/**
 * 获取在线音乐URL
 */
export const handleGetOnlineMusicUrl = async({ musicInfo, quality, onToggleSource, isRefresh, allowToggleSource, cacheKey }: {
  musicInfo: LX.Music.MusicInfoOnline
  quality?: LX.Quality
  isRefresh: boolean
  allowToggleSource: boolean
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  cacheKey: AuthorizedMusicUrlKeyV1 | null
}): Promise<{
  url: string
  musicInfo: LX.Music.MusicInfoOnline
  quality: LX.Quality
  isFromCache: boolean
  persistentCache: boolean
  cacheKey: AuthorizedMusicUrlKeyV1 | null
}> => {
  // console.log(musicInfo.source)
  const candidateProvider = createOnlineCandidateProvider(musicInfo, findPlaybackCandidates)
  const targetQuality = quality ?? getPlayQuality(appSetting['player.playQuality'], musicInfo)
  let reqPromise
  try {
    reqPromise = musicSdk[musicInfo.source].getMusicUrl(toOldMusicInfo(musicInfo), targetQuality).promise
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }
  return reqPromise.then(({ url, type, persistentCache = true }: LX.Playback.MusicUrlResult) => {
    const responseCacheKey = persistentCache && cacheKey != null ? { ...cacheKey, quality: type } : null
    return { musicInfo, url, quality: type, isFromCache: false, persistentCache, cacheKey: responseCacheKey }
  }).catch(async(err: any) => {
    console.log(err)
    if (!allowToggleSource || err.message == requestMsg.tooManyRequests) throw err
    onToggleSource()
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    return candidateProvider.getMatched().then(otherSource => {
      console.log('find otherSource', otherSource)
      if (otherSource.length) {
        return getOnlineOtherSourceMusicUrl({
          musicInfos: [...otherSource],
          onToggleSource,
          quality,
          isRefresh,
          retryedSource: [musicInfo.source],
        })
      }
      throw err
    })
  })
}


export const getOnlineOtherSourcePicUrl = async({ musicInfos, onToggleSource, isRefresh, retryedSource = [] }: {
  musicInfos: LX.Music.MusicInfoOnline[]
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  retryedSource?: LX.OnlineSource[]
}): Promise<{
  url: string
  musicInfo: LX.Music.MusicInfoOnline
  isFromCache: boolean
}> => {
  let musicInfo: LX.Music.MusicInfoOnline | null = null
  // eslint-disable-next-line no-cond-assign
  while (musicInfo = (musicInfos.shift()!)) {
    if (retryedSource.includes(musicInfo.source)) continue
    retryedSource.push(musicInfo.source)
    // if (!assertApiSupport(musicInfo.source)) continue
    console.log('try toggle to: ', musicInfo.source, musicInfo.name, musicInfo.singer, musicInfo.interval)
    onToggleSource(musicInfo)
    break
  }
  if (!musicInfo) throw new Error(window.i18n.t('toggle_source_failed'))

  if (musicInfo.meta.picUrl && !isRefresh) return { musicInfo, url: musicInfo.meta.picUrl, isFromCache: true }

  let reqPromise
  try {
    reqPromise = musicSdk[musicInfo.source].getPic(toOldMusicInfo(musicInfo))
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }
  // retryedSource.includes(musicInfo.source)
  return reqPromise.then((url: string) => {
    return { musicInfo, url, isFromCache: false }
    // eslint-disable-next-line @typescript-eslint/promise-function-async
  }).catch((err: any) => {
    console.log(err)
    return getOnlineOtherSourcePicUrl({ musicInfos, onToggleSource, isRefresh, retryedSource })
  })
}

/**
 * 获取在线歌曲封面
 */
export const handleGetOnlinePicUrl = async({ musicInfo, isRefresh, onToggleSource, allowToggleSource }: {
  musicInfo: LX.Music.MusicInfoOnline
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  allowToggleSource: boolean
}): Promise<{
  url: string
  musicInfo: LX.Music.MusicInfoOnline
  isFromCache: boolean
}> => {
  // console.log(musicInfo.source)
  let reqPromise
  try {
    reqPromise = musicSdk[musicInfo.source].getPic(toOldMusicInfo(musicInfo))
  } catch (err) {
    reqPromise = Promise.reject(err)
  }
  return reqPromise.then((url: string) => {
    return { musicInfo, url, isFromCache: false }
  }).catch(async(err: any) => {
    console.log(err)
    if (!allowToggleSource) throw err
    onToggleSource()
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    return getOtherSource(musicInfo).then(otherSource => {
      console.log('find otherSource', otherSource)
      if (otherSource.length) {
        return getOnlineOtherSourcePicUrl({
          musicInfos: [...otherSource],
          onToggleSource,
          isRefresh,
          retryedSource: [musicInfo.source],
        })
      }
      throw err
    })
  })
}


export const getOnlineOtherSourceLyricInfo = async({ musicInfos, onToggleSource, isRefresh, retryedSource = [] }: {
  musicInfos: LX.Music.MusicInfoOnline[]
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  retryedSource?: LX.OnlineSource[]
}): Promise<{
  lyricInfo: LX.Music.LyricInfo | LX.Player.LyricInfo
  musicInfo: LX.Music.MusicInfoOnline
  isFromCache: boolean
}> => {
  let musicInfo: LX.Music.MusicInfoOnline | null = null
  // eslint-disable-next-line no-cond-assign
  while (musicInfo = (musicInfos.shift()!)) {
    if (retryedSource.includes(musicInfo.source)) continue
    retryedSource.push(musicInfo.source)
    // if (!assertApiSupport(musicInfo.source)) continue
    console.log('try toggle to: ', musicInfo.source, musicInfo.name, musicInfo.singer, musicInfo.interval)
    onToggleSource(musicInfo)
    break
  }
  if (!musicInfo) throw new Error(window.i18n.t('toggle_source_failed'))

  if (!isRefresh) {
    const lyricInfo = await getCachedLyricInfo(musicInfo)
    if (lyricInfo) return { musicInfo, lyricInfo, isFromCache: true }
  }

  let reqPromise
  try {
    // TODO: remove any type
    reqPromise = (musicSdk[musicInfo.source].getLyric(toOldMusicInfo(musicInfo)) as any).promise
  } catch (err: any) {
    reqPromise = Promise.reject(err)
  }
  // retryedSource.includes(musicInfo.source)
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  return reqPromise.then((lyricInfo: LX.Music.LyricInfo) => {
    return existTimeExp.test(lyricInfo.lyric) ? {
      lyricInfo,
      musicInfo,
      isFromCache: false,
    } : Promise.reject(new Error('failed'))
    // eslint-disable-next-line @typescript-eslint/promise-function-async
  }).catch((err: any) => {
    console.log(err)
    return getOnlineOtherSourceLyricInfo({ musicInfos, onToggleSource, isRefresh, retryedSource })
  })
}

/**
 * 获取在线歌词信息
 */
export const handleGetOnlineLyricInfo = async({ musicInfo, onToggleSource, isRefresh, allowToggleSource }: {
  musicInfo: LX.Music.MusicInfoOnline
  onToggleSource: (musicInfo?: LX.Music.MusicInfoOnline) => void
  isRefresh: boolean
  allowToggleSource: boolean
}): Promise<{
  musicInfo: LX.Music.MusicInfoOnline
  lyricInfo: LX.Music.LyricInfo | LX.Player.LyricInfo
  isFromCache: boolean
}> => {
  // console.log(musicInfo.source)
  let reqPromise
  try {
    // TODO: remove any type
    reqPromise = (musicSdk[musicInfo.source].getLyric(toOldMusicInfo(musicInfo)) as any).promise
  } catch (err) {
    reqPromise = Promise.reject(err)
  }
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  return reqPromise.then((lyricInfo: LX.Music.LyricInfo) => {
    return existTimeExp.test(lyricInfo.lyric) ? {
      musicInfo,
      lyricInfo,
      isFromCache: false,
    } : Promise.reject(new Error('failed'))
  }).catch(async(err: any) => {
    console.log(err)
    if (!allowToggleSource) throw err

    onToggleSource()
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    return getOtherSource(musicInfo).then(otherSource => {
      console.log('find otherSource', otherSource)
      if (otherSource.length) {
        return getOnlineOtherSourceLyricInfo({
          musicInfos: [...otherSource],
          onToggleSource,
          isRefresh,
          retryedSource: [musicInfo.source],
        })
      }
      throw err
    })
  })
}
