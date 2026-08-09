const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const Vue = require('vue')
const { loadVueSfc } = require('../scripts/test-utils/load-vue-sfc')

const componentPath = path.join(__dirname, '../src/renderer/components/base/VirtualizedList.vue')

const createHarness = headerHeight => {
  let mounted
  let beforeUnmount
  let onScroll
  let resizeCallback
  let scrollTarget
  const originalWindow = global.window
  const originalRequestAnimationFrame = global.requestAnimationFrame

  global.requestAnimationFrame = callback => callback()
  global.window = {
    setTimeout: callback => callback(),
    addEventListener() {},
    removeEventListener() {},
    ResizeObserver: class {
      constructor(callback) {
        resizeCallback = callback
      }

      observe() {}
      disconnect() {}
    },
  }

  const component = loadVueSfc(componentPath, {
    vue: {
      ...Vue,
      nextTick: callback => Promise.resolve(callback()),
      onMounted: callback => { mounted = callback },
      onBeforeUnmount: callback => { beforeUnmount = callback },
      watch() {},
    },
  }).default
  const props = {
    list: Array.from({ length: 10 }, (_, index) => ({ id: String(index) })),
    itemHeight: 50,
    keyName: 'id',
    containerEl: 'div',
    containerClass: 'scroll',
    contentEl: 'div',
    contentClass: 'list',
  }
  const container = {
    clientHeight: 100,
    scrollTop: 0,
    addEventListener: (name, callback) => { if (name == 'scroll') onScroll = callback },
    removeEventListener() {},
    scrollTo: value => { scrollTarget = value },
  }
  const bindings = component.setup(props, { emit() {} })
  bindings.dom_scrollContainer.value = container
  if (bindings.dom_header) {
    bindings.dom_header.value = headerHeight == null ? null : { offsetHeight: headerHeight }
  }
  mounted()
  resizeCallback?.()

  return {
    bindings,
    scroll: value => {
      container.scrollTop = value
      onScroll({})
    },
    scrollTarget: () => scrollTarget,
    cleanup: () => {
      beforeUnmount()
      global.window = originalWindow
      global.requestAnimationFrame = originalRequestAnimationFrame
    },
  }
}

test('measured header offsets visible rows and index scrolling', () => {
  const harness = createHarness(80)
  try {
    harness.scroll(130)
    assert.equal(harness.bindings.views.value[0].index, 1)

    harness.bindings.scrollToIndex(2)
    assert.deepEqual(harness.scrollTarget(), { top: 180, behavior: 'instant' })

    harness.bindings.scrollTo(0)
    assert.deepEqual(harness.scrollTarget(), { top: 0, behavior: 'instant' })
    assert.equal(harness.bindings.contentStyle.value.position, 'relative')
  } finally {
    harness.cleanup()
  }
})

test('missing header preserves zero-offset behavior', () => {
  const harness = createHarness(null)
  try {
    harness.scroll(50)
    assert.equal(harness.bindings.views.value[0].index, 1)

    harness.bindings.scrollToIndex(2)
    assert.deepEqual(harness.scrollTarget(), { top: 100, behavior: 'instant' })
  } finally {
    harness.cleanup()
  }
})
