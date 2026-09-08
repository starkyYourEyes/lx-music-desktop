import { createHash, randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { createKugouRequest, type KugouRequest } from './request'

export { createKugouRequest } from './request'

export interface KugouApi {
  topPlaylist: (params?: Record<string, any>) => Promise<any>
  rankList: (params?: Record<string, any>) => Promise<any>
  rankAudio: (params: Record<string, any>) => Promise<any>
  recommendSongs: (params?: Record<string, any>) => Promise<any>
  everydayStyleRecommend: (params?: Record<string, any>) => Promise<any>
  fmRecommend: (params?: Record<string, any>) => Promise<any>
  fmSongs: (params: Record<string, any>) => Promise<any>
  loginQrKey: (params?: Record<string, any>) => Promise<any>
  loginQrCreate: (params: Record<string, any>) => Promise<any>
  loginQrCheck: (params: Record<string, any>) => Promise<any>
  userInfo: (params?: Record<string, any>) => Promise<any>
  userPlaylist: (params?: Record<string, any>) => Promise<any>
}

type UpstreamMethod = (params?: Record<string, any>, request?: KugouRequest) => Promise<any>
type UpstreamApi = Record<string, UpstreamMethod | undefined>

declare const __non_webpack_require__: NodeRequire
const packageRequire = __non_webpack_require__

const guid = createHash('md5').update(randomUUID()).digest('hex')
const deviceCookie = Object.freeze({
  KUGOU_API_MID: BigInt(`0x${createHash('md5').update(guid).digest('hex')}`).toString(10),
  KUGOU_API_GUID: guid,
  KUGOU_API_DEV: randomBytes(5).toString('hex').toUpperCase(),
  KUGOU_API_WEBGL: BigInt(`0x${randomBytes(8).toString('hex')}`).toString(10),
})

const parseCookie = (value: unknown): Record<string, string> => {
  if (value == null) return {}
  if (Array.isArray(value)) return Object.assign({}, ...value.map(parseCookie))
  if (typeof value == 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key.trim(), String(item)]))
  }
  const cookie: Record<string, string> = {}
  for (const part of String(value).split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    cookie[part.slice(0, separator).trim()] = part.slice(separator + 1).trim()
  }
  return cookie
}

const loadPinnedApi = (): UpstreamApi => {
  const packageEntry = packageRequire.resolve('kugoumusicapi')
  const moduleRoot = path.join(path.dirname(packageEntry), 'module')
  const load = (name: string): UpstreamMethod => packageRequire(path.join(moduleRoot, `${name}.js`)) as UpstreamMethod
  return {
    top_playlist: load('top_playlist'),
    rank_list: load('rank_list'),
    rank_audio: load('rank_audio'),
    recommend_songs: load('recommend_songs'),
    everyday_style_recommend: load('everyday_style_recommend'),
    fm_recommend: load('fm_recommend'),
    fm_songs: load('fm_songs'),
    login_qr_key: load('login_qr_key'),
    login_qr_create: load('login_qr_create'),
    login_qr_check: load('login_qr_check'),
    user_detail: load('user_detail'),
    user_playlist: load('user_playlist'),
  }
}

export const createKugouApiClient = (
  api?: UpstreamApi,
  { request = createKugouRequest() }: { request?: KugouRequest } = {},
): KugouApi => {
  const upstream = api ?? loadPinnedApi()
  const call = (name: string) => async(params: Record<string, any> = {}) => {
    const fn = upstream[name]
    if (typeof fn != 'function') throw new Error(`KuGou API method unavailable: ${name}`)
    return fn({ ...params, cookie: { ...parseCookie(params.cookie), ...deviceCookie } }, request)
  }
  return {
    topPlaylist: call('top_playlist'),
    rankList: call('rank_list'),
    rankAudio: call('rank_audio'),
    recommendSongs: call('recommend_songs'),
    everydayStyleRecommend: call('everyday_style_recommend'),
    fmRecommend: call('fm_recommend'),
    fmSongs: call('fm_songs'),
    loginQrKey: call('login_qr_key'),
    loginQrCreate: call('login_qr_create'),
    loginQrCheck: call('login_qr_check'),
    userInfo: call('user_detail'),
    userPlaylist: call('user_playlist'),
  }
}
