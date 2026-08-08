import { toRaw } from '@common/utils/vueTools'
import { showSelectDialog } from '@renderer/utils/ipc'
import { useI18n } from '@renderer/plugins/i18n'
import { filterFileName, toNewMusicInfo, fixNewMusicInfoQuality, filterMusicList } from '@renderer/utils'
import { getListMusics, updateUserList, overwriteListMusics, createUserList } from '@renderer/store/list/action'
import { getUserListGroup, requestUserListReveal } from '@renderer/store/list/group'
import { defaultList, loveList, userLists } from '@renderer/store/list/state'
import useImportTip from '@renderer/utils/compositions/useImportTip'
import { dialog } from '@renderer/plugins/Dialog'
import { BACKUP_IMPORT_EXTENSIONS, createPlaylistPartBackupName } from '@common/backupFormats'
import useBackupExport from '@renderer/utils/compositions/useBackupExport'


export default () => {
  const t = useI18n()
  const showImportTip = useImportTip()
  const saveBackup = useBackupExport()

  const handleExportList = async(listInfo: LX.List.MyListInfo) => {
    if (!listInfo) return
    await saveBackup({
      title: t('lists__export_part_desc'),
      defaultPath: createPlaylistPartBackupName(filterFileName(listInfo.name)),
    }, async() => {
      const data = { ...toRaw(listInfo), list: toRaw(await getListMusics(listInfo.id)) }
      return {
        type: 'playListPart_v2',
        data: listInfo.id == defaultList.id || listInfo.id == loveList.id
          ? data
          : { ...data, group: getUserListGroup(listInfo as LX.List.UserListInfo) },
      }
    })
  }
  const handleImportList = async(listInfo: LX.List.MyListInfo) => {
    const result = await showSelectDialog({
      title: t('lists__import_part_desc'),
      properties: ['openFile'],
      filters: [
        { name: 'Play List Part', extensions: [...BACKUP_IMPORT_EXTENSIONS] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (result.canceled) return
    const filePath = result.filePaths[0]
    if (!filePath) return
    let configData: any
    try {
      configData = await window.lx.worker.main.readLxConfigFile(filePath)
    } catch (error) {
      return
    }
    let listData: LX.ConfigFile.MyListInfoPart['data']
    let normalizedMusic: LX.Music.MusicInfo[]
    switch (configData.type) {
      case 'playListPart':
        listData = configData.data
        normalizedMusic = filterMusicList(listData.list.map(m => toNewMusicInfo(m)))
        break
      case 'playListPart_v2':
        listData = configData.data
        normalizedMusic = filterMusicList(listData.list).map(m => fixNewMusicInfoQuality(m))
        break
      default:
        showImportTip(configData.type)
        return
    }

    const targetList = [defaultList, loveList, ...userLists].find(l => l.id == listData.id)
    if (targetList) {
      const confirm = await dialog.confirm({
        message: t('lists__import_part_confirm', { importName: listData.name, localName: targetList.name }),
        cancelButtonText: t('lists__import_part_button_cancel'),
        confirmButtonText: t('lists__import_part_button_confirm'),
      })
      if (confirm) {
        listData.name = targetList.name
        switch (listData.id) {
          case defaultList.id:
          case loveList.id:
            break
          default:
            await updateUserList([
              {
                name: listData.name,
                id: listData.id,
                source: (listData as LX.List.UserListInfo).source,
                sourceListId: (listData as LX.List.UserListInfo).sourceListId,
                locationUpdateTime: (targetList as LX.List.UserListInfo).locationUpdateTime,
              },
            ])
            break
        }
        await overwriteListMusics({ listId: listData.id, musicInfos: normalizedMusic })
        requestUserListReveal(targetList.id)
        return
      }
      listData.id += `__${Date.now()}`
    }
    await createUserList({
      name: listData.name,
      id: listData.id,
      source: (listData as LX.List.UserListInfo).source,
      sourceListId: (listData as LX.List.UserListInfo).sourceListId,
      group: 'external',
      list: normalizedMusic,
    })
  }

  return {
    handleExportList,
    handleImportList,
  }
}
