import { computed, ref, reactive, nextTick } from '@common/utils/vueTools'
import { useI18n } from '@renderer/plugins/i18n'
import { defaultList, loveList, userLists, webDAVList } from '@renderer/store/list/state'
import { getUserListGroup, requestUserListReveal } from '@renderer/store/list/group'
import { dialog } from '@renderer/plugins/Dialog'
import musicSdk from '@renderer/utils/musicSdk'
import { addLocalFile, addWebDAVMusics, refreshWebDAVMusics } from './actions'
import { moveUserList } from './groupActions'

export default ({
  emit,

  handleRename,
  handleDuplicateList,
  handleSortList,
  handleOpenSourceDetailPage,
  handleImportList,
  handleExportList,
  handleUpdateSourceList,
  handleRemove,
}) => {
  const menuControl = reactive({
    rename: true,
    duplicate: true,
    sort: true,
    local_file: true,
    webdav_file: true,
    webdav_refresh: true,
    sourceDetail: true,
    import: true,
    export: true,
    sync: false,
    remove: true,
  })
  const t = useI18n()
  const menuLocation = reactive({ x: 0, y: 0 })
  const isShowMenu = ref(false)
  const moveGroup = ref(null)

  const menus = computed(() => {
    const items = [
      {
        name: t('lists__rename'),
        action: 'rename',
        disabled: !menuControl.rename,
      },
      {
        name: t('lists__sort_list'),
        action: 'sort',
        disabled: !menuControl.sort,
      },
      {
        name: t('lists__duplicate'),
        action: 'duplicate',
        disabled: !menuControl.duplicate,
      },
      {
        name: t('lists__select_local_file'),
        action: 'local_file',
        disabled: !menuControl.local_file,
      },
      {
        name: '添加 WebDAV 音乐',
        action: 'webdav_file',
        disabled: !menuControl.webdav_file,
      },
      {
        name: '刷新云盘',
        action: 'webdav_refresh',
        disabled: !menuControl.webdav_refresh,
      },
      {
        name: t('lists__sync'),
        action: 'sync',
        disabled: !menuControl.sync,
      },
      {
        name: t('lists__source_detail'),
        action: 'sourceDetail',
        disabled: !menuControl.sourceDetail,
      },
      {
        name: t('lists__import'),
        action: 'import',
        disabled: !menuControl.export,
      },
      {
        name: t('lists__export'),
        action: 'export',
        disabled: !menuControl.export,
      },
      {
        name: t('lists__remove'),
        action: 'remove',
        disabled: !menuControl.remove,
      },
    ]
    if (moveGroup.value) {
      items.push({
        name: t('lists__move_to_group', { name: t(`lists__group_${moveGroup.value}`) }),
        action: 'move_group',
        group: moveGroup.value,
        disabled: false,
      })
    }
    return items
  })

  const assertSupportDetail = (listInfo) => {
    const { source, sourceListId } = listInfo
    if (source) {
      if (sourceListId) {
        if (/board__/.test(sourceListId)) {
          // const id = sourceListId.replace(/board__/, '')
          return !!musicSdk[source]?.leaderboard?.getDetailPageUrl
        } else {
          return !!musicSdk[source]?.songList?.getDetailPageUrl
        }
      }
    }
    return false
  }

  const showMenu = (event, listInfo) => {
    const { source } = listInfo
    switch (listInfo.id) {
      case webDAVList.id:
        menuControl.rename = false
        menuControl.remove = false
        menuControl.sync = false
        menuControl.local_file = false
        menuControl.webdav_file = false
        menuControl.webdav_refresh = true
        break
      case loveList.id:
      case defaultList.id:
        menuControl.rename = false
        menuControl.remove = false
        menuControl.sync = false
        menuControl.local_file = true
        menuControl.webdav_file = true
        menuControl.webdav_refresh = false
        break
      default:
        menuControl.rename = true
        menuControl.remove = true
        menuControl.local_file = true
        menuControl.webdav_file = true
        menuControl.webdav_refresh = false
        menuControl.sync = !!source && !!musicSdk[source]?.songList
        break
    }
    moveGroup.value = userLists.some(item => item.id == listInfo.id)
      ? getUserListGroup(listInfo) == 'mine' ? 'external' : 'mine'
      : null
    // menuControl.sort = !!getList(listInfo.id).length
    menuControl.sourceDetail = assertSupportDetail(listInfo)

    menuLocation.x = event.pageX
    menuLocation.y = event.pageY

    if (isShowMenu.value) return
    emit('show-menu')
    nextTick(() => {
      isShowMenu.value = true
    })
  }

  const hideMenu = () => {
    isShowMenu.value = false
  }

  const menuClick = (action, listInfo) => {
    // console.log(action)
    hideMenu()
    if (!action) return
    switch (action.action) {
      case 'rename':
        handleRename(listInfo.id)
        break
      case 'duplicate':
        handleDuplicateList(listInfo)
        break
      case 'sort':
        handleSortList(listInfo)
        break
      case 'local_file':
        addLocalFile(listInfo)
        break
      case 'webdav_file':
        addWebDAVMusics(listInfo)
        break
      case 'webdav_refresh':
        refreshWebDAVMusics()
        break
      case 'sourceDetail':
        handleOpenSourceDetailPage(listInfo)
        break
      case 'import':
        handleImportList(listInfo)
        break
      case 'export':
        handleExportList(listInfo)
        break
      case 'sync':
        handleUpdateSourceList(listInfo)
        break
      case 'remove':
        handleRemove(listInfo)
        break
      case 'move_group': {
        if (!userLists.some(item => item.id == listInfo.id)) break
        const request = {
          id: listInfo.id,
          toGroup: action.group,
          toIndex: userLists.filter(item => getUserListGroup(item) == action.group).length,
        }
        moveUserList(request)
          .then(() => requestUserListReveal(request.id))
          .catch(() => {
            dialog(t('lists__move_group_failed'))
          })
        break
      }
    }
  }

  return {
    menus,
    menuLocation,
    isShowMenu,
    showMenu,
    menuClick,
  }
}
