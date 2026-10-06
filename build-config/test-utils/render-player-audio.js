const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const outputPath = process.argv[2]
app.setPath('userData', path.join(outputPath, 'profile'))
app.disableHardwareAcceleration()

const renderCases = async(pluginCode) => {
  const render = async(scenario, sampleRate, amplitude, reference) => {
    const context = new window.OfflineAudioContext(2, sampleRate * 3, sampleRate)
    const input = context.createBuffer(2, sampleRate * 3, sampleRate)
    for (let channel = 0; channel < 2; channel++) {
      const samples = input.getChannelData(channel)
      const frequency = scenario == 'mode-live' ? (channel ? 70 : 100) : (channel ? 700 : 1000)
      for (let i = 0; i < samples.length; i++) {
        samples[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate)
      }
    }
    const source = context.createBufferSource()
    source.buffer = input
    const impulse = context.createBuffer(1, 256, sampleRate)
    impulse.getChannelData(0)[0] = 1
    const wet = scenario == 'enabled' || scenario == 'reenabled'
    const changesDuringPlayback = []

    if (reference) {
      if (wet) {
        // Characterize the existing convolution sound, including its compressor.
        const dryGain = context.createGain()
        dryGain.gain.value = 1.8
        const wetGain = context.createGain()
        wetGain.gain.value = 0.9
        const convolver = context.createConvolver()
        convolver.buffer = impulse
        const compressor = context.createDynamicsCompressor()
        const panner = context.createPanner()
        source.connect(dryGain).connect(compressor)
        source.connect(convolver).connect(wetGain).connect(compressor)
        compressor.connect(panner).connect(context.destination)
      } else if (['eq', 'restore-effects', 'boost', 'eq-live', 'visualization-off'].includes(scenario)) {
        const filter = context.createBiquadFilter()
        filter.type = 'peaking'
        filter.frequency.value = 1000
        filter.Q.value = 1.4
        filter.gain.value = scenario == 'boost' || scenario == 'eq-live' ? 6 : -6
        const preamp = context.createGain()
        // +6 dB at the center needs -7 dB preamp, including the 1 dB margin.
        preamp.gain.value = filter.gain.value > 0 ? 10 ** (-7 / 20) : 1
        source.connect(preamp).connect(filter).connect(context.destination)
      } else source.connect(context.destination)
    } else {
      // Substitute only the media input; the production graph and DSP nodes are real.
      window.AudioContext = function() { return context }
      context.createMediaElementSource = () => source
      window.app_event = { on() {}, off() {} }
      const player = {}
      // Execute the compiled production module inside the isolated test page.
      // eslint-disable-next-line no-new-func
      new Function('exports', pluginCode)(player)
      if (scenario == 'original') player.setSoundEffectMode('original')
      player.createAudio()
      player.getAnalyser()
      const eq = gain => player.freqs.map(freq => freq == 1000 ? gain : 0)
      if (['eq', 'restore-effects', 'visualization-off'].includes(scenario)) player.setEqualizerGains(eq(-6))
      if (scenario == 'visualization-off') {
        player.setAudioFeaturePolicy({ soundEffects: 'onDemand', audioVisualization: 'off', mediaDeviceId: 'default' })
      }
      if (scenario == 'policy-off' || scenario == 'effects-off-live') {
        player.setEqualizerGains(eq(6))
        player.setConvolver(impulse, 1.8, 0.9)
        const disableEffects = () => player.setAudioFeaturePolicy({ soundEffects: 'off', audioVisualization: 'off', mediaDeviceId: 'default' })
        if (scenario == 'policy-off') disableEffects()
        else {
          changesDuringPlayback.push(context.suspend(1).then(() => {
            disableEffects()
            return context.resume()
          }))
        }
      }
      if (['boost', 'original', 'eq-reset'].includes(scenario)) player.setEqualizerGains(eq(6))
      if (scenario == 'overlap') player.setEqualizerGains(player.freqs.map(freq => [500, 1000, 2000].includes(freq) ? 12 : 0))
      if (scenario == 'eq-reset') player.setEqualizerGains(eq(0))
      if (scenario == 'restore-effects') {
        player.setSoundEffectMode('original')
        player.setSoundEffectMode('effects')
      }
      if (scenario == 'mode-live') {
        for (const [time, mode] of [[1.013, 'original'], [1.023, 'effects'], [1.033, 'original']]) {
          changesDuringPlayback.push(context.suspend(time).then(() => {
            player.setSoundEffectMode(mode)
            return context.resume()
          }))
        }
      }
      if (scenario == 'eq-live') {
        for (const [time, band] of [[1.013, 1000], [1.023, 500], [1.033, 0], [1.043, 1000]]) {
          changesDuringPlayback.push(context.suspend(time).then(() => {
            player.setEqualizerGains(player.freqs.map(freq => freq == band ? 6 : 0))
            return context.resume()
          }))
        }
      }
      if (['disabled', 'reset', 'during-playback', 'enabled', 'reenabled', 'original', 'mode-live'].includes(scenario)) {
        player.setConvolver(impulse, 1.8, 0.9)
        if (scenario == 'during-playback') {
          changesDuringPlayback.push(context.suspend(1).then(() => {
            player.setConvolver(null, 0, 0)
            return context.resume()
          }))
        } else if (!wet && scenario != 'original' && scenario != 'mode-live') {
          player.setConvolver(null, 0, 0)
          if (scenario == 'reset') player.setConvolver(null, 0, 0)
        } else if (scenario == 'reenabled') {
          player.setConvolver(null, 0, 0)
          player.setConvolver(impulse, 0.5, 0.2)
          player.setConvolver(impulse, 1.8, 0.9)
        }
      }
    }

    source.start()
    const rendered = await context.startRendering()
    await Promise.all(changesDuringPlayback)
    return rendered
  }

  const results = []
  for (const sampleRate of [44100, 48000]) {
    for (const amplitude of [0.01, 0.9]) {
      for (const scenario of ['flat', 'disabled', 'reset', 'during-playback', 'enabled', 'reenabled', 'eq',
        'original', 'restore-effects', 'boost', 'overlap', 'eq-reset', 'mode-live', 'eq-live',
        'policy-off', 'visualization-off', 'effects-off-live']) {
        const actual = await render(scenario, sampleRate, amplitude, false)
        const expected = await render(scenario, sampleRate, amplitude, true)
        let maxError = 0
        let peak = 0
        let switchStep = 0
        let switchTime = 0
        let switchSamples = []
        for (let channel = 0; channel < 2; channel++) {
          const output = actual.getChannelData(channel)
          const reference = expected.getChannelData(channel)
          // Measure after the compressor has settled, including after live disable.
          for (let i = sampleRate * 2; i < output.length; i++) {
            maxError = Math.max(maxError, Math.abs(output[i] - reference[i]))
          }
          for (let i = 0; i < output.length; i++) peak = Math.max(peak, Math.abs(output[i]))
          for (let i = Math.floor(sampleRate * 0.99); i < sampleRate * 1.1; i++) {
            const step = Math.abs(output[i] - output[i - 1])
            if (step > switchStep) {
              switchStep = step
              switchTime = i / sampleRate
              switchSamples = [...output.slice(i - 2, i + 3)]
            }
          }
        }
        results.push({ scenario, sampleRate, amplitude, maxError, peak, switchStep, switchTime, switchSamples })
      }
    }
  }
  return results
}

app.whenReady().then(async() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
  })
  win.webContents.setAudioMuted(true)
  await win.loadURL('about:blank')
  const pluginCode = fs.readFileSync(path.join(outputPath, 'player.js'), 'utf8')
  const results = await win.webContents.executeJavaScript(`(${renderCases.toString()})(${JSON.stringify(pluginCode)})`)
  fs.writeFileSync(path.join(outputPath, 'results.json'), JSON.stringify(results))
  app.exit(0)
}).catch(error => {
  console.error(error)
  app.exit(1)
})
