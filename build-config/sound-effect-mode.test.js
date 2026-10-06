const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { createRenderer, createSSRApp, defineComponent, h, nextTick, reactive } = require('vue')
const { renderToString } = require('@vue/server-renderer')
const { loadVueSfc } = require('../scripts/test-utils/load-vue-sfc')
const loadTsModule = require('../scripts/test-utils/load-ts-module')
const policy = loadTsModule(path.join(__dirname, '../src/common/performance/featurePolicy.ts'))

const root = path.resolve(__dirname, '..')
const componentPath = path.join(root, 'src/renderer/components/common/SoundEffectBtn/SoundEffectMode.vue')
const soundEffectButtonPath = path.join(root, 'src/renderer/components/common/SoundEffectBtn/index.vue')
const styleProxy = new Proxy({}, { get: (_, property) => String(property) })

const BaseBtn = defineComponent({
  inheritAttrs: false,
  setup(_, { attrs, slots }) {
    return () => h('button', attrs, slots.default?.())
  },
})

const createNode = type => ({ type, props: {}, children: [], parent: null })
const findAll = (node, predicate, matches = []) => {
  if (predicate(node)) matches.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, matches)
  return matches
}

const mountMode = ({ mode = 'effects', mediaDeviceId = 'default', hz31 = 7, setMediaDevice } = {}) => {
  const appSetting = reactive({
    'player.soundEffect.mode': mode,
    'player.mediaDeviceId': mediaDeviceId,
    'player.soundEffect.biquadFilter.hz31': hz31,
  })
  const updates = []
  const setDeviceCalls = []
  const saveDeviceCalls = []
  const SoundEffectMode = loadVueSfc(componentPath, {
    '@common/utils/vueTools': require('vue'),
    '@renderer/store/setting': {
      appSetting,
      updateSetting(setting) {
        updates.push(setting)
        Object.assign(appSetting, setting)
      },
      saveMediaDeviceId: id => saveDeviceCalls.push(id),
    },
    '@renderer/plugins/player': {
      setMediaDeviceId: async id => {
        setDeviceCalls.push(id)
        await setMediaDevice?.(id)
      },
    },
  }).default
  const renderer = createRenderer({
    createElement: createNode,
    createText: text => ({ type: '#text', text, parent: null }),
    createComment: text => ({ type: '#comment', text, parent: null }),
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.children = [{ type: '#text', text, parent: node }] },
    patchProp: (node, key, _, value) => { node.props[key] = value },
    insert: (node, parent, anchor) => {
      node.parent = parent
      if (anchor) parent.children.splice(parent.children.indexOf(anchor), 0, node)
      else parent.children.push(node)
    },
    remove: node => node.parent?.children.splice(node.parent.children.indexOf(node), 1),
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1],
  })
  const app = renderer.createApp({ render: () => h(SoundEffectMode) })
  app.config.globalProperties.$style = styleProxy
  app.config.globalProperties.$t = key => key
  app.component('BaseBtn', BaseBtn)
  const container = createNode('#root')
  app.mount(container)
  return { app, appSetting, container, saveDeviceCalls, setDeviceCalls, updates }
}

test('mode selection persists only the mode and preserves effect settings across a round trip', async() => {
  const mounted = mountMode({ hz31: 7 })
  let buttons = findAll(mounted.container, node => node.type == 'button')
  assert.equal(buttons[0].props['aria-pressed'], false)
  assert.equal(buttons[1].props['aria-pressed'], true)

  await buttons[0].props.onClick()
  await nextTick()
  assert.deepEqual(mounted.updates[0], { 'player.soundEffect.mode': 'original' })
  assert.equal(mounted.appSetting['player.soundEffect.biquadFilter.hz31'], 7)

  buttons = findAll(mounted.container, node => node.type == 'button')
  assert.equal(buttons[0].props['aria-pressed'], true)
  await buttons[1].props.onClick()
  await nextTick()
  assert.deepEqual(mounted.updates[1], { 'player.soundEffect.mode': 'effects' })
  assert.equal(mounted.appSetting['player.soundEffect.biquadFilter.hz31'], 7)
  assert.deepEqual(mounted.setDeviceCalls, [])
  assert.deepEqual(mounted.saveDeviceCalls, [])
  mounted.app.unmount()
})

test('entering effects mode restores the compatible default output device', async() => {
  const mounted = mountMode({ mode: 'original', mediaDeviceId: 'speakers' })
  const buttons = findAll(mounted.container, node => node.type == 'button')
  await buttons[1].props.onClick()
  await nextTick()

  assert.deepEqual(mounted.setDeviceCalls, ['default'])
  assert.deepEqual(mounted.saveDeviceCalls, ['default'])
  assert.deepEqual(mounted.updates, [{ 'player.soundEffect.mode': 'effects' }])
  mounted.app.unmount()
})

test('a later original selection cancels a pending effects mode change', async() => {
  let resolveDeviceChange
  const deviceChange = new Promise(resolve => { resolveDeviceChange = resolve })
  const mounted = mountMode({
    mode: 'original',
    mediaDeviceId: 'speakers',
    setMediaDevice: () => deviceChange,
  })
  const buttons = findAll(mounted.container, node => node.type == 'button')

  const effectsChange = buttons[1].props.onClick()
  await Promise.resolve()
  await buttons[0].props.onClick()
  resolveDeviceChange()
  await effectsChange
  await nextTick()

  assert.deepEqual(mounted.setDeviceCalls, ['default'])
  assert.deepEqual(mounted.saveDeviceCalls, [])
  assert.deepEqual(mounted.updates, [])
  assert.equal(mounted.appSetting['player.soundEffect.mode'], 'original')
  mounted.app.unmount()
})

test('original mode conceals effect editors and shows the switch-to-effects message', async() => {
  const appSetting = reactive({
    'performance.features.soundEffects': 'onDemand',
    'player.soundEffect.mode': 'effects',
    'player.mediaDeviceId': 'default',
  })
  const marker = name => defineComponent({ render: () => h('span', name) })
  const SoundEffectButton = loadVueSfc(soundEffectButtonPath, {
    '@common/performance/featurePolicy': policy,
    '@common/utils/vueTools': require('vue'),
    '@renderer/store/setting': { appSetting },
    './SoundEffectMode.vue': marker('mode-selector'),
    './AudioConvolution.vue': marker('convolution-editor'),
    './PitchShifter.vue': marker('pitch-editor'),
    './AudioPanner.vue': marker('panner-editor'),
    './BiquadFilter.vue': marker('equalizer-editor'),
  }).default
  const MaterialModal = defineComponent({
    setup(_, { slots }) { return () => h('div', slots.default?.()) },
  })
  const render = async() => {
    const app = createSSRApp({ render: () => h(SoundEffectButton) })
    app.config.globalProperties.$style = styleProxy
    app.config.globalProperties.$t = key => key
    app.component('MaterialModal', MaterialModal)
    return renderToString(app)
  }

  const effectsHtml = await render()
  assert.match(effectsHtml, /equalizer-editor/)
  assert.doesNotMatch(effectsHtml, /player__sound_effect_mode_original_edit_tip/)

  appSetting['player.soundEffect.mode'] = 'original'
  const originalHtml = await render()
  assert.doesNotMatch(originalHtml, /equalizer-editor|convolution-editor|pitch-editor|panner-editor/)
  assert.match(originalHtml, /player__sound_effect_mode_original_edit_tip/)
})
