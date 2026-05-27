import { onMounted, onBeforeUnmount } from '@common/utils/vueTools'
import { useRoute, useRouter } from '@common/utils/vueRouter'
import { setListPosition, getListPosition } from '@renderer/utils/data'
import { appSetting } from '@renderer/store/setting'

export default ({ props, listRef, list, handleRestoreScroll }) => {
  const route = useRoute()
  const router = useRouter()

  const saveListPosition = () => {
    setListPosition(props.listId, listRef.value?.getScrollTop() || 0)
  }

  const scrollToListIndex = (index, isAnimation, callback = () => {}) => {
    const scrollPromise = listRef.value?.scrollToIndex(index, -150, isAnimation)
    if (!scrollPromise) {
      callback()
      return Promise.resolve()
    }
    return scrollPromise.then(callback).catch(() => {})
  }

  const restoreScroll = async(index, isAnimation) => {
    // console.log(index, isAnimation)
    if (!list.value.length) return
    if (index == null) {
      let location = await getListPosition(props.listId) || 0
      if (appSetting['list.isSaveScrollLocation'] && location != null) {
        listRef.value?.scrollTo(location)
      }
      return
    }

    scrollToListIndex(index, isAnimation)
  }

  onMounted(() => {
    handleRestoreScroll(route.query.scrollIndex, false)
    if (route.query.scrollIndex != null) {
      router.replace({
        path: '/list',
        query: {
          id: props.listId,
          updated: true,
        },
      })
    }
  })
  onBeforeUnmount(() => {
    saveListPosition()
  })

  return {
    saveListPosition,
    restoreScroll,
    scrollToListIndex,
  }
}
