import { onMounted, useCssModule, type Ref } from '@common/utils/vueTools'


export default ({ dom_lists_list }: {
  dom_lists_list: Ref<HTMLElement | null>
}) => {
  const styles = useCssModule()

  const scrollToList = (id: string) => {
    if (!dom_lists_list.value) return
    let target = Array.from(dom_lists_list.value.querySelectorAll<HTMLElement>('[data-list-id]'))
      .find(element => element.dataset.listId == id)
    if (!target) return
    const container = dom_lists_list.value
    const viewport = container.getBoundingClientRect()
    const row = target.getBoundingClientRect()
    if (row.top >= viewport.top && row.bottom <= viewport.bottom) return
    container.scrollTop = Math.max(0, container.scrollTop + row.top - viewport.top - Math.min(150, container.clientHeight / 3))
  }

  onMounted(() => {
    const target = dom_lists_list.value?.querySelector('.' + styles.active) as HTMLElement
    if (target?.dataset.listId) scrollToList(target.dataset.listId)
  })

  return { scrollToList }
}
