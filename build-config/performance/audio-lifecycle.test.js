const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/plugins/player/index.ts'), 'utf8')
const { outputText } = ts.transpileModule(source.replaceAll('import.meta.url', "'file:///unused-worklet.js'"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
})

const createPlayer = () => {
  const nodes = []
  const contexts = []
  const timers = new Set()
  const sinkChanges = []
  let resolveWorklet
  let workletLoads = 0
  const workletReady = new Promise(resolve => { resolveWorklet = resolve })
  const param = (value = 0) => ({ value, cancelAndHoldAtTime() {}, setValueAtTime(value) { this.value = value }, linearRampToValueAtTime(value) { this.value = value } })
  const node = type => {
    const result = {
      type,
      outputs: new Set(),
      gain: param(1),
      frequency: param(),
      Q: param(),
      positionX: param(),
      positionY: param(),
      positionZ: param(),
      buffer: null,
      frequencyBinCount: 128,
      connect(target) { this.outputs.add(target); return target },
      disconnect(target) { if (target) this.outputs.delete(target); else this.outputs.clear() },
      getFrequencyResponse(frequencies, magnitudes) { magnitudes.fill(1) },
    }
    nodes.push(result)
    return result
  }
  class AudioContext {
    constructor() {
      contexts.push(this)
      this.currentTime = 0
      this.sampleRate = 48000
      this.destination = { channelCount: 2, channelCountMode: 'explicit', maxChannelCount: 8 }
      this.closed = false
      this.audioWorklet = { addModule() { workletLoads++; return workletReady } }
    }

    createMediaElementSource() { return node('source') }
    createAnalyser() { return node('analyser') }
    createBiquadFilter() { return node('filter') }
    createGain() { return node('gain') }
    createConvolver() { return node('convolver') }
    createDynamicsCompressor() { return node('compressor') }
    createPanner() { return node('panner') }
    close() { this.closed = true }
  }
  class Audio {
    constructor() { this.paused = false }
    addEventListener() {}
    removeEventListener() {}
    async setSinkId(id) { sinkChanges.push(id) }
  }
  const exports = {}
  vm.runInNewContext(outputText, {
    exports,
    window: { Audio, AudioContext, app_event: { on() {}, off() {} }, location: { href: 'http://localhost/' } },
    URL,
    console,
    AudioWorkletNode: function() {
      const worklet = node('worklet')
      worklet.parameters = new Map([['pitchFactor', param(1)]])
      worklet.port = { close() {} }
      return worklet
    },
    setTimeout(callback) { callback(); return 1 },
    clearTimeout() {},
    setInterval(callback) { timers.add(callback); return callback },
    clearInterval(callback) { timers.delete(callback) },
  })
  exports.createAudio()
  return { player: exports, nodes, contexts, timers, sinkChanges, resolveWorklet, workletLoads: () => workletLoads }
}

test('original mode with saved EQ does not allocate optional audio resources', () => {
  const { player, contexts } = createPlayer()
  player.setSoundEffectMode('original')
  player.setEqualizerGains([0, 0, 0, 0, 0, 6, 0, 0, 0, 0])
  assert.equal(contexts.length, 0)
})

test('disabled policies block actual analyser and effect initialization', () => {
  const { player, contexts } = createPlayer()
  player.setAudioFeaturePolicy({ soundEffects: 'off', audioVisualization: 'off', mediaDeviceId: 'default' })
  player.setSoundEffectMode('effects')
  player.setEqualizerGains([6])
  player.setConvolver({}, 1.8, 0.9)
  player.startPanner()
  assert.equal(player.getAnalyser(), null)
  assert.equal(contexts.length, 0)
})

test('maximum output channels initialize only shared output and prevent pointless restart requests', () => {
  const { player, nodes, contexts } = createPlayer()
  player.setAudioFeaturePolicy({ soundEffects: 'off', audioVisualization: 'off', mediaDeviceId: 'default' })
  player.setMaxOutputChannelCount(true)
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].destination.channelCount, 8)
  assert.equal(nodes.some(node => ['filter', 'analyser', 'convolver', 'panner'].includes(node.type)), false)
  assert.equal(player.getAudioFeatureState().restartRequired, false)
})

