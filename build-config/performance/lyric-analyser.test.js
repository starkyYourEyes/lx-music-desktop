const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const vue = require('vue')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')
const policy = loadTsModule(path.join(__dirname, '../../src/common/performance/featurePolicy.ts'))

test('lyric frequency IPC cannot initialize the analyser while off and releases it when disabled', async t => {
  const appSetting = vue.reactive({
    'performance.features.audioVisualization': 'off',
    'desktopLyric.enable': true,
    'desktopLyric.audioVisualization': true,
  })
  const isPlay = vue.ref(true)
  let connect
  let acquisitions = 0
  let releases = 0
  let samples = 0
  const sent = []
  const analyser = { frequencyBinCount: 128, getByteFrequencyData() { samples++ } }
  const lyric = loadTsModule(path.join(__dirname, '../../src/renderer/core/lyric.ts'), {
    '@common/performance/featurePolicy': policy,
    '@common/utils/lyric-font-player': class {},
    '@renderer/plugins/player': {
      getCurrentTime: () => 0,
      getAnalyser() { acquisitions++; return analyser },
      acquireAnalyser() { acquisitions++; return { analyser, release() { releases++ } } },
    },
    '@renderer/store/player/lyric': {},
    '@renderer/store/player/state': { isPlay, musicInfo: {} },
    '@renderer/store/player/action': {},
    '@common/utils/vueTools': { ...vue, markRawList: value => value },
    '@renderer/store/setting': { appSetting },
    '@renderer/utils/ipc': { onNewDesktopLyricProcess(callback) { connect = callback } },
  })
  const scope = vue.effectScope()
  t.after(() => scope.stop())
  scope.run(lyric.init)
  const port = { postMessage: data => sent.push(data), close() {} }
  connect({ event: { ports: [port] } })
  const request = () => { port.onmessage({ data: { action: 'get_analyser_data_array' } }) }
  request()
  assert.equal(acquisitions, 0)
  assert.equal(sent.filter(event => event.action == 'send_analyser_data_array').length, 0)
  assert.deepEqual(sent, [{ action: 'set_analyser_available', data: false }])
  appSetting['performance.features.audioVisualization'] = 'onDemand'
  await vue.nextTick()
  request()
  request()
  assert.equal(acquisitions, 1)
  assert.equal(samples, 2)
  appSetting['performance.features.audioVisualization'] = 'off'
  await vue.nextTick()
  request()
  assert.equal(samples, 2)
  assert.equal(releases, 1)
})
