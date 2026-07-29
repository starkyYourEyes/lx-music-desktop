import { getCookieValue, getGtk } from './auth'
import {
  createQQMusicFallbackGuid,
  createQQMusicFallbackUid,
  createQQMusicRequestSign,
} from './request'
import { QQMusicAuthError } from './song'

const FEEDBACK_ERROR = 'QQ Music feedback request failed'
const FEEDBACK_URL = 'https://u6.y.qq.com/cgi-bin/musics.fcg'
const REQUEST_KEY = 'req_1'

type ResultCodeName = 'retCode' | 'Retcode'

interface FeedbackRequest {
  module: string
  method: string
  param: Record<string, unknown>
  resultCodeName: ResultCodeName
}

const getNumericSongId = (musicInfo: LX.Music.MusicInfo_tx) => {
  const id = Number(musicInfo.meta.id)
  if (Number.isInteger(id) && id > 0) return id
  const legacyId = Number(musicInfo.meta.songId)
  if (Number.isInteger(legacyId) && legacyId > 0) return legacyId
  throw new Error(FEEDBACK_ERROR)
}

const getSongType = (musicInfo: LX.Music.MusicInfo_tx) => {
  return Number.isInteger(musicInfo.meta.songType) ? musicInfo.meta.songType as number : 0
}

export const createQQMusicFeedbackService = ({
  fetchImpl = fetch,
  getCookie,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}: {
  fetchImpl?: typeof fetch
  getCookie: () => string
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}) => {
  const sendRequest = async(requestData: FeedbackRequest): Promise<void> => {
    const cookie = getCookie()
    if (!cookie) throw new QQMusicAuthError('QQ Music account is not logged in')
    const uin = (getCookieValue(cookie, 'uin') || getCookieValue(cookie, 'qqmusic_uin')).replace(/^o/, '')
    const key = getCookieValue(cookie, 'qqmusic_key') || getCookieValue(cookie, 'qm_keyst')
    if (!uin || !key) throw new QQMusicAuthError('QQ Music account is not logged in')
    const guid = getCookieValue(cookie, 'qqmusic_guid') ||
      getCookieValue(cookie, 'guid') ||
      createQQMusicFallbackGuid(uin)
    const uid = getCookieValue(cookie, 'uid') || createQQMusicFallbackUid(uin)
    const gtk = getGtk(key)
    const body = JSON.stringify({
      comm: {
        format: 'json',
        ct: 20,
        cv: 2116,
        platform: 'wk_v17',
        uid,
        guid,
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        notice: 0,
        needNewCode: 1,
        uin,
        g_tk_new_20200303: gtk,
        g_tk: gtk,
      },
      [REQUEST_KEY]: {
        module: requestData.module,
        method: requestData.method,
        param: requestData.param,
      },
    })
    const url = new URL(FEEDBACK_URL)
    url.searchParams.set('sign', createQQMusicRequestSign(body))
    const controller = new AbortController()
    const timer = setTimeoutImpl(() => controller.abort(), 10_000)
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://y.qq.com/',
          Cookie: cookie,
        },
        body,
      })
      if (!response.ok) throw new Error(FEEDBACK_ERROR)
      const payload = await response.json()
      const result = payload?.[REQUEST_KEY]
      const operationCode = result?.data?.[requestData.resultCodeName]
      if (payload?.code == 1000 || result?.code == 1000 || operationCode == 1000) {
        throw new QQMusicAuthError()
      }
      if (payload?.code != 0 || result?.code != 0 || operationCode != 0) {
        throw new Error(FEEDBACK_ERROR)
      }
    } catch (error) {
      if ((error as Error | null)?.name == 'QQMusicAuthError') throw error
      throw new Error(FEEDBACK_ERROR)
    } finally {
      clearTimeoutImpl(timer)
    }
  }

  const likeMusic = async(musicInfo: LX.Music.MusicInfo_tx): Promise<void> => {
    const songId = getNumericSongId(musicInfo)
    await sendRequest({
      module: 'music.musicasset.PlaylistDetailWrite',
      method: 'AddSonglist',
      param: {
        dirId: 201,
        tid: 0,
        bFmtUtf8: true,
        v_songInfo: [{ songId, songType: getSongType(musicInfo) }],
      },
      resultCodeName: 'retCode',
    })
  }

  const dislikeMusic = async(musicInfo: LX.Music.MusicInfo_tx): Promise<void> => {
    const songId = getNumericSongId(musicInfo)
    await sendRequest({
      module: 'music.feedback.FeedbackBlack',
      method: 'AddDislike',
      param: { Songs: [{ ID: String(songId) }] },
      resultCodeName: 'Retcode',
    })
  }

  return { likeMusic, dislikeMusic }
}