test('analyser release keeps shared original output alive and marks removable residue', () => {
  const { player, nodes, contexts } = createPlayer()
  player.setAudioFeaturePolicy({ soundEffects: 'off', audioVisualization: 'onDemand', mediaDeviceId: 'default' })
  const first = player.acquireAnalyser()
  const second = player.acquireAnalyser()
  assert.equal(first.analyser, second.analyser)
  first.release()
  assert.equal(player.getAudioFeatureState().analyserLoaded, true)
  second.release()
  assert.equal(player.getAudioFeatureState().analyserLoaded, false)
  assert.equal(contexts[0].closed, false)
  const output = nodes.find(node => node.type == 'source')
  assert.equal(output.outputs.size, 1)
  player.setAudioFeaturePolicy({ soundEffects: 'off', audioVisualization: 'off', mediaDeviceId: 'default' })
  assert.equal(player.getAudioFeatureState().restartRequired, true)
})

test('turning effects off stops panning and releases the convolution buffer without closing output', () => {
  const { player, nodes, contexts, timers } = createPlayer()
  player.setAudioFeaturePolicy({ soundEffects: 'onDemand', audioVisualization: 'off', mediaDeviceId: 'default' })
  player.setConvolver({}, 1.8, 0.9)
  player.startPanner()
  assert.equal(timers.size, 1)
  player.setAudioFeaturePolicy({ soundEffects: 'off', audioVisualization: 'off', mediaDeviceId: 'default' })
  assert.equal(timers.size, 0)
  assert.equal(nodes.find(node => node.type == 'convolver').buffer, null)
  assert.equal(contexts[0].closed, false)
  assert.equal(player.getAudioFeatureState().effectsActive, false)
})

test('resident prewarm with an incompatible output device does not initialize or change the device', () => {
  const { player, contexts, sinkChanges } = createPlayer()
  player.setAudioFeaturePolicy({ soundEffects: 'resident', audioVisualization: 'resident', mediaDeviceId: 'speakers' })
  player.prepareAudioFeature('soundEffects')
  player.prepareAudioFeature('audioVisualization')
  assert.equal(contexts.length, 0)
  assert.deepEqual(sinkChanges, [])
  assert.equal(player.getAudioFeatureState().deviceBlocked, true)
})

test('resident effect prewarm preserves original output and analyser independence', () => {
  const { player, nodes } = createPlayer()
  player.setSoundEffectMode('original')
  player.setAudioFeaturePolicy({ soundEffects: 'resident', audioVisualization: 'off', mediaDeviceId: 'default' })
  player.prepareAudioFeature('soundEffects')
  assert.equal(player.getAudioFeatureState().effectsLoaded, true)
  assert.equal(player.getAudioFeatureState().effectsActive, false)
  assert.equal(nodes.some(node => node.type == 'analyser'), false)
  const source = nodes.find(node => node.type == 'source')
  assert.ok([...source.outputs].some(output => output.gain?.value == 1))
})

test('a pending pitch worklet load cannot create an effect node after the feature is switched off', async() => {
  const { player, nodes, resolveWorklet } = createPlayer()
  player.setPitchShifter(1.2)
  player.setAudioFeaturePolicy({ soundEffects: 'off', audioVisualization: 'resident', mediaDeviceId: 'default' })
  resolveWorklet()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(nodes.filter(node => node.type == 'worklet').length, 0)
  assert.equal(player.getAudioFeatureState().effectsRestartRequired, true)
})

test('resident original mode retains prepared effects without a panning timer or processing input', () => {
  const { player, nodes, timers } = createPlayer()
  player.setAudioFeaturePolicy({ soundEffects: 'resident', audioVisualization: 'off', mediaDeviceId: 'default' })
  player.startPanner()
  player.setSoundEffectMode('original')
  assert.equal(timers.size, 0)
  assert.equal(player.getAudioFeatureState().effectsLoaded, true)
  assert.equal(nodes.find(node => node.type == 'source').outputs.size, 1)
})

test('switching a prepared resident graph to effects restores the saved EQ curve', () => {
  const { player, nodes } = createPlayer()
  player.setSoundEffectMode('original')
  player.setAudioFeaturePolicy({ soundEffects: 'resident', audioVisualization: 'off', mediaDeviceId: 'default' })
  player.prepareAudioFeature('soundEffects')
  player.setEqualizerGains([0, 0, 0, 0, 0, -6, 0, 0, 0, 0])
  player.setSoundEffectMode('effects')
  assert.equal(nodes.find(node => node.type == 'peaking' && node.frequency.value == 1000).gain.value, -6)
})
