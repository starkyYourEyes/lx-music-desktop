import { computed, watch } from '@common/utils/vueTools'
import { onScopeDispose } from 'vue'
import {
  freqs, getAudioContext, setEqualizerGains, setSoundEffectMode, setConvolver,
  setPannerSoundR, setPannerSpeed, startPanner, stopPanner, setConvolverMainGain,
  setConvolverSendGain, setPitchShifter, setAudioFeaturePolicy, prepareAudioFeature,
  getAudioFeatureState, subscribeAudioFeatureState,
} from '@renderer/plugins/player'
import { getFeatureMode } from '@common/performance/featurePolicy'
import { reportFeatureState, registerFeaturePreparation } from '@renderer/core/features/runtime'
import { appSetting } from '@renderer/store/setting'
import { createConvolutionBufferCache } from './convolutionBufferCache'

const loadBuffer = async(name: string, signal: AbortSignal) => new Promise<AudioBuffer>((resolve, reject) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('@renderer/assets/medias/filters/' + name) as string
  const request = new XMLHttpRequest()
  request.open('GET', path, true)
  request.responseType = 'arraybuffer'
  const abort = () => { request.abort(); reject(new Error('Convolution load cancelled')) }
  signal.addEventListener('abort', abort, { once: true })
  const cleanup = () => { signal.removeEventListener('abort', abort) }
  request.onload = () => {
    cleanup()
    if (signal.aborted) return
    if (request.status && (request.status < 200 || request.status >= 300)) {
      reject(new Error(`Convolution load failed: ${request.status}`))
      return
    }
    void getAudioContext().decodeAudioData(request.response).then(resolve, reject)
  }
  request.onerror = () => { cleanup(); reject(new Error('Convolution load failed')) }
  request.onabort = () => { cleanup(); reject(new Error('Convolution load cancelled')) }
  request.send()
})

export default () => {
  const cache = createConvolutionBufferCache(loadBuffer)
  const soundMode = computed(() => getFeatureMode(appSetting, 'soundEffects'))
  const visualMode = computed(() => getFeatureMode(appSetting, 'audioVisualization'))
  const effectsEnabled = computed(() => soundMode.value != 'off' &&
    appSetting['player.soundEffect.mode'] == 'effects' &&
    (!appSetting['player.mediaDeviceId'] || appSetting['player.mediaDeviceId'] == 'default'))
  let bufferGeneration = 0
  let effectError: string | null = null
  const report = () => {
    const state = getAudioFeatureState()
    const blockedError = state.deviceBlocked ? 'player__sound_effect_features_tip' : null
    reportFeatureState('soundEffects', {
      loaded: state.effectsLoaded,
      active: state.effectsActive,
      restartRequired: state.effectsRestartRequired,
      error: effectError ?? state.error ?? (soundMode.value != 'off' ? blockedError : null),
    })
    reportFeatureState('audioVisualization', {
      loaded: state.analyserLoaded,
      active: state.analyserActive,
      restartRequired: state.visualizationRestartRequired,
      error: visualMode.value != 'off' ? blockedError : null,
    })
  }
  const unsubscribe = subscribeAudioFeatureState(report)
  const prepareEffects = () => { prepareAudioFeature('soundEffects'); report() }
  const prepareVisualization = () => { prepareAudioFeature('audioVisualization'); report() }
  const unregisterEffects = registerFeaturePreparation('soundEffects', async() => {
    prepareEffects()
    if (effectsEnabled.value) {
      if (effectError) await applyConvolution()
      if (getAudioFeatureState().error) setPitchShifter(appSetting['player.soundEffect.pitchShifter.playbackRate'])
    }
  })
  const unregisterVisualization = registerFeaturePreparation('audioVisualization', prepareVisualization)
  watch(() => [soundMode.value, visualMode.value, appSetting['player.mediaDeviceId']], () => {
    setAudioFeaturePolicy({
      soundEffects: soundMode.value,
      audioVisualization: visualMode.value,
      mediaDeviceId: appSetting['player.mediaDeviceId'] || 'default',
    })
  }, { immediate: true, flush: 'sync' })
  watch(() => effectsEnabled.value ? 'effects' : 'original', setSoundEffectMode, { immediate: true, flush: 'sync' })
  watch(() => [soundMode.value, visualMode.value, appSetting['player.mediaDeviceId']], () => {
    prepareEffects()
    prepareVisualization()
  }, { immediate: true })
  watch(() => freqs.map(freq => appSetting[`player.soundEffect.biquadFilter.hz${freq}`]),
    setEqualizerGains, { immediate: true })
  watch(() => [effectsEnabled.value, appSetting['player.soundEffect.panner.enable']], () => {
    if (effectsEnabled.value && appSetting['player.soundEffect.panner.enable']) startPanner()
    else stopPanner()
  }, { immediate: true })
  watch(() => appSetting['player.soundEffect.panner.soundR'], value => { setPannerSoundR(value / 10) }, { immediate: true })
  watch(() => appSetting['player.soundEffect.panner.speed'], value => { setPannerSpeed(2 * (value / 10)) }, { immediate: true })
  const applyConvolution = async() => {
    const token = ++bufferGeneration
    const fileName = appSetting['player.soundEffect.convolution.fileName']
    effectError = null
    if (!effectsEnabled.value) {
      cache.clear()
      setConvolver(null, 0, 0)
      report()
      return
    }
    if (!fileName) {
      cache.clear()
      setConvolver(null, 0, 0)
      report()
      return
    }
    try {
      const buffer = await cache.get(fileName)
      if (token != bufferGeneration || !effectsEnabled.value) return
      setConvolver(buffer, appSetting['player.soundEffect.convolution.mainGain'] / 10,
        appSetting['player.soundEffect.convolution.sendGain'] / 10)
    } catch (error) {
      if (token != bufferGeneration) return
      effectError = error instanceof Error ? error.message : String(error)
    }
    report()
  }
  watch(() => [effectsEnabled.value, appSetting['player.soundEffect.convolution.fileName']],
    () => { void applyConvolution() }, { immediate: true })
  watch(() => appSetting['player.soundEffect.convolution.mainGain'], value => {
    if (effectsEnabled.value && appSetting['player.soundEffect.convolution.fileName']) setConvolverMainGain(value / 10)
  })
  watch(() => appSetting['player.soundEffect.convolution.sendGain'], value => {
    if (effectsEnabled.value && appSetting['player.soundEffect.convolution.fileName']) setConvolverSendGain(value / 10)
  })
  watch(() => [effectsEnabled.value, appSetting['player.soundEffect.pitchShifter.playbackRate']], () => {
    setPitchShifter(effectsEnabled.value ? appSetting['player.soundEffect.pitchShifter.playbackRate'] : 1)
  }, { immediate: true })
  onScopeDispose(() => {
    bufferGeneration++
    cache.clear()
    stopPanner()
    unregisterEffects()
    unregisterVisualization()
    unsubscribe()
  })
}
