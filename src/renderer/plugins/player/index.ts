import type { PlaybackResource } from '@renderer/core/music/playback/coordinator'
import type { FeatureLoadMode } from '@common/performance/featurePolicy'

interface HTMLAudioElementChrome extends HTMLAudioElement {
  setSinkId: (id: string) => Promise<void>
}
export type PlayerResourceContext = PlaybackResource & { resourceGeneration: number }

export interface ResourceMediaEvent {
  resource: PlayerResourceContext
  currentSrc: string
}

export interface SetResourceOptions {
  startTime?: number
  shouldPlay?: boolean
  resource: PlaybackResource
  preloadedAudio?: HTMLAudioElement | null
}

export interface PlayerResourceController {
  setResource: (url: string, options: SetResourceOptions) => PlayerResourceContext
  setStop: () => void
  getResourceContext: () => PlayerResourceContext | null
  replaceResourceContext: (expected: PlayerResourceContext, resource: PlaybackResource) => boolean
  clearResourceIf: (expected: PlaybackResource | PlayerResourceContext) => boolean
  isCurrentResourceEvent: (event: PlayerResourceContext, currentSrc: string) => boolean
  onCanplay: (handler: (event: ResourceMediaEvent) => void) => () => void
  onError: (handler: (event: ResourceMediaEvent) => void) => () => void
  onLoadstart: (handler: (event: ResourceMediaEvent) => void) => () => void
  onLoadeddata: (handler: (event: ResourceMediaEvent) => void) => () => void
  onWaiting: (handler: (event: ResourceMediaEvent) => void) => () => void
}

export type CreatePlayerResourceController = (deps: {
  audio: HTMLAudioElement
  adoptAudio?: (next: HTMLAudioElement) => Promise<void>
  canonicalizeUrl: (value: string) => string
}) => PlayerResourceController

let audio: HTMLAudioElementChrome | null = null
const audioListeners = new Map<string, Set<EventListener>>()
const addAudioListener = (name: string, listener: EventListener) => {
  let listeners = audioListeners.get(name)
  if (!listeners) audioListeners.set(name, listeners = new Set())
  listeners.add(listener)
  audio?.addEventListener(name, listener)
}
const removeAudioListener = (name: string, listener: EventListener) => {
  audioListeners.get(name)?.delete(listener)
  audio?.removeEventListener(name, listener)
}
let audioContext: AudioContext
let mediaSource: MediaElementAudioSourceNode
let analyser: AnalyserNode | null = null
// https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext
// https://benzleung.gitbooks.io/web-audio-api-mini-guide/content/chapter5-1.html
export const freqs = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const
type Freqs = (typeof freqs)[number]
let biquads: Map<`hz${Freqs}`, BiquadFilterNode>
export const freqsPreset = [
  { name: 'pop', hz31: 6, hz62: 5, hz125: -3, hz250: -2, hz500: 5, hz1000: 4, hz2000: -4, hz4000: -3, hz8000: 6, hz16000: 4 },
  { name: 'dance', hz31: 4, hz62: 3, hz125: -4, hz250: -6, hz500: 0, hz1000: 0, hz2000: 3, hz4000: 4, hz8000: 4, hz16000: 5 },
  { name: 'rock', hz31: 7, hz62: 6, hz125: 2, hz250: 1, hz500: -3, hz1000: -4, hz2000: 2, hz4000: 1, hz8000: 4, hz16000: 5 },
  { name: 'classical', hz31: 6, hz62: 7, hz125: 1, hz250: 2, hz500: -1, hz1000: 1, hz2000: -4, hz4000: -6, hz8000: -7, hz16000: -8 },
  { name: 'vocal', hz31: -5, hz62: -6, hz125: -4, hz250: -3, hz500: 3, hz1000: 4, hz2000: 5, hz4000: 4, hz8000: -3, hz16000: -3 },
  { name: 'slow', hz31: 5, hz62: 4, hz125: 2, hz250: 0, hz500: -2, hz1000: 0, hz2000: 3, hz4000: 6, hz8000: 7, hz16000: 8 },
  { name: 'electronic', hz31: 6, hz62: 5, hz125: 0, hz250: -5, hz500: -4, hz1000: 0, hz2000: 6, hz4000: 8, hz8000: 8, hz16000: 7 },
  { name: 'subwoofer', hz31: 8, hz62: 7, hz125: 5, hz250: 4, hz500: 0, hz1000: 0, hz2000: 0, hz4000: 0, hz8000: 0, hz16000: 0 },
  { name: 'soft', hz31: -5, hz62: -5, hz125: -4, hz250: -4, hz500: 3, hz1000: 2, hz2000: 4, hz4000: 4, hz8000: 0, hz16000: 0 },
] as const
export const convolutions = [
  { name: 'telephone', mainGain: 0.0, sendGain: 3.0, source: 'filter-telephone.wav' }, // 电话
  { name: 's2_r4_bd', mainGain: 1.8, sendGain: 0.9, source: 's2_r4_bd.wav' }, // 教堂
  { name: 'bright_hall', mainGain: 0.8, sendGain: 2.4, source: 'bright-hall.wav' },
  { name: 'cinema_diningroom', mainGain: 0.6, sendGain: 2.3, source: 'cinema-diningroom.wav' },
  { name: 'dining_living_true_stereo', mainGain: 0.6, sendGain: 1.8, source: 'dining-living-true-stereo.wav' },
  { name: 'living_bedroom_leveled', mainGain: 0.6, sendGain: 2.1, source: 'living-bedroom-leveled.wav' },
  { name: 'spreader50_65ms', mainGain: 1, sendGain: 2.5, source: 'spreader50-65ms.wav' },
  // { name: 'spreader25_125ms', mainGain: 1, sendGain: 2.5, source: 'spreader25-125ms.wav' },
  // { name: 'backslap', mainGain: 1.8, sendGain: 0.8, source: 'backslap1.wav' },
  { name: 's3_r1_bd', mainGain: 1.8, sendGain: 0.8, source: 's3_r1_bd.wav' },
  { name: 'matrix_1', mainGain: 1.5, sendGain: 0.9, source: 'matrix-reverb1.wav' },
  { name: 'matrix_2', mainGain: 1.3, sendGain: 1, source: 'matrix-reverb2.wav' },
  { name: 'cardiod_35_10_spread', mainGain: 1.8, sendGain: 0.6, source: 'cardiod-35-10-spread.wav' },
  { name: 'tim_omni_35_10_magnetic', mainGain: 1, sendGain: 0.2, source: 'tim-omni-35-10-magnetic.wav' },
  // { name: 'spatialized', mainGain: 1.8, sendGain: 0.8, source: 'spatialized8.wav' },
  // { name: 'zing_long_stereo', mainGain: 0.8, sendGain: 1.8, source: 'zing-long-stereo.wav' },
  { name: 'feedback_spring', mainGain: 1.8, sendGain: 0.8, source: 'feedback-spring.wav' },
  // { name: 'tim_omni_rear_blend', mainGain: 1.8, sendGain: 0.8, source: 'tim-omni-rear-blend.wav' },
] as const
// 半音
// export const semitones = [-1.5, -1, -0.5, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] as const

