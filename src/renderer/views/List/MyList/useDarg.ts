import { onBeforeUnmount, ref, type Ref, useCssModule } from '@common/utils/vueTools'
import useDarg from '@renderer/utils/compositions/useDrag'
import { dialog } from '@renderer/plugins/Dialog'
import { useI18n } from '@renderer/plugins/i18n'
import { requestUserListReveal } from '@renderer/store/list/group'
import { moveUserList } from './groupActions'


export default ({ dom_mine_list, dom_external_list, handleSaveListName, handleMenuClick, expand, isGroupCollapsed, getGroupListLength }: {
  dom_mine_list: Ref<HTMLElement | null>
  dom_external_list: Ref<HTMLElement | null>
  handleSaveListName: () => Promise<void> | void
  handleMenuClick: () => void
  expand: (group: LX.List.UserListGroup) => void
  isGroupCollapsed: (group: LX.List.UserListGroup) => boolean
  getGroupListLength: (group: LX.List.UserListGroup) => number
}) => {
  const isModDown = ref(false)
  const styles = useCssModule()
  const t = useI18n()
  let headingTimer: ReturnType<typeof setTimeout> | null = null
  let headingGroup: LX.List.UserListGroup | null = null
  const collapsedDropGroups = new Set<LX.List.UserListGroup>()

  const clearHeadingState = () => {
    if (headingTimer) clearTimeout(headingTimer)
    headingTimer = null
    headingGroup = null
    collapsedDropGroups.clear()
  }

  const restoreItem = (event: { item: HTMLElement, from: HTMLElement, oldDraggableIndex: number }) => {
    event.item.remove()
    const rows = event.from.querySelectorAll<HTMLElement>('.user-list')
    const target = rows[event.oldDraggableIndex]
    if (target) event.from.insertBefore(event.item, target)
    else event.from.insertBefore(event.item, event.from.querySelector('.new-list-input'))
  }
  const handleMove = (event: { to: HTMLElement, related?: HTMLElement | null }) => {
    const group = event.to.dataset.group as LX.List.UserListGroup
    if ((group != 'mine' && group != 'external') || !event.related?.matches('.my-list-group-heading')) {
      clearHeadingState()
      return true
    }
    if (!isGroupCollapsed(group)) {
      clearHeadingState()
      return true
    }
    if (headingGroup == group && headingTimer) return true
    clearHeadingState()
    collapsedDropGroups.add(group)
    headingGroup = group
    headingTimer = setTimeout(() => {
      expand(group)
      clearHeadingState()
    }, 400)
    return true
  }

  const createGroupDrag = (dom_list: Ref<HTMLElement | null>) => useDarg({
    dom_list,
    dragingItemClassName: styles.dragingItem,
    group: 'my-list-groups',
    draggable: '.user-list',
    filter: '.my-list-group-heading, .default-list',
    onMove: handleMove,
    onEnd: () => {
      clearHeadingState()
    },
    onAdd: handleDrop,
    onUpdate: handleDrop,
  })

  function handleDrop(event: { item: HTMLElement, from: HTMLElement, to: HTMLElement, newDraggableIndex: number, oldDraggableIndex: number }) {
    const toGroup = event.to.dataset.group as LX.List.UserListGroup
    const wasCollapsed = collapsedDropGroups.has(toGroup)
    clearHeadingState()
    const id = event.item.dataset.listId
    if (!id || (toGroup != 'mine' && toGroup != 'external')) return
    const toIndex = wasCollapsed && isGroupCollapsed(toGroup)
      ? getGroupListLength(toGroup)
      : event.newDraggableIndex
    const request = { id, toGroup, toIndex }
    void moveUserList(request).then(() => requestUserListReveal(request.id)).catch(() => {
      restoreItem(event)
      void dialog(t('lists__move_group_failed'))
    })
  }
  const mineDrag = createGroupDrag(dom_mine_list)
  const externalDrag = createGroupDrag(dom_external_list)

  const handle_key_mod_down = ({ event }: LX.KeyDownEevent) => {
    if (!isModDown.value) {
      // console.log(event)
      switch ((event!.target as HTMLElement).tagName) {
        case 'INPUT':
        case 'SELECT':
        case 'TEXTAREA':
          return
        default: if ((event!.target as HTMLElement).isContentEditable) return
      }

      isModDown.value = true
      mineDrag.setDisabled(false)
      externalDrag.setDisabled(false)
      void handleSaveListName()
    }
    handleMenuClick()
  }
  const handle_key_mod_up = () => {
    if (isModDown.value) {
      isModDown.value = false
      mineDrag.setDisabled(true)
      externalDrag.setDisabled(true)
    }
  }

  window.key_event.on('key_mod_down', handle_key_mod_down)
  window.key_event.on('key_mod_up', handle_key_mod_up)

  onBeforeUnmount(() => {
    clearHeadingState()
    mineDrag.destroy()
    externalDrag.destroy()
    window.key_event.off('key_mod_down', handle_key_mod_down)
    window.key_event.off('key_mod_up', handle_key_mod_up)
  })

  return {
    isModDown,
  }
}
