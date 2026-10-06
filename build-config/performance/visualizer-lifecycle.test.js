const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const vue = require('vue')
const { loadVueSfc } = require('../../scripts/test-utils/load-vue-sfc')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')
const policy = loadTsModule(path.join(__dirname, '../../src/common/performance/featurePolicy.ts'))

const harness = (t, lyric = false) => {
  const mounts = []
  const unmounts = []
  const listeners = new Map()
  const frames = new Map()
  let nextId = 1
  let acquisitions = 0
  let releases = 0
  let requests = 0
  let deliver
  let producerPort
  const isPlay = vue.ref(false)
  const setting = vue.reactive({
    'performance.features.audioVisualization': 'onDemand',
    'player.audioVisualization': true,
    'desktopLyric.audioVisualization': true,
  })
  const props = vue.reactive({ visible: true })
  const previous = { window: global.window, document: global.document, getComputedStyle: global.getComputedStyle }
  const addEventListener = (name, callback) => { listeners.set(name, callback) }
  const removeEventListener = name => { listeners.delete(name) }
  global.document = { hidden: false, documentElement: {}, addEventListener, removeEventListener }
  global.getComputedStyle = () => ({ getPropertyValue: () => '#000' })
  global.window = {
    app_event: { on: addEventListener, off: removeEventListener },
    addEventListener,
    removeEventListener,
    requestAnimationFrame(callback) { const id = nextId++; frames.set(id, callback); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
  }
  const analyser = { frequencyBinCount: 128, getByteFrequencyData(data) { data.fill(12) } }
  const component = loadVueSfc(path.join(__dirname, `../../src/${lyric ? 'renderer-lyric' : 'renderer'}/components/common/AudioVisualizer.vue`), {
    '@common/utils/vueTools': { ...vue, onMounted: callback => mounts.push(callback), onBeforeUnmount: callback => unmounts.push(callback) },
    '@common/performance/featurePolicy': policy,
    '@renderer/plugins/player': {
      getAnalyser() { acquisitions++; return analyser },
      acquireAnalyser() { acquisitions++; return { analyser, release() { releases++ } } },
    },
    '@renderer/store/player/state': { isPlay },
    '@renderer/store/setting': { appSetting: setting },
    '@lyric/store/state': { isPlay, setting },
    '@lyric/core/mainWindowChannel': { useEvent(callback) { deliver = callback }, getAnalyserDataArray() { requests++; producerPort?.onmessage({ data: { action: 'get_analyser_data_array' } }) } },
  }).default
  const scope = vue.effectScope()
  const refs = scope.run(() => component.setup(props))
  refs.dom_canvas.value = {
    clientWidth: 400,
    clientHeight: 100,
    getContext: () => ({ clearRect() {}, fillRect() {} }),
  }
  mounts.forEach(callback => callback())
  t.after(() => {
    unmounts.forEach(callback => callback())
    scope.stop()
    Object.assign(global, previous)
  })
  return {
    isPlay,
    setting,
    props,
    frames,
    acquisitions: () => acquisitions,
    releases: () => releases,
    requests: () => requests,
    connectProducer() {
      setting['desktopLyric.enable'] = true
      setting['player.mediaDeviceId'] = 'speakers'
      producerPort = { postMessage: event => deliver(event), close() {} }
      const producer = loadTsModule('src/renderer/core/lyric.ts', {
        '@common/utils/lyric-font-player': class {},
        '@renderer/plugins/player': { acquireAnalyser() { if (setting['player.mediaDeviceId'] != 'default') return null; acquisitions++; return { analyser, release() { releases++ } } } },
        '@common/performance/featurePolicy': policy,
        '@renderer/store/player/lyric': {},
        '@renderer/store/player/state': { isPlay, musicInfo: {} },
        '@renderer/store/player/action': {},
        '@common/utils/vueTools': vue,
        '@renderer/store/setting': { appSetting: setting },
        '@renderer/utils/ipc': { onNewDesktopLyricProcess: callback => callback({ event: { ports: [producerPort] } }) },
      })
      scope.run(() => producer.init())
    },
    emit(name) { listeners.get(name)?.() },
    deliver() { deliver({ action: 'send_analyser_data_array', data: new Uint8Array(128) }) },
    availability(data) { deliver({ action: 'set_analyser_available', data }) },
    tick() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()) },
  }
}

test('main visualizer waits for visible playback, owns one loop, and releases its analyser when hidden', async t => {
  const state = harness(t)
  assert.equal(state.acquisitions(), 0)
  state.isPlay.value = true
  state.emit('play')
  await vue.nextTick()
  state.emit('play')
  assert.equal(state.frames.size, 1)
  assert.equal(state.acquisitions(), 1)
  global.document.hidden = true
  state.emit('visibilitychange')
  assert.equal(state.frames.size, 0)
  assert.equal(state.releases(), 1)
  global.document.hidden = false
  state.emit('visibilitychange')
  assert.equal(state.frames.size, 1)
  state.setting['performance.features.audioVisualization'] = 'off'
  await vue.nextTick()
  assert.equal(state.frames.size, 0)
  assert.equal(state.releases(), 2)
})

test('lyric visualizer suspends unavailable requests and resumes exactly one loop on output change', async t => {
  const state = harness(t, true)
  state.isPlay.value = true
  await vue.nextTick()
  assert.equal(state.requests(), 1)
  state.availability(false)
  for (let i = 0; i < 5; i++) state.tick()
  assert.equal(state.requests(), 1)
  assert.equal(state.frames.size, 0)
  state.availability(true)
  assert.equal(state.requests(), 2)
  state.availability(true)
  assert.equal(state.requests(), 2)
  state.deliver()
  assert.equal(state.frames.size, 1)
  state.tick()
  assert.equal(state.requests(), 3)
})

test('actual desktop producer resumes uninterrupted visible playback after non-default output becomes default', async t => {
  const state = harness(t, true)
  state.connectProducer()
  state.isPlay.value = true
  await vue.nextTick()
  assert.equal(state.frames.size, 0)
  const blockedRequests = state.requests()
  state.tick()
  assert.equal(state.requests(), blockedRequests)
  assert.equal(state.acquisitions(), 0)
  state.setting['player.mediaDeviceId'] = 'default'
  await vue.nextTick()
  assert.equal(state.acquisitions(), 1)
  assert.equal(state.frames.size, 1)
  state.tick()
  assert.equal(state.acquisitions(), 1)
  assert.equal(state.frames.size, 1)
  state.isPlay.value = false
  await vue.nextTick()
  assert.equal(state.releases(), 1)
  assert.equal(state.frames.size, 0)
})

test('lyric visualizer stops requests while hidden or disabled and ignores late responses', async t => {
  const state = harness(t, true)
  state.isPlay.value = true
  await vue.nextTick()
  state.tick()
  assert.equal(state.requests(), 1)
  state.props.visible = false
  await vue.nextTick()
  state.deliver()
  assert.equal(state.frames.size, 0)
  state.props.visible = true
  await vue.nextTick()
  state.tick()
  state.deliver()
  state.deliver()
  assert.equal(state.frames.size, 1)
  state.setting['performance.features.audioVisualization'] = 'off'
  await vue.nextTick()
  state.deliver()
  assert.equal(state.frames.size, 0)
  const requests = state.requests()
  state.tick()
  assert.equal(state.requests(), requests)
})