let convolver: ConvolverNode
let convolverSourceGainNode: GainNode
let convolverOutputGainNode: GainNode
let convolverDynamicsCompressor: DynamicsCompressorNode
let gainNode: GainNode
let originalGainNode: GainNode
let equalizerGainNode: GainNode
let equalizerResponseFilter: BiquadFilterNode
let soundEffectMode: 'original' | 'effects' = 'effects'
let panner: PannerNode
let pitchShifterNode: AudioWorkletNode
let pitchShifterNodePitchFactor: AudioParam | null
let pitchShifterNodeLoadStatus: 'none' | 'loading' | 'unconnect' | 'connected' = 'none'
let pitchShifterNodeTempValue = 1
let pitchWorkletPromise: Promise<void> | null = null
let pitchWorkletLoaded = false
let pitchLoadGeneration = 0
let effectLoadError: string | null = null
let defaultChannelCount = 2
export const soundR = 0.5

type AudioFeature = 'soundEffects' | 'audioVisualization'
let featurePolicy: Record<AudioFeature, FeatureLoadMode> & { mediaDeviceId: string } = {
  soundEffects: 'onDemand', audioVisualization: 'onDemand', mediaDeviceId: 'default',
}
let maxOutputChannels = false
let analyserUsers = 0
let effectDisposalTimer: ReturnType<typeof setTimeout> | null = null
let savedEqualizerGains: number[] = freqs.map(() => 0)
const featureListeners = new Set<() => void>()
const effectsAllowed = () => featurePolicy.soundEffects != 'off' && featurePolicy.mediaDeviceId == 'default'
const effectsActive = () => effectsAllowed() && soundEffectMode == 'effects'
const notifyFeatureState = () => { for (const listener of featureListeners) listener() }

export const getAudioFeatureState = () => {
  const outputRemovable = audioContext != null && !maxOutputChannels &&
    featurePolicy.soundEffects == 'off' && featurePolicy.audioVisualization == 'off'
  const effectsRestartRequired = featurePolicy.soundEffects == 'off' && (outputRemovable || pitchWorkletLoaded)
  return {
    effectsLoaded: biquads != null,
    effectsActive: biquads != null && effectsActive(),
    analyserLoaded: analyser != null,
    analyserActive: analyser != null && analyserUsers > 0,
    deviceBlocked: featurePolicy.mediaDeviceId != 'default',
    error: effectLoadError,
    // The media source cannot be detached from its element. Never close its context:
    // only a new player can remove it, and maximum-channel output still needs it.
    restartRequired: outputRemovable || effectsRestartRequired,
    effectsRestartRequired,
    visualizationRestartRequired: outputRemovable,
  }
}

export const subscribeAudioFeatureState = (listener: () => void) => {
  featureListeners.add(listener)
  return () => { featureListeners.delete(listener) }
}

const releaseAnalyser = () => {
  if (!analyser) return
  mediaSource.disconnect(analyser)
  analyser.disconnect()
  analyser = null
  notifyFeatureState()
}

export const setAudioFeaturePolicy = (policy: typeof featurePolicy) => {
  featurePolicy = { ...policy }
  if (policy.audioVisualization == 'off' || policy.mediaDeviceId != 'default' ||
    (policy.audioVisualization != 'resident' && !analyserUsers)) releaseAnalyser()
  applySoundEffectMode()
  if (!effectsActive()) releaseEffects()
  notifyFeatureState()
}

export const prepareAudioFeature = (feature: AudioFeature) => {
  if (featurePolicy[feature] != 'resident' || featurePolicy.mediaDeviceId != 'default') return
  if (feature == 'soundEffects') initEffectNodes()
  else getAnalyser()
  notifyFeatureState()
}

