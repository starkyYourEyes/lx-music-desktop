import { ref, watch } from '@common/utils/vueTools'
import { dialog } from '@renderer/plugins/Dialog'
import syncSourceList from '@renderer/store/list/syncSourceList'
import { useI18n } from '@renderer/plugins/i18n'
import { refreshPlatformUserPlaylists, retryPlatformUserPlaylistGroup } from '@renderer/store/platformPlaylists/action'
import { getListUpdateInfo } from '@renderer/utils/data'


export default () => {
  const isShowListUpdateModal = ref(false)

  const t = useI18n()

  const handleUpdateSourceList = (listInfo: LX.List.UserListInfo) => {
    if (listInfo.id.startsWith('platform:')) {
      void getListUpdateInfo().then(async metadata => {
        const profile = metadata[listInfo.id]?.profile
        if (profile?.managed && profile.provider && profile.kind) await retryPlatformUserPlaylistGroup(profile.provider, profile.kind)
      })
      return
    }
    void dialog.confirm({
      message: t('lists__sync_confirm_tip', { name: listInfo.name }),
      confirmButtonText: t('lists__remove_tip_button'),
    }).then(isSync => {
      if (!isSync) return
      void syncSourceList(listInfo)
    })
  }

  const handleRefreshAll = () => {
    void refreshPlatformUserPlaylists({ force: true })
  }

  watch(isShowListUpdateModal, visible => {
    if (visible) handleRefreshAll()
  })

  return {
    isShowListUpdateModal,
    handleUpdateSourceList,
    handleRefreshAll,
  }
}
