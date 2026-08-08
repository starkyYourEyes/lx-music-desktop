import { onBeforeUnmount, ref, type Ref, useCssModule } from '@common/utils/vueTools'
import useDarg from '@renderer/utils/compositions/useDrag'
import { reorderUserListWithinGroup } from './groupActions'


export default ({ dom_mine_list, dom_external_list, handleSaveListName, handleMenuClick }: {
  dom_mine_list: Ref<HTMLElement | null>
  dom_external_list: Ref<HTMLElement | null>
  handleSaveListName: () => Promise<void> | void
  handleMenuClick: () => void
}) => {
  const isModDown = ref(false)
  const styles = useCssModule()

  const restoreItem = (event: { item: HTMLElement, from: HTMLElement, oldDraggableIndex: number }) => {
    event.item.remove()
    const rows = event.from.querySelectorAll<HTMLElement>('.user-list')
    const target = rows[event.oldDraggableIndex]
    if (target) event.from.insertBefore(event.item, target)
    else event.from.insertBefore(event.item, event.from.querySelector('.new-list-input'))
  }
  const createGroupDrag = (dom_list: Ref<HTMLElement | null>) => useDarg({
    dom_list,
    dragingItemClassName: styles.dragingItem,
    draggable: '.user-list',
    filter: '.my-list-group-heading, .default-list',
    onUpdate(event: { item: HTMLElement, from: HTMLElement, to: HTMLElement, newDraggableIndex: number, oldDraggableIndex: number }) {
      const id = event.item.dataset.listId
      const group = event.to.dataset.group as LX.List.UserListGroup
      if (!id || (group != 'mine' && group != 'external')) return
      void reorderUserListWithinGroup({ id, group, toIndex: event.newDraggableIndex }).catch(() => {
        restoreItem(event)
      })
    },
  })
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
    window.key_event.off('key_mod_down', handle_key_mod_down)
    window.key_event.off('key_mod_up', handle_key_mod_up)
  })

  return {
    isModDown,
  }
}