export const acquireAnalyser = () => {
  const node = getAnalyser()
  if (!node) return null
  analyserUsers++
  notifyFeatureState()
  let released = false
  return {
    analyser: node,
    release() {
      if (released) return
      released = true
      analyserUsers--
      if (!analyserUsers && featurePolicy.audioVisualization != 'resident') releaseAnalyser()
      notifyFeatureState()
    },
  }
}


export const createAudio = () => {
  if (audio) return
  audio = new window.Audio() as HTMLAudioElementChrome
  audio.controls = false
  audio.autoplay = true
  audio.preload = 'auto'
  audio.crossOrigin = 'anonymous'
  resourceControllerInstance = createPlayerResourceController({
    audio,
    async adoptAudio(next) {
      const previous = audio!
      for (const [name, listeners] of audioListeners) {
        for (const listener of listeners) {
          previous.removeEventListener(name, listener)
          next.addEventListener(name, listener)
        }
      }
      next.volume = previous.volume
      next.muted = previous.muted
      next.defaultPlaybackRate = previous.defaultPlaybackRate
      next.playbackRate = previous.playbackRate
      next.preservesPitch = previous.preservesPitch
      next.loop = previous.loop
      next.preload = 'auto'
      audio = next as HTMLAudioElementChrome
      previous.autoplay = false
      previous.pause()
      previous.removeAttribute('src')
      previous.load()
      if (audioContext) {
        mediaSource.disconnect()
        mediaSource = audioContext.createMediaElementSource(next)
        handleMediaListChange()
      } else if (featurePolicy.mediaDeviceId != 'default') {
        await audio.setSinkId(featurePolicy.mediaDeviceId)
      }
    },
    canonicalizeUrl(value) {
      try { return new URL(value, window.location.href).href } catch { return value }
    },
  })
}

const initAnalyser = () => {
  analyser = audioContext.createAnalyser()
  analyser.fftSize = 256
}

const initBiquadFilter = () => {
  biquads = new Map()
  let i

  for (const item of freqs) {
    const filter = audioContext.createBiquadFilter()
    biquads.set(`hz${item}`, filter)
    filter.type = 'peaking'
    filter.frequency.value = item
    filter.Q.value = 1.4
    filter.gain.value = 0
  }

  for (i = 1; i < freqs.length; i++) {
    (biquads.get(`hz${freqs[i - 1]}`)!).connect(biquads.get(`hz${freqs[i]}`)!)
  }
  return biquads
}

const initConvolver = () => {
  convolverSourceGainNode = audioContext.createGain()
  convolverOutputGainNode = audioContext.createGain()
  convolverDynamicsCompressor = audioContext.createDynamicsCompressor()
  convolver = audioContext.createConvolver()
  convolver.connect(convolverOutputGainNode)
  convolverSourceGainNode.connect(convolverDynamicsCompressor)
  convolverOutputGainNode.connect(convolverDynamicsCompressor)
}

const initPanner = () => {
  panner = audioContext.createPanner()
}

const initGain = () => {
  gainNode = audioContext.createGain()
  equalizerGainNode = audioContext.createGain()
  equalizerResponseFilter = audioContext.createBiquadFilter()
  equalizerResponseFilter.type = 'peaking'
  equalizerResponseFilter.Q.value = 1.4
  gainNode.gain.value = 0
}

const initAdvancedAudioFeatures = () => {
  if (audioContext) return
  if (!audio) throw new Error('audio not defined')
  audioContext = new window.AudioContext({ latencyHint: 'playback' })
  defaultChannelCount = audioContext.destination.channelCount

  mediaSource = audioContext.createMediaElementSource(audio)
  originalGainNode = audioContext.createGain()
  mediaSource.connect(originalGainNode)
  originalGainNode.connect(audioContext.destination)

  window.app_event.on('playerDeviceChanged', handleMediaListChange)
  notifyFeatureState()
}

const initEffectNodes = () => {
  if (biquads || !effectsAllowed()) return
  initAdvancedAudioFeatures()
  const filters = initBiquadFilter()
  initConvolver()
  initPanner()
  initGain()
  mediaSource.connect(equalizerGainNode)
  equalizerGainNode.connect(filters.get(`hz${freqs[0]}`)!)
  const lastBiquadFilter = (filters.get(`hz${freqs.at(-1)!}`)!)
  lastBiquadFilter.connect(convolverSourceGainNode)
  lastBiquadFilter.connect(convolver)
  convolverSourceGainNode.connect(panner)
  panner.connect(gainNode)
  gainNode.connect(audioContext.destination)

  applySoundEffectMode()
  setEqualizerGains(savedEqualizerGains)
  if (!effectsActive()) releaseEffects()
  notifyFeatureState()
}

const handleMediaListChange = () => {
  mediaSource.disconnect()
  mediaSource.connect(originalGainNode)
  if (analyser) mediaSource.connect(analyser)
  if (biquads && isConnected) mediaSource.connect(equalizerGainNode)
}

// let isConnected = true
// const connectAudioNode = () => {
//   if (isConnected) return
//   console.log('connect Node')
//   mediaSource.connect(analyser)
//   isConnected = true
//   if (pitchShifterNodeTempValue == 1 && pitchShifterNodeLoadStatus == 'connected') {
//     disconnectPitchShifterNode()
//   }
// }

// const disconnectAudioNode = () => {
//   if (!isConnected) return
//   console.log('disconnect Node')
//   mediaSource.disconnect()
//   isConnected = false
//   if (pitchShifterNodeTempValue == 1 && pitchShifterNodeLoadStatus == 'connected') {
//     disconnectPitchShifterNode()
//   }
// }

