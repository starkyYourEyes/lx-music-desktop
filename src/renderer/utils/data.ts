/* eslint-disable @typescript-eslint/no-dynamic-delete */
import {
  getCatalogPreferences,
  getLocalState,
  getPlaylistMetadata,
  mutatePlaylistMetadata,
  setCatalogPreference,
  setLocalState,
} from '@renderer/utils/storageState'
import { throttle } from '@common/utils'
import { type DEFAULT_SETTING, LIST_IDS } from '@common/constants'
import type { CatalogPreferencesV1 } from '@common/storage/stateContracts'
import { dateFormat } from './index'
import { setUpdateTime } from '@renderer/store/list/action'

let listPosition: LX.List.ListPositionInfo
let listPrevSelectId: string
let listUpdateInfo: LX.List.ListUpdateInfo

let searchSetting: CatalogPreferencesV1['search']
let songListSetting: CatalogPreferencesV1['songList']
let leaderboardSetting: CatalogPreferencesV1['leaderboard']

const saveListPositionThrottle = throttle(() => {
  void setLocalState({
    version: 1,
    key: 'list_scroll_positions',
    value: listPosition,
    updatedAtMs: Date.now(),
  })
}, 1000)
const saveSearchSettingThrottle = throttle(() => {
  void setCatalogPreference('search', searchSetting)
}, 1000)
const saveSongListSettingThrottle = throttle(() => {
  void setCatalogPreference('songList', songListSetting)
}, 1000)
const saveLeaderboardSettingThrottle = throttle(() => {
  void setCatalogPreference('leaderboard', leaderboardSetting)
}, 1000)
const saveViewPrevStateThrottle = throttle((state) => {
  void setLocalState({
    version: 1,
    key: 'view_prev_state',
    value: state,
    updatedAtMs: Date.now(),
  })
}, 1000)

const applyCatalogPreferences = (preferences: Awaited<ReturnType<typeof getCatalogPreferences>>) => {
  leaderboardSetting = preferences.leaderboard
  songListSetting = preferences.songList
  searchSetting = preferences.search
}

const initCatalogPreferences = async() => {
  if (leaderboardSetting && songListSetting && searchSetting) return
  applyCatalogPreferences(await getCatalogPreferences())
}

const initPosition = async() => {
  // eslint-disable-next-line require-atomic-updates
  listPosition ??= (await getLocalState()).listScrollPosition
}
export const getListPosition = async(id: string): Promise<number> => {
  await initPosition()
  return listPosition[id] ?? 0
}
export const setListPosition = async(id: string, position?: number) => {
  await initPosition()
  listPosition[id] = position ?? 0
  saveListPositionThrottle()
}
export const removeListPosition = async(id: string) => {
  await initPosition()
  if (listPosition[id] == null) return
  delete listPosition[id]
  saveListPositionThrottle()
}
export const overwriteListPosition = async(ids: string[]) => {
  await initPosition()
  const removedIds = []
  for (const id of Object.keys(listPosition)) {
    if (ids.includes(id)) continue
    removedIds.push(id)
  }
  for (const id of removedIds) delete listPosition[id]
  saveListPositionThrottle()
}

const saveListPrevSelectIdThrottle = throttle(() => {
  void setLocalState({
    version: 1,
    key: 'list_prev_select_id',
    value: listPrevSelectId,
    updatedAtMs: Date.now(),
  })
}, 200)
export const getListPrevSelectId = async() => {
  // eslint-disable-next-line require-atomic-updates
  listPrevSelectId ??= (await getLocalState()).listPrevSelectId ?? LIST_IDS.DEFAULT
  return listPrevSelectId ?? LIST_IDS.DEFAULT
}
export const saveListPrevSelectId = (id: string) => {
  listPrevSelectId = id
  saveListPrevSelectIdThrottle()
}

