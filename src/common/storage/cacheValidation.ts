import type {
  MusicUrlAccountInvalidationV1,
  MusicUrlGetInputV1,
  MusicUrlPutInputV1,
  MusicUrlSourceInvalidationV1,
  OtherSourcesGetInputV1,
  OtherSourcesPutInputV1,
} from './cache'

type PlainData = Record<string, unknown>

const textBytes = (value: string): number => new TextEncoder().encode(value).byteLength
const controlCharacters = /[\u0000-\u001f\u007f]/

const fixedError = <C extends string>(code: C): Error & { code: C } => Object.assign(new Error(code), { code })
const invalidMusicUrl = (): Error & { code: 'music_url_input_invalid' } => fixedError('music_url_input_invalid')
const invalidOtherSources = (): Error & { code: 'other_sources_input_invalid' } => fixedError('other_sources_input_invalid')

const readPlainData = (value: unknown, required: readonly string[], optional: readonly string[] = []): PlainData | null => {
  if (value == null || typeof value != 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some(key => typeof key != 'string') || required.some(key => !Object.hasOwn(descriptors, key)) ||
    keys.some(key => typeof key == 'string' && !required.includes(key) && !optional.includes(key))) return null
  const result: PlainData = {}
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
    result[key] = descriptor.value
  }
  return result
}

const validText = (value: unknown, maxBytes = 1024): value is string =>
  typeof value == 'string' && value.length > 0 && value == value.trim() &&
  !controlCharacters.test(value) && textBytes(value) <= maxBytes

const validNow = (value: unknown): value is number =>
  typeof value == 'number' && Number.isSafeInteger(value) && value >= 0

const validProfileUin = (value: unknown): value is string => validText(value, 128)

const validAccountScope = (value: unknown): value is string => {
  if (typeof value != 'string') return false
  const userId = /^profile-v1:user-id:([1-9]\d*)$/.exec(value)?.[1]
  if (userId != null) return Number.isSafeInteger(Number(userId))
  const uin = value.startsWith('profile-v1:uin:') ? value.slice('profile-v1:uin:'.length) : null
  return uin != null && validProfileUin(uin)
}

const parseMusicUrlKey = (value: PlainData): Omit<MusicUrlGetInputV1, 'nowMs'> | null => {
  if (!validText(value.provider, 128) || !validAccountScope(value.accountScope) ||
    !validText(value.sourceTrackId) || !validText(value.quality, 128)) return null
  return {
    provider: value.provider,
    accountScope: value.accountScope,
    sourceTrackId: value.sourceTrackId,
    quality: value.quality,
  }
}

export const parseMusicUrlGetInput = (value: unknown): MusicUrlGetInputV1 => {
  const data = readPlainData(value, ['provider', 'accountScope', 'sourceTrackId', 'quality', 'nowMs'])
  const key = data == null ? null : parseMusicUrlKey(data)
  if (data == null || key == null || !validNow(data.nowMs)) throw invalidMusicUrl()
  return { ...key, nowMs: data.nowMs }
}

export const parseMusicUrlPutInput = (value: unknown): MusicUrlPutInputV1 => {
  const data = readPlainData(
    value,
    ['provider', 'accountScope', 'sourceTrackId', 'quality', 'url', 'nowMs'],
    ['providerExpiresAtMs'],
  )
  const key = data == null ? null : parseMusicUrlKey(data)
  if (data == null || key == null || !validNow(data.nowMs) || typeof data.url != 'string' ||
    data.url.length == 0 || textBytes(data.url) > 8192 ||
    (data.providerExpiresAtMs != null && !validNow(data.providerExpiresAtMs))) throw invalidMusicUrl()
  return {
    ...key,
    url: data.url,
    nowMs: data.nowMs,
    ...(data.providerExpiresAtMs == null ? {} : { providerExpiresAtMs: data.providerExpiresAtMs }),
  }
}

const parseTrackIdentity = (value: PlainData): Omit<OtherSourcesGetInputV1, 'nowMs'> | null => {
  if (!validText(value.originalProvider, 128) || !validText(value.originalTrackId)) return null
  return { originalProvider: value.originalProvider, originalTrackId: value.originalTrackId }
}

export const parseOtherSourcesGetInput = (value: unknown): OtherSourcesGetInputV1 => {
  const data = readPlainData(value, ['originalProvider', 'originalTrackId', 'nowMs'])
  const identity = data == null ? null : parseTrackIdentity(data)
  if (data == null || identity == null || !validNow(data.nowMs)) throw invalidOtherSources()
  return { ...identity, nowMs: data.nowMs }
}

export const parseOtherSourcesPutInput = (value: unknown): OtherSourcesPutInputV1 => {
  const data = readPlainData(value, ['originalProvider', 'originalTrackId', 'candidates', 'nowMs'])
  const identity = data == null ? null : parseTrackIdentity(data)
  if (data == null || identity == null || !validNow(data.nowMs) || !Array.isArray(data.candidates) ||
    Object.getPrototypeOf(data.candidates) !== Array.prototype ||
    Reflect.ownKeys(Object.getOwnPropertyDescriptors(data.candidates)).length != data.candidates.length + 1) {
    throw invalidOtherSources()
  }
  return { ...identity, candidates: data.candidates as LX.Music.MusicInfoOnline[], nowMs: data.nowMs }
}

export const parseMusicUrlAccountInvalidation = (value: unknown): MusicUrlAccountInvalidationV1 => {
  const data = readPlainData(value, ['provider', 'accountScope'])
  if (data == null || !validText(data.provider, 128) || !validAccountScope(data.accountScope)) throw invalidMusicUrl()
  return { provider: data.provider, accountScope: data.accountScope }
}

export const parseMusicUrlSourceInvalidation = (value: unknown): MusicUrlSourceInvalidationV1 => {
  const data = readPlainData(value, ['provider'])
  if (data == null || !validText(data.provider, 128)) throw invalidMusicUrl()
  return { provider: data.provider }
}

export const neteaseAccountScope = (profile: unknown): string | null => {
  const data = readPlainData(profile, ['userId'], ['nickname', 'avatarUrl', 'backgroundUrl', 'signature'])
  if (data == null || typeof data.userId != 'number' || !Number.isSafeInteger(data.userId) || data.userId <= 0) return null
  return `profile-v1:user-id:${data.userId}`
}

export const qqMusicAccountScope = (profile: unknown): string | null => {
  const data = readPlainData(profile, ['uin'], ['nickname'])
  return data != null && validProfileUin(data.uin) ? `profile-v1:uin:${data.uin}` : null
}