export const getAudioContext = () => {
  initAdvancedAudioFeatures()
  return audioContext
}

let unsubMediaListChangeEvent: (() => void) | null = null
export const setMaxOutputChannelCount = (enable: boolean) => {
  maxOutputChannels = enable
  if (enable) {
    initAdvancedAudioFeatures()
    audioContext.destination.channelCountMode = 'max'
    audioContext.destination.channelCount = audioContext.destination.maxChannelCount
    // navigator.mediaDevices.addEventListener('devicechange', handleMediaListChange)
    if (!unsubMediaListChangeEvent) {
      let handleMediaListChange = () => {
        setMaxOutputChannelCount(true)
      }
      window.app_event.on('playerDeviceChanged', handleMediaListChange)
      unsubMediaListChangeEvent = () => {
        window.app_event.off('playerDeviceChanged', handleMediaListChange)
        unsubMediaListChangeEvent = null
      }
    }
  } else {
    unsubMediaListChangeEvent?.()
    if (audioContext && audioContext.destination.channelCountMode != 'explicit') {
      audioContext.destination.channelCount = defaultChannelCount
      // audioContext.destination.channelInterpretation
      audioContext.destination.channelCountMode = 'explicit'
    }
  }
  notifyFeatureState()
}

export const getAnalyser = (): AnalyserNode | null => {
  if (featurePolicy.audioVisualization == 'off' || featurePolicy.mediaDeviceId != 'default') return null
  initAdvancedAudioFeatures()
  if (!analyser) {
    initAnalyser()
    mediaSource.connect(analyser!)
    notifyFeatureState()
  }
  return analyser
}

export const getBiquadFilter = () => {
  initEffectNodes()
  return biquads
}

export const setSoundEffectMode = (mode: 'original' | 'effects') => {
  soundEffectMode = mode == 'original' ? 'original' : 'effects'
  if (effectsActive()) setEqualizerGains(savedEqualizerGains)
  applySoundEffectMode()
  if (!effectsActive()) releaseEffects()
  notifyFeatureState()
}

const applySoundEffectMode = () => {
  if (effectDisposalTimer) {
    clearTimeout(effectDisposalTimer)
    effectDisposalTimer = null
  }
  if (!audioContext) return
  const active = effectsActive() && biquads != null
  if (active && !isConnected) connectNode()
  const now = audioContext.currentTime
  for (const [node, target] of [
    [originalGainNode, active ? 0 : 1],
    [gainNode, active ? 1 : 0],
  ] as const) {
    if (!node) continue
    node.gain.cancelAndHoldAtTime(now)
    node.gain.setValueAtTime(node.gain.value, now)
    if (now == 0) node.gain.setValueAtTime(target, now)
    else node.gain.linearRampToValueAtTime(target, now + 0.02)
  }
}

const releaseEffects = () => {
  stopPanner()
  pitchLoadGeneration++
  if (pitchShifterNodeLoadStatus == 'loading') pitchShifterNodeLoadStatus = 'none'
  if (!biquads) return
  const dispose = () => {
    effectDisposalTimer = null
    if (effectsActive()) return
    if (pitchShifterNodeLoadStatus == 'connected') disconnectPitchShifterNode()
    if (isConnected) mediaSource.disconnect(equalizerGainNode)
    isConnected = false
    if (effectsAllowed() && featurePolicy.soundEffects == 'resident') return
    pitchShifterNode?.disconnect()
    pitchShifterNode?.port.close()
    pitchShifterNode = undefined!
    pitchShifterNodePitchFactor = null
    pitchShifterNodeLoadStatus = 'none'
    convolver.buffer = null
    for (const node of [...biquads.values(), equalizerResponseFilter, equalizerGainNode, convolver,
      convolverSourceGainNode, convolverOutputGainNode, convolverDynamicsCompressor, panner, gainNode]) node.disconnect()
    biquads = undefined!
    equalizerResponseFilter = equalizerGainNode = convolver = convolverSourceGainNode = convolverOutputGainNode = convolverDynamicsCompressor = panner = gainNode = undefined!
    isConnected = true
    notifyFeatureState()
  }
  // Let the existing 20 ms crossfade finish before disconnecting its branch.
  if (audioContext.currentTime == 0) dispose()
  else effectDisposalTimer = setTimeout(dispose, 30)
}

const getEqualizerHeadroom = (gains: readonly number[]) => {
  if (gains.every(gain => gain <= 0)) return 1
  const nyquist = audioContext.sampleRate / 2
  const frequencies = new Float32Array([
    0,
    ...Array.from({ length: 2048 }, (_, i) => 10 * (nyquist / 10) ** (i / 2048)),
    ...freqs.filter(freq => freq < nyquist),
  ])
  const magnitudes = new Float32Array(frequencies.length)
  const phases = new Float32Array(frequencies.length)
  const combined = new Float64Array(frequencies.length).fill(1)
  for (let band = 0; band < freqs.length; band++) {
    equalizerResponseFilter.frequency.value = freqs[band]
    equalizerResponseFilter.gain.value = gains[band]
    equalizerResponseFilter.getFrequencyResponse(frequencies, magnitudes, phases)
    for (let i = 0; i < combined.length; i++) combined[i] *= magnitudes[i]
  }
  const maximum = Math.max(1, ...combined)
  if (!Number.isFinite(maximum)) {
    return 10 ** (-(gains.reduce((sum, gain) => sum + Math.max(0, gain), 0) + 1) / 20)
  }
  // Allow for overlapping bands, with 1 dB extra headroom for boosted curves.
  return maximum > 1.000001 ? 1 / (maximum * 10 ** (1 / 20)) : 1
}

