import { partitionUserLists } from '@common/listGroup'
import { computed, nextTick, ref, watch } from '@common/utils/vueTools'
import { ensureUserListGroups, getUserListGroup, userListRevealRequest } from '@renderer/store/list/group'
import { loadMyListGroupCollapsed, saveMyListGroupCollapsed, type MyListGroupCollapsed } from './groupState'

const groupKeys: LX.List.UserListGroup[] = ['mine', 'external']

export default ({
  userLists,
  activeListId,
  scrollToList,
}: {
  userLists: LX.List.UserListInfo[]
  activeListId: () => string
  scrollToList: (id: string) => void
}) => {
  const collapsed = ref<MyListGroupCollapsed>(loadMyListGroupCollapsed())
  const groups = computed(() => {
    const lists = partitionUserLists(userLists, getUserListGroup)
    return {
      mine: { key: 'mine' as const, lists: lists.mine, count: lists.mine.length + 1 },
      external: { key: 'external' as const, lists: lists.external, count: lists.external.length },
    }
  })

  const save = () => {
    saveMyListGroupCollapsed(undefined, collapsed.value)
  }
  const toggle = (group: LX.List.UserListGroup) => {
    collapsed.value[group] = !collapsed.value[group]
    save()
  }
  const expand = (group: LX.List.UserListGroup) => {
    if (!collapsed.value[group]) return
    collapsed.value[group] = false
    save()
  }
  const resolveGroup = (id: string): LX.List.UserListGroup | null => {
    if (id == 'love') return 'mine'
    const list = userLists.find(item => item.id == id)
    return list ? getUserListGroup(list) : null
  }
  const reveal = async(id: string) => {
    if (!id) return
    const group = resolveGroup(id)
    if (!group) return
    expand(group)
    await nextTick()
    scrollToList(id)
  }

  watch(activeListId, id => { void reveal(id) }, { immediate: true })
  watch(() => userListRevealRequest.value, request => {
    if (request) void reveal(request.id)
  }, { immediate: true })
  watch(() => userLists.map(list => `${list.id}:${list.source ?? ''}:${list.sourceListId ?? ''}`).join(','), () => {
    void ensureUserListGroups(userLists)
  }, { immediate: true })

  return { groups, collapsed, toggle, expand, reveal, groupKeys }
}
