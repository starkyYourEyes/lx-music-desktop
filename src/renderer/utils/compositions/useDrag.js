import Sortable, { AutoScroll } from 'sortablejs/modular/sortable.core.esm'
import { onBeforeUnmount, onMounted } from '@common/utils/vueTools'
import { clearDownKeys } from '@renderer/event'

Sortable.mount(new AutoScroll())

const noop = (..._args) => {}

export default ({ dom_list, dragingItemClassName, group, draggable, filter, onAdd = noop, onUpdate = noop, onMove, onStart = noop, onEnd = noop }) => {
  let sortable

  onMounted(() => {
    sortable = Sortable.create(dom_list.value, {
      animation: 150,
      disabled: true,
      forceFallback: false,
      group,
      draggable,
      filter: filter ?? null,
      ghostClass: dragingItemClassName,
      onUpdate(event) {
        onUpdate(event)
      },
      onAdd(event) {
        onAdd(event)
      },
      onMove(event) {
        if (onMove) return onMove(event)
        return filter ? !event.related?.matches(filter) : true
      },
      onChoose() {
        onStart()
      },
      onUnchoose() {
        onEnd()
        // 处于拖动状态期间，键盘事件无法监听，拖动结束手动清理按下的键
        // window.app_event.emit(eventBaseName.setClearDownKeys)
        clearDownKeys()
      },
      onStart(event) {
        window.app_event.dragStart()
      },
      onEnd(event) {
        window.app_event.dragEnd()
      },
    })
  })

  onBeforeUnmount(() => {
    sortable?.destroy()
    sortable = null
  })

  return {
    setDisabled(enable) {
      if (!sortable) return
      sortable.option('disabled', enable)
    },
    destroy() {
      sortable?.destroy()
      sortable = null
    },
  }
}