export const setEqualizerGains = (gains: readonly number[]) => {
  const targets = freqs.map((_, i) => Number.isFinite(gains[i]) ? Math.max(-15, Math.min(15, gains[i])) : 0)
  savedEqualizerGains = targets
  if (!effectsActive() || (!biquads && targets.every(gain => gain == 0))) return
  initEffectNodes()
  const now = audioContext.currentTime
  const filters = freqs.map(freq => biquads.get(`hz${freq}`)!)
  const targetHeadroom = getEqualizerHeadroom(targets)
  equalizerGainNode.gain.cancelAndHoldAtTime(now)
  equalizerGainNode.gain.setValueAtTime(equalizerGainNode.gain.value, now)
  for (const filter of filters) filter.gain.cancelAndHoldAtTime(now)
  if (now == 0) {
    equalizerGainNode.gain.setValueAtTime(targetHeadroom, now)
    filters.forEach((filter, i) => filter.gain.setValueAtTime(targets[i], now))
    return
  }

  // Attenuate before boosting, then restore gain after the new curve settles.
  // The per-band envelope also covers interrupted/overlapping slider changes.
  const currentGains = filters.map(filter => filter.gain.value)
  const transitionHeadroom = Math.min(equalizerGainNode.gain.value,
    getEqualizerHeadroom(targets.map((target, i) => Math.max(target, currentGains[i]))))
  equalizerGainNode.gain.linearRampToValueAtTime(transitionHeadroom, now + 0.01)
  equalizerGainNode.gain.setValueAtTime(transitionHeadroom, now + 0.03)
  equalizerGainNode.gain.linearRampToValueAtTime(targetHeadroom, now + 0.05)
  filters.forEach((filter, i) => {
    filter.gain.setValueAtTime(currentGains[i], now + 0.01)
    filter.gain.linearRampToValueAtTime(targets[i], now + 0.03)
  })
}

export const setConvolver = (buffer: AudioBuffer | null, mainGain: number, sendGain: number) => {
  if (!effectsActive() || (!buffer && !biquads)) return
  initEffectNodes()
  const wasEnabled = convolver.buffer != null
  convolver.buffer = buffer
  // console.log(mainGain, sendGain)
  if (buffer) {
    convolverSourceGainNode.gain.value = mainGain
    convolverOutputGainNode.gain.value = sendGain
  } else {
    convolverSourceGainNode.gain.value = 1
    convolverOutputGainNode.gain.value = 0
  }

  if (wasEnabled == (buffer != null)) return
  if (buffer) {
    convolverSourceGainNode.disconnect(panner)
    convolverDynamicsCompressor.connect(panner)
  } else {
    convolverDynamicsCompressor.disconnect(panner)
    convolverSourceGainNode.connect(panner)
  }
}

export const setConvolverMainGain = (gain: number) => {
  if (!convolverSourceGainNode || !effectsActive()) return
  if (convolverSourceGainNode.gain.value == gain) return
  // console.log(gain)
  convolverSourceGainNode.gain.value = gain
}

export const setConvolverSendGain = (gain: number) => {
  if (!convolverOutputGainNode || !effectsActive()) return
  if (convolverOutputGainNode.gain.value == gain) return
  // console.log(gain)
  convolverOutputGainNode.gain.value = gain
}

let pannerInfo = {
  x: 0,
  y: 0,
  z: 0,
  soundR: 0.5,
  rad: 0,
  speed: 1,
  intv: null as NodeJS.Timeout | null,
}
const setPannerXYZ = (nx: number, ny: number, nz: number) => {
  pannerInfo.x = nx
  pannerInfo.y = ny
  pannerInfo.z = nz
  // console.log(pannerInfo)
  panner.positionX.value = nx * pannerInfo.soundR
  panner.positionY.value = ny * pannerInfo.soundR
  panner.positionZ.value = nz * pannerInfo.soundR
}
export const setPannerSoundR = (r: number) => {
  pannerInfo.soundR = r
}

export const setPannerSpeed = (speed: number) => {
  pannerInfo.speed = speed
  if (pannerInfo.intv) startPanner()
}
export const stopPanner = () => {
  if (pannerInfo.intv) {
    clearInterval(pannerInfo.intv)
    pannerInfo.intv = null
    pannerInfo.rad = 0
  }
  if (!panner) return
  panner.positionX.value = 0
  panner.positionY.value = 0
  panner.positionZ.value = 0
}

export const startPanner = () => {
  if (!effectsActive()) return
  initEffectNodes()
  if (pannerInfo.intv) {
    clearInterval(pannerInfo.intv)
    pannerInfo.intv = null
    pannerInfo.rad = 0
  }
  pannerInfo.intv = setInterval(() => {
    pannerInfo.rad += 1
    if (pannerInfo.rad > 360) pannerInfo.rad -= 360
    setPannerXYZ(Math.sin(pannerInfo.rad * Math.PI / 180), Math.cos(pannerInfo.rad * Math.PI / 180), Math.cos(pannerInfo.rad * Math.PI / 180))
  }, pannerInfo.speed * 10)
}

