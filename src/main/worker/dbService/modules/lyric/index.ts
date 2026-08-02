import { migrateRawLyrics } from '../../../../migration/cache/rawLyrics'
import * as edited from './edited/repository'
import * as raw from './raw/repository'

export const getPlayerLyric = async(input: { provider: string, sourceTrackId: string, nowMs: number }): Promise<LX.Player.LyricInfo> => {
  const lyric = edited.getEditedLyric(input.sourceTrackId)
  const rawlrcInfo = await raw.rawLyricGet(input)
  const rawInfo = rawlrcInfo.status == 'hit' ? rawlrcInfo.value : { lyric: '' }
  return lyric.lyric ? { ...lyric, rawlrcInfo: rawInfo } : { ...rawInfo, rawlrcInfo: rawInfo }
}

export const getRawLyric = raw.rawLyricGet
export const rawLyricAdd = raw.rawLyricPut
export const rawLyricClear = raw.rawLyricClear
export const rawLyricCount = raw.rawLyricCount
export const getEditedLyric = edited.getEditedLyric
export const editedLyricAdd = edited.editedLyricAdd
export const editedLyricRemove = edited.editedLyricRemove
export const editedLyricUpdate = edited.editedLyricUpdate
export const editedLyricClear = edited.editedLyricClear
export const editedLyricUpdateAddAndUpdate = edited.editedLyricUpdateAddAndUpdate
export const editedLyricCount = edited.editedLyricCount
export { migrateRawLyrics }
