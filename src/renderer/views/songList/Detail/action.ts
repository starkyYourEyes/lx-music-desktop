import { tempListMeta, userLists } from '@renderer/store/list/state'
import { dialog } from '@renderer/plugins/Dialog'
import { importSourceList } from '@renderer/store/list/importSourceList'
import { getListDetail, getListDetailAll } from '@renderer/store/songList/action'
import { setTempList } from '@renderer/store/list/action'
import { playList } from '@renderer/core/player/action'
import { LIST_IDS } from '@common/constants'
import { DAILY_RECOMMEND_TEMP_LIST_ID } from '@renderer/store/dailyRecommend/state'
import { getQQMusicAccountKey } from '@renderer/store/qqMusic'
import { playQQDailyRecommend } from '@renderer/store/qqDailyRecommend/action'
import { QQ_DAILY_RECOMMEND_LIST_ID } from '@renderer/store/qqDailyRecommend/state'

const getListId = (id: string, source: LX.OnlineSource) => `${source}__${id}`
const getTempListId = (id: string, source: LX.OnlineSource) => source == 'wy' && id == DAILY_RECOMMEND_TEMP_LIST_ID
  ? DAILY_RECOMMEND_TEMP_LIST_ID
  : getListId(id, source)

export const addSongListDetail = async(id: string, source: LX.OnlineSource, name?: string) => {
  const targetList = userLists.find(l => l.source == source && l.sourceListId == id && !l.id.startsWith('platform:'))
  if (targetList) {
    const confirm = await dialog.confirm({
      message: window.i18n.t('duplicate_list_tip', { name: targetList.name }),
      cancelButtonText: window.i18n.t('lists__import_part_button_cancel'),
      confirmButtonText: window.i18n.t('confirm_button_text'),
    })
    if (!confirm) return
  }

  return importSourceList({
    name: targetList?.name ?? name,
    id: targetList?.id,
    source,
    sourceListId: id,
  })
}

export const playSongListDetail = async(id: string, source: LX.OnlineSource, list?: LX.Music.MusicInfoOnline[], index: number = 0) => {
  if (source == 'tx' && id == QQ_DAILY_RECOMMEND_LIST_ID) {
    const accountKey = getQQMusicAccountKey()
    if (!accountKey) return
    await playQQDailyRecommend(accountKey, index)
    return
  }

  let isPlayingList = false
  // console.log(list)
  const listId = getTempListId(id, source)
  if (!list?.length) list = (await getListDetail(id, source, 1)).list
  if (list?.length) {
    await setTempList(listId, [...list])
    playList(LIST_IDS.TEMP, index)
    isPlayingList = true
  }
  const fullList = await getListDetailAll(id, source)
  if (!fullList.length) return
  if (isPlayingList) {
    if (tempListMeta.id == listId) {
      await setTempList(listId, [...fullList])
    }
  } else {
    await setTempList(listId, [...fullList])
    playList(LIST_IDS.TEMP, index)
  }
}