let isConnected = true
const connectNode = () => {
  if (isConnected) return
  if (biquads) mediaSource.connect(equalizerGainNode)
  isConnected = true
  if (pitchShifterNodeTempValue == 1 && pitchShifterNodeLoadStatus == 'connected') {
    disconnectPitchShifterNode()
  }
}
const disconnectNode = () => {
  if (!isConnected) return
  if (biquads) mediaSource.disconnect(equalizerGainNode)
  isConnected = false
  if (pitchShifterNodeTempValue == 1 && pitchShifterNodeLoadStatus == 'connected') {
    disconnectPitchShifterNode()
  }
}
const connectPitchShifterNode = () => {
  console.log('connect Pitch Shifter Node')
  addAudioListener('playing', connectNode)
  addAudioListener('pause', disconnectNode)
  addAudioListener('waiting', disconnectNode)
  addAudioListener('emptied', disconnectNode)
  if (audio!.paused) disconnectNode()

  const lastBiquadFilter = (biquads.get(`hz${freqs.at(-1)!}`)!)
  lastBiquadFilter.disconnect()
  lastBiquadFilter.connect(pitchShifterNode)

  pitchShifterNode.connect(convolver)
  pitchShifterNode.connect(convolverSourceGainNode)
  // convolverDynamicsCompressor.disconnect(panner)
  // convolverDynamicsCompressor.connect(pitchShifterNode)
  // pitchShifterNode.connect(panner)
  pitchShifterNodeLoadStatus = 'connected'
  pitchShifterNodePitchFactor = pitchShifterNode.parameters.get('pitchFactor')!
  pitchShifterNodePitchFactor.value = pitchShifterNodeTempValue
}
const disconnectPitchShifterNode = () => {
  console.log('disconnect Pitch Shifter Node')
  const lastBiquadFilter = (biquads.get(`hz${freqs.at(-1)!}`)!)
  lastBiquadFilter.disconnect()
  lastBiquadFilter.connect(convolver)
  lastBiquadFilter.connect(convolverSourceGainNode)
  pitchShifterNode.disconnect()
  pitchShifterNodeLoadStatus = 'unconnect'
  pitchShifterNodePitchFactor = null

  removeAudioListener('playing', connectNode)
  removeAudioListener('pause', disconnectNode)
  removeAudioListener('waiting', disconnectNode)
  removeAudioListener('emptied', disconnectNode)
  connectNode()
}
const loadPitchShifterNode = () => {
  pitchShifterNodeLoadStatus = 'loading'
  const token = ++pitchLoadGeneration
  effectLoadError = null
  initEffectNodes()
  // source -> analyser -> biquadFilter -> audioWorklet(pitch shifter) -> [(convolver & convolverSource)->convolverDynamicsCompressor] -> panner -> gain
  pitchWorkletPromise ??= audioContext.audioWorklet.addModule(new URL(
    /* webpackChunkName: 'pitch_shifter.audioWorklet' */
    './pitch-shifter/phase-vocoder.js',
    import.meta.url,
  )).then(() => {
    pitchWorkletLoaded = true
    notifyFeatureState()
  }).catch(error => {
    pitchWorkletPromise = null
    throw error
  })
  void pitchWorkletPromise.then(() => {
    if (token != pitchLoadGeneration) return
    if (pitchShifterNodeTempValue == 1 || !effectsActive() || !biquads) {
      pitchShifterNodeLoadStatus = 'none'
      return
    }
    // https://github.com/olvb/phaze/issues/26#issuecomment-1574629971
    pitchShifterNode = new AudioWorkletNode(audioContext, 'phase-vocoder-processor', { outputChannelCount: [2] })
    let pitchFactorParam = pitchShifterNode.parameters.get('pitchFactor')
    if (!pitchFactorParam) return
    pitchShifterNodePitchFactor = pitchFactorParam
    pitchShifterNodeLoadStatus = 'unconnect'
    connectPitchShifterNode()
    notifyFeatureState()
  }).catch(error => {
    if (token != pitchLoadGeneration) return
    pitchShifterNodeLoadStatus = 'none'
    effectLoadError = error instanceof Error ? error.message : String(error)
    notifyFeatureState()
    console.error('pitch shifter audio worklet failed', error)
  })
}

export const setPitchShifter = (val: number) => {
  // console.log('setPitchShifter', val)
  pitchShifterNodeTempValue = val
  if (!effectsActive()) return
  if (val == 1) {
    if (pitchShifterNodeLoadStatus == 'connected') disconnectPitchShifterNode()
    return
  }
  initEffectNodes()
  switch (pitchShifterNodeLoadStatus) {
    case 'loading':
      break
    case 'none':
      loadPitchShifterNode()
      break
    case 'connected':
      // a: 1 = 半音
      // value = 2 ** (a / 12)
      pitchShifterNodePitchFactor!.value = val
      break
    case 'unconnect':
      connectPitchShifterNode()
      break
  }
}

export const hasInitedAdvancedAudioFeatures = (): boolean => audioContext != null

