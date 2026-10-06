import { ref, watch, computed, onBeforeUnmount } from '@common/utils/vueTools'
import { playMusicInfo, playInfo } from '@renderer/store/player/state'
import { getListMusics } from '@renderer/store/list/action'
import { appSetting } from '@renderer/store/setting'
import { retainMusicList } from '@renderer/store/list/listManage/state'


export default ({ props, onLoadedList }) => {
  const rightClickSelectedIndex = ref(-1)
  const selectedIndex = ref(-1)
  const dom_listContent = ref(null)
  const listRef = ref(null)

  const excludeListIds = computed(() => ([props.listId]))


  const list = ref([])
  let releaseList = () => {}
  let disposed = false
  watch(() => props.listId, id => {
    const releasePrevious = releaseList
    releaseList = retainMusicList(id)
    releasePrevious()
    getListMusics(id).then(l => {
      if (disposed || id != props.listId) return
      list.value = [...l]
      onLoadedList()
    })
  }, {
    immediate: true,
  })

  const playerInfo = computed(() => ({
    isPlayList: playMusicInfo.listId == props.listId,
    playIndex: playInfo.playIndex,
  }))

  const setSelectedIndex = index => {
    selectedIndex.value = index
  }

  const isShowSource = computed(() => appSetting['list.isShowSource'])

  const handleMyListUpdate = (ids) => {
    if (!ids.includes(props.listId)) return
    const id = props.listId
    getListMusics(id).then(l => {
      if (disposed || id != props.listId) return
      list.value = [...l]
    })
  }

  window.app_event.on('myListUpdate', handleMyListUpdate)

  onBeforeUnmount(() => {
    disposed = true
    releaseList()
    window.app_event.off('myListUpdate', handleMyListUpdate)
  })

  return {
    rightClickSelectedIndex,
    selectedIndex,
    dom_listContent,
    listRef,
    list,
    playerInfo,
    setSelectedIndex,
    isShowSource,
    excludeListIds,
  }
}