const initListUpdateInfo = async() => {
  if (listUpdateInfo == null) {
    // eslint-disable-next-line require-atomic-updates
    listUpdateInfo = await getPlaylistMetadata()
    for (const [id, info] of Object.entries(listUpdateInfo)) {
      setUpdateTime(id, info.updateTime ? dateFormat(info.updateTime) : '')
    }
  }
}
export const getListUpdateInfo = async() => {
  await initListUpdateInfo()
  return listUpdateInfo
}
export const setListUpdateInfo = async(info: LX.List.ListUpdateInfo) => {
  await initListUpdateInfo()
  const playlistIds = Object.keys(info)
  for (const [playlistId, value] of Object.entries(info)) {
    listUpdateInfo = await mutatePlaylistMetadata({
      version: 1,
      action: 'upsert',
      playlistId,
      value,
      updatedAtMs: Date.now(),
    })
  }
  listUpdateInfo = await mutatePlaylistMetadata({ version: 1, action: 'retain', playlistIds })
}
export const setListAutoUpdate = async(id: string, enable: boolean) => {
  await initListUpdateInfo()
  const targetInfo = listUpdateInfo[id] ?? { updateTime: 0, isAutoUpdate: false }
  targetInfo.isAutoUpdate = enable
  listUpdateInfo = await mutatePlaylistMetadata({
    version: 1,
    action: 'upsert',
    playlistId: id,
    value: targetInfo,
    updatedAtMs: Date.now(),
  })
}
export const setListUpdateTime = async(id: string, time: number) => {
  await initListUpdateInfo()
  const targetInfo = listUpdateInfo[id] ?? { updateTime: 0, isAutoUpdate: false }
  targetInfo.updateTime = time
  listUpdateInfo = await mutatePlaylistMetadata({
    version: 1,
    action: 'upsert',
    playlistId: id,
    value: targetInfo,
    updatedAtMs: Date.now(),
  })
}
export const setUserListProfile = async(id: string, profile: LX.List.UserListProfile) => {
  await initListUpdateInfo()
  const targetInfo = listUpdateInfo[id] ?? { updateTime: 0, isAutoUpdate: false }
  targetInfo.profile = {
    ...targetInfo.profile,
    ...profile,
  }
  listUpdateInfo = await mutatePlaylistMetadata({
    version: 1,
    action: 'upsert',
    playlistId: id,
    value: targetInfo,
    updatedAtMs: Date.now(),
  })
}
// export const setListUpdateInfo = (id, { updateTime, isAutoUpdate }) => {
//   listUpdateInfo[id] = { updateTime, isAutoUpdate }
//   saveListUpdateInfo()
// }
export const removeListUpdateInfo = async(id: string) => {
  await initListUpdateInfo()
  if (listUpdateInfo[id] == null) return
  listUpdateInfo = await mutatePlaylistMetadata({ version: 1, action: 'remove', playlistId: id })
}
export const overwriteListUpdateInfo = async(ids: string[]) => {
  await initListUpdateInfo()
  listUpdateInfo = await mutatePlaylistMetadata({ version: 1, action: 'retain', playlistIds: ids })
}


export const getSearchSetting = async() => {
  await initCatalogPreferences()
  return { ...searchSetting }
}
export const setSearchSetting = async(setting: Partial<typeof DEFAULT_SETTING['search']>) => {
  if (!searchSetting) await getSearchSetting()
  let requiredSave = false
  if (setting.source && searchSetting.source != setting.source) requiredSave = true
  if (setting.type && searchSetting.type != setting.type) requiredSave = true
  if (setting.temp_source && searchSetting.temp_source != setting.temp_source) requiredSave = true

  if (!requiredSave) return
  searchSetting = Object.assign(searchSetting, setting) as CatalogPreferencesV1['search']
  saveSearchSettingThrottle()
}

export const getSongListSetting = async() => {
  await initCatalogPreferences()
  return { ...songListSetting }
}
export const setSongListSetting = async(setting: Partial<typeof DEFAULT_SETTING['songList']>) => {
  if (!songListSetting) await getSongListSetting()
  songListSetting = Object.assign(songListSetting, setting) as CatalogPreferencesV1['songList']
  saveSongListSettingThrottle()
}

export const getLeaderboardSetting = async() => {
  await initCatalogPreferences()
  return { ...leaderboardSetting }
}
export const setLeaderboardSetting = async(setting: Partial<typeof DEFAULT_SETTING['leaderboard']>) => {
  if (!leaderboardSetting) await getLeaderboardSetting()
  leaderboardSetting = Object.assign(leaderboardSetting, setting) as CatalogPreferencesV1['leaderboard']
  saveLeaderboardSettingThrottle()
}

export const saveViewPrevState = (state: typeof DEFAULT_SETTING['viewPrevState']) => {
  saveViewPrevStateThrottle(state)
}