export const createPlayerResourceController: CreatePlayerResourceController = deps => {
  let nextResourceGeneration = 0
  let resourceContext: PlayerResourceContext | null = null
  const handlers = {
    canplay: new Set<(event: ResourceMediaEvent) => void>(),
    error: new Set<(event: ResourceMediaEvent) => void>(),
    loadstart: new Set<(event: ResourceMediaEvent) => void>(),
    loadeddata: new Set<(event: ResourceMediaEvent) => void>(),
    waiting: new Set<(event: ResourceMediaEvent) => void>(),
  }
  const installed = new Map<keyof typeof handlers, EventListener>()
  let removePendingSeek: (() => void) | null = null
  let pendingOutput: Promise<void> | null = null

  const clearAudio = () => {
    removePendingSeek?.()
    removePendingSeek = null
    resourceContext = null
    deps.audio.pause()
    deps.audio.removeAttribute('src')
    deps.audio.load()
  }
  const installResourceListeners = (generation: number) => {
    for (const [name, oldListener] of installed) deps.audio.removeEventListener(name, oldListener)
    installed.clear()
    for (const name of Object.keys(handlers) as Array<keyof typeof handlers>) {
      const listener = () => {
        const current = resourceContext
        if (!current || current.resourceGeneration != generation) return
        const event = { resource: current, currentSrc: deps.audio.currentSrc || deps.audio.src }
        for (const handler of handlers[name]) handler(event)
      }
      installed.set(name, listener)
      deps.audio.addEventListener(name, listener)
    }
  }
  const isCurrentResourceEvent = (dispatched: PlayerResourceContext, currentSrc: string) => {
    const current = resourceContext
    return current != null &&
      current.resourceGeneration == dispatched.resourceGeneration &&
      current.songIdentity == dispatched.songIdentity &&
      deps.canonicalizeUrl(current.url) == deps.canonicalizeUrl(dispatched.url) &&
      deps.canonicalizeUrl(currentSrc) == deps.canonicalizeUrl(dispatched.url)
  }
  const subscribe = (name: keyof typeof handlers) => (
    handler: (event: ResourceMediaEvent) => void,
  ) => {
    handlers[name].add(handler)
    return () => { handlers[name].delete(handler) }
  }

  return {
    setResource(url, options) {
      removePendingSeek?.()
      removePendingSeek = null
      const buffered = options.preloadedAudio
      const adopting = buffered != null && !buffered.error &&
        deps.canonicalizeUrl(buffered.src) == deps.canonicalizeUrl(url)
      if (buffered && !adopting) {
        buffered.pause()
        buffered.removeAttribute('src')
        buffered.load()
      }
      let adopted: Promise<void> | undefined
      if (adopting) {
        for (const [name, listener] of installed) deps.audio.removeEventListener(name, listener)
        installed.clear()
        adopted = deps.adoptAudio?.(buffered)
        pendingOutput = adopted ?? null
        deps.audio = buffered
      }
      const outputReady = pendingOutput
      const context = { ...options.resource, resourceGeneration: ++nextResourceGeneration }
      resourceContext = context
      installResourceListeners(context.resourceGeneration)
      const shouldPlay = options.shouldPlay != false
      deps.audio.autoplay = adopting || outputReady ? false : shouldPlay
      if (!shouldPlay) deps.audio.pause()
      if ((options.startTime ?? 0) > 0) {
        let active = true
        const seek = () => {
          if (!active) return
          active = false
          deps.audio.removeEventListener('loadedmetadata', seek)
          if (resourceContext?.resourceGeneration != context.resourceGeneration) return
          deps.audio.currentTime = options.startTime!
          removePendingSeek = null
        }
        deps.audio.addEventListener('loadedmetadata', seek)
        removePendingSeek = () => {
          if (!active) return
          active = false
          deps.audio.removeEventListener('loadedmetadata', seek)
        }
        if (adopting && deps.audio.readyState >= 1) seek()
      }
      if (!adopting) deps.audio.src = url
      const start = () => {
        if (resourceContext?.resourceGeneration != context.resourceGeneration) return
        if (adopting || outputReady) deps.audio.autoplay = shouldPlay
        if (adopting) {
          installed.get('loadeddata')?.(new Event('loadeddata'))
          if (deps.audio.readyState >= 3) installed.get('canplay')?.(new Event('canplay'))
        }
        if (shouldPlay) void deps.audio.play().catch(() => {})
        else deps.audio.pause()
      }
      if (adopting || outputReady) {
        void Promise.resolve(outputReady).then(() => {
          if (pendingOutput == outputReady) pendingOutput = null
          start()
        }).catch(() => {
          if (pendingOutput == outputReady) pendingOutput = null
          if (resourceContext?.resourceGeneration == context.resourceGeneration) {
            installed.get('error')?.(new Event('error'))
          }
        })
      } else start()
      return context
    },
    setStop: clearAudio,
    getResourceContext: () => resourceContext,
    replaceResourceContext(expected, resource) {
      if (resourceContext?.resourceGeneration != expected.resourceGeneration) return false
      resourceContext = { ...resource, resourceGeneration: expected.resourceGeneration }
      return true
    },
    clearResourceIf(expected) {
      if (!resourceContext || resourceContext.kind != expected.kind ||
          resourceContext.songIdentity != expected.songIdentity || resourceContext.url != expected.url) return false
      if ('candidateId' in expected &&
          (resourceContext.kind != 'candidate' || resourceContext.candidateId != expected.candidateId)) return false
      clearAudio()
      return true
    },
    isCurrentResourceEvent,
    onCanplay: subscribe('canplay'),
    onError: subscribe('error'),
    onLoadstart: subscribe('loadstart'),
    onLoadeddata: subscribe('loadeddata'),
    onWaiting: subscribe('waiting'),
  }
}

let resourceControllerInstance: PlayerResourceController | null = null

const requireResourceController = (): PlayerResourceController => {
  if (!resourceControllerInstance) throw new Error('Player resource controller is not initialized')
  return resourceControllerInstance
}

