const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const vue = require('vue')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

test('a new context menu closes the existing menu before the target opens another one', async() => {
  const listeners = new Map()
  const cleanups = []
  global.document = {
    addEventListener: (name, callback, capture) => listeners.set(name, { callback, capture }),
    removeEventListener: name => listeners.delete(name),
  }
  global.window = { lx: { rootOffset: 0 } }
  const scope = vue.effectScope()
  const visible = vue.ref(false)
  const useMenuLocation = loadTsModule(path.resolve('src/renderer/utils/compositions/useMenuLocation.js'), {
    '@common/utils/vueTools': {
      ...vue,
      onMounted: callback => callback(),
      onBeforeUnmount: callback => cleanups.push(callback),
    },
  }).default
  const menu = scope.run(() => useMenuLocation({
    visible,
    location: vue.ref({ x: 10, y: 10 }),
    onHide: () => { visible.value = false },
  }))
  const menuElement = {
    clientWidth: 100, clientHeight: 60,
    offsetParent: { clientWidth: 800, clientHeight: 600 },
    contains: () => false,
  }
  menu.dom_menu.value = menuElement
  visible.value = true
  await vue.nextTick()
  assert.equal(menu.menuStyles.pointerEvents, 'auto')
  assert.equal(listeners.get('contextmenu')?.capture, true)
  listeners.get('contextmenu').callback({ target: {} })
  assert.equal(visible.value, false)
  await vue.nextTick()
  assert.equal(menu.menuStyles.pointerEvents, 'none')
  visible.value = true
  await vue.nextTick()
  listeners.get('contextmenu').callback({ target: menu.dom_menu.value })
  assert.equal(visible.value, true, 'a click inside the current menu leaves it open')
  cleanups.forEach(cleanup => cleanup())
  scope.stop()
  assert.equal(listeners.size, 0)
})

test('playlist reveal uses the playlist viewport, including targets near the top', () => {
  let targetTop = -60
  const target = { dataset: { listId: 'custom' }, getBoundingClientRect: () => ({ top: targetTop, bottom: targetTop + 46 }) }
  const container = {
    scrollTop: 400, clientHeight: 100,
    getBoundingClientRect: () => ({ top: 40, bottom: 140 }),
    querySelectorAll: () => [target],
  }
  const useListScroll = loadTsModule(path.resolve('src/renderer/views/List/MyList/useListScroll.ts'), {
    '@common/utils/vueTools': { onMounted: () => {}, useCssModule: () => ({}) },
  }).default
  const { scrollToList } = useListScroll({ dom_lists_list: { value: container } })
  scrollToList('custom')
  assert.ok(container.scrollTop < 400, 'reveals a playlist above the visible region')
  targetTop = 70
  const before = container.scrollTop
  scrollToList('custom')
  assert.equal(container.scrollTop, before, 'already visible rows keep the user scroll position')
  targetTop = 170
  scrollToList('custom')
  assert.ok(container.scrollTop > before, 'reveals a playlist below the visible region')
})
