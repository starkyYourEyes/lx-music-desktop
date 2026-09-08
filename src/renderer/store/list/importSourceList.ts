import { userLists } from './state'
import { createUserList, overwriteListMusics, setUpdateTime } from './action'
import { getListDetailAll } from '@renderer/store/songList/action'
import { setListUpdateTime } from '@renderer/utils/data'
import { dateFormat } from '@common/utils/common'
import { toMD5 } from '@renderer/utils'

export const importSourceList = async({
  sourceListId,
  source,
  id = `${source}_${toMD5(`${source}__${sourceListId}`)}`,
  name,
  reveal = true,
  canCommit = () => true,
}: {
  sourceListId: string
  source: LX.OnlineSource
  id?: string
  name?: string
  reveal?: boolean
  canCommit?: () => boolean
}): Promise<string | undefined> => {
  if (!canCommit()) return
  const existing = userLists.find(item => item.id == id)
  const list = await getListDetailAll(sourceListId, source, !!existing)
  if (!canCommit()) return
  if (existing) {
    await overwriteListMusics({ listId: id, musicInfos: list })
  } else {
    await createUserList({ id, name, list, source, sourceListId, reveal })
  }
  if (!canCommit()) return
  const now = Date.now()
  await setListUpdateTime(id, now)
  if (!canCommit()) return
  setUpdateTime(id, dateFormat(now))
  return id
}