export const playerResourceController: PlayerResourceController = {
  setResource: (...args) => requireResourceController().setResource(...args),
  setStop: () => { requireResourceController().setStop() },
  getResourceContext: () => requireResourceController().getResourceContext(),
  replaceResourceContext: (...args) => requireResourceController().replaceResourceContext(...args),
  clearResourceIf: (...args) => requireResourceController().clearResourceIf(...args),
  isCurrentResourceEvent: (...args) => requireResourceController().isCurrentResourceEvent(...args),
  onCanplay: handler => requireResourceController().onCanplay(handler),
  onError: handler => requireResourceController().onError(handler),
  onLoadstart: handler => requireResourceController().onLoadstart(handler),
  onLoadeddata: handler => requireResourceController().onLoadeddata(handler),
  onWaiting: handler => requireResourceController().onWaiting(handler),
}

export const setResource: PlayerResourceController['setResource'] = (...args) => (
  playerResourceController.setResource(...args)
)
export const setStop = () => { playerResourceController.setStop() }
export const getResourceContext = () => playerResourceController.getResourceContext()
export const replaceResourceContext: PlayerResourceController['replaceResourceContext'] = (...args) => (
  playerResourceController.replaceResourceContext(...args)
)
export const clearResourceIf: PlayerResourceController['clearResourceIf'] = (...args) => (
  playerResourceController.clearResourceIf(...args)
)

export const setPlay = () => {
  void audio?.play()
}

export const setPause = () => {
  audio?.pause()
}

export const isEmpty = (): boolean => !audio?.src

export const setLoopPlay = (isLoop: boolean) => {
  if (audio) audio.loop = isLoop
}

export const getPlaybackRate = (): number => {
  return audio?.defaultPlaybackRate ?? 1
}

export const setPlaybackRate = (rate: number) => {
  if (!audio) return
  audio.defaultPlaybackRate = rate
  audio.playbackRate = rate
}

export const setPreservesPitch = (preservesPitch: boolean) => {
  if (!audio) return
  audio.preservesPitch = preservesPitch
}

export const getMute = (): boolean => {
  return audio?.muted ?? false
}

export const setMute = (isMute: boolean) => {
  if (audio) audio.muted = isMute
}

export const getCurrentTime = () => {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  return audio?.currentTime || 0
}

export const setCurrentTime = (time: number) => {
  if (audio) audio.currentTime = time
}

export const setMediaDeviceId = async(mediaDeviceId: string): Promise<void> => {
  if (!audio) return
  return audio.setSinkId(mediaDeviceId)
}

export const setVolume = (volume: number) => {
  if (audio) audio.volume = volume
}

export const getDuration = () => {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  return audio?.duration || 0
}

// export const getPlaybackRate = () => {
//   return audio?.playbackRate ?? 1
// }

type Noop = () => void

export const onPlaying = (callback: Noop) => {
  if (!audio) throw new Error('audio not defined')

  addAudioListener('playing', callback)
  return () => {
    removeAudioListener('playing', callback)
  }
}

export const onPause = (callback: Noop) => {
  if (!audio) throw new Error('audio not defined')

  addAudioListener('pause', callback)
  return () => {
    removeAudioListener('pause', callback)
  }
}

export const onEnded = (callback: Noop) => {
  if (!audio) throw new Error('audio not defined')

  addAudioListener('ended', callback)
  return () => {
    removeAudioListener('ended', callback)
  }
}

export const onError: PlayerResourceController['onError'] = handler => (
  playerResourceController.onError(handler)
)

export const onLoadeddata: PlayerResourceController['onLoadeddata'] = handler => (
  playerResourceController.onLoadeddata(handler)
)

export const onLoadstart: PlayerResourceController['onLoadstart'] = handler => (
  playerResourceController.onLoadstart(handler)
)

export const onCanplay: PlayerResourceController['onCanplay'] = handler => (
  playerResourceController.onCanplay(handler)
)

export const onEmptied = (callback: Noop) => {
  if (!audio) throw new Error('audio not defined')

  addAudioListener('emptied', callback)
  return () => {
    removeAudioListener('emptied', callback)
  }
}

export const onTimeupdate = (callback: Noop) => {
  if (!audio) throw new Error('audio not defined')

  addAudioListener('timeupdate', callback)
  return () => {
    removeAudioListener('timeupdate', callback)
  }
}

// 缓冲中
export const onWaiting: PlayerResourceController['onWaiting'] = handler => (
  playerResourceController.onWaiting(handler)
)

export const onSeeking = (callback: Noop) => {
  if (!audio) throw new Error('audio not defined')

  addAudioListener('seeking', callback)
  return () => {
    removeAudioListener('seeking', callback)
  }
}

export const onSeeked = (callback: Noop) => {
  if (!audio) throw new Error('audio not defined')

  addAudioListener('seeked', callback)
  return () => {
    removeAudioListener('seeked', callback)
  }
}

export const onRatechange = (callback: Noop) => {
  if (!audio) throw new Error('audio not defined')

  addAudioListener('ratechange', callback)
  return () => {
    removeAudioListener('ratechange', callback)
  }
}

// 可见性改变
export const onVisibilityChange = (callback: Noop) => {
  document.addEventListener('visibilitychange', callback)
  return () => {
    document.removeEventListener('visibilitychange', callback)
  }
}


export const getErrorCode = () => {
  return audio?.error?.code
}
