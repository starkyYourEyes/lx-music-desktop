const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const vue = require('vue')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const freqs = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

const policy = loadTsModule(path.join(__dirname, '../src/common/performance/featurePolicy.ts'))
const createSettingsHarness = (t, overrides = {}, loadBuffer) => {
  const appSetting = vue.reactive({
    'player.soundEffect.mode': 'original',
    'player.soundEffect.panner.enable': false,
    'player.soundEffect.panner.soundR': 5,
    'player.soundEffect.panner.speed': 25,
    'player.soundEffect.convolution.fileName': '',
    'player.soundEffect.pitchShifter.playbackRate': 1,
    ...Object.fromEntries(freqs.map(freq => [`player.soundEffect.biquadFilter.hz${freq}`, 0])),
    'player.soundEffect.biquadFilter.hz1000': 6,
    ...overrides,
  })
  const calls = []
  const useSoundEffect = loadTsModule(path.join(__dirname, '../src/renderer/core/useApp/usePlayer/useSoundEffect.ts'), {
    '@common/utils/vueTools': vue,
    '@renderer/store/setting': { appSetting },
    '@common/performance/featurePolicy': policy,
    '@renderer/core/features/runtime': { reportFeatureState() {}, registerFeaturePreparation: () => () => {} },
    './convolutionBufferCache': { createConvolutionBufferCache: () => ({ clear() {}, get(name) { return loadBuffer(name) } }) },
    '@renderer/plugins/player': {
      freqs,
      setAudioFeaturePolicy() {},
      prepareAudioFeature() {},
      subscribeAudioFeatureState: () => () => {},
      getAudioFeatureState: () => ({}),
      stopPanner() {},
      setPitchShifter() {},
      setConvolver(buffer) { if (buffer) calls.push({ buffer }) },
      setSoundEffectMode: mode => calls.push({ mode }),
      setEqualizerGains: gains => calls.push({ gains: [...gains] }),
      setPannerSoundR() {},
      setPannerSpeed() {},
    },
  }).default
  const scope = vue.effectScope()
  t.after(() => scope.stop())
  scope.run(useSoundEffect)
  return { appSetting, calls }
}

test('restored original mode reaches the player before saved EQ is applied', t => {
  const { calls } = createSettingsHarness(t)
  assert.deepEqual(calls, [
    { mode: 'original' },
    { gains: [0, 0, 0, 0, 0, 6, 0, 0, 0, 0] },
  ])
})

test('turning the feature off preserves the saved effect mode and curve while applying original output', async t => {
  const { appSetting, calls } = createSettingsHarness(t, {
    'performance.features.soundEffects': 'onDemand',
    'player.soundEffect.mode': 'effects',
  })
  appSetting['performance.features.soundEffects'] = 'off'
  await vue.nextTick()
  assert.equal(appSetting['player.soundEffect.mode'], 'effects')
  assert.equal(appSetting['player.soundEffect.biquadFilter.hz1000'], 6)
  assert.equal(calls.at(-1).mode, 'original')
  appSetting['performance.features.soundEffects'] = 'onDemand'
  await vue.nextTick()
  assert.equal(calls.at(-1).mode, 'effects')
})

test('a multi-band preset is applied once as a complete EQ curve', async t => {
  const { appSetting, calls } = createSettingsHarness(t)
  Object.assign(appSetting, {
    'player.soundEffect.biquadFilter.hz500': 12,
    'player.soundEffect.biquadFilter.hz1000': 12,
    'player.soundEffect.biquadFilter.hz2000': 12,
  })
  await vue.nextTick()
  assert.deepEqual(calls.slice(2), [{ gains: [0, 0, 0, 0, 12, 12, 12, 0, 0, 0] }])
})

test('mode changes preserve saved EQ and do not reapply or reset its curve', async t => {
  const { appSetting, calls } = createSettingsHarness(t)
  appSetting['player.soundEffect.mode'] = 'effects'
  await vue.nextTick()
  appSetting['player.soundEffect.mode'] = 'original'
  await vue.nextTick()
  assert.equal(appSetting['player.soundEffect.biquadFilter.hz1000'], 6)
  assert.deepEqual(calls.slice(2), [{ mode: 'effects' }, { mode: 'original' }])
})

test('an impulse arriving after disable cannot restore convolution and enabling reloads the saved impulse', async t => {
  const pending = []
  const { appSetting, calls } = createSettingsHarness(t, {
    'performance.features.soundEffects': 'onDemand',
    'player.soundEffect.mode': 'effects',
    'player.soundEffect.convolution.fileName': 'impulse.wav',
  }, name => new Promise(resolve => pending.push({ name, resolve })))
  appSetting['performance.features.soundEffects'] = 'off'
  await vue.nextTick()
  pending[0].resolve({ old: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.some(call => call.buffer), false)
  assert.equal(appSetting['player.soundEffect.convolution.fileName'], 'impulse.wav')
  appSetting['performance.features.soundEffects'] = 'onDemand'
  await vue.nextTick()
  assert.equal(pending.length, 2)
  const buffer = { current: true }
  pending[1].resolve(buffer)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.at(-1).buffer, buffer)
})
