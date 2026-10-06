const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const output = process.argv[2]
app.setPath('userData', path.join(output, 'profile'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const run = async(playerCode, coordinatorCode) => {
  const evaluate = code => {
    const exports = {}
    // eslint-disable-next-line no-new-func
    new Function('exports', code)(exports)
    return exports
  }
  window.app_event = { on() {}, off() {} }
  const player = evaluate(playerCode)
  const { createPlaybackResolutionCoordinator } = evaluate(coordinatorCode)
  const sampleRate = 44100
  const frames = sampleRate * 12
  const wav = new ArrayBuffer(44 + frames * 2)
  const view = new DataView(wav)
  const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, frames * 2, true)
  for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i * 2 * Math.PI * 440 / sampleRate) * 3000), true)
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async(check, label) => {
    const deadline = performance.now() + 5000
    while (!check()) { if (performance.now() > deadline) throw new Error(`Media wait timed out: ${label}`); await sleep(20) }
  }
  const audios = []
  const audioErrors = []
  let srcAssignments = 0
  let mainCanplay = 0
  let playing = 0
  let paused = 0
  let updates = 0
  const coordinator = createPlaybackResolutionCoordinator({
    clock: { now: Date.now, setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) },
    createRequest: async({ musicInfo }) => ({ kind: 'direct', resource: { kind: 'direct', songIdentity: `local:${musicInfo.id}`, url } }),
    createPreloadAudio() {
      const audio = new window.Audio()
      audio.addEventListener('error', () => audioErrors.push(audio.error?.message))
      audio.muted = true
      audio.preload = 'auto'
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, 'src')
      Object.defineProperty(audio, 'src', {
        get() { return descriptor.get.call(audio) },
        set(value) { srcAssignments++; descriptor.set.call(audio, value) },
      })
      audios.push(audio)
      return audio
    },
    detachForegroundResource: player.clearResourceIf,
  })
  coordinator.setForegroundHandlers({ resource() {}, failure(error) { throw error } })
  player.createAudio()
  player.setVolume(0.4)
  player.setMute(false)
  player.setPlaybackRate(1.25)
  // Exercise an existing Web Audio graph across two element handoffs.
  player.setEqualizerGains(player.freqs.map(() => 0))
  const analyser = player.getAnalyser()
  player.onPlaying(() => { playing++ })
  player.onPause(() => { paused++ })
  player.onTimeupdate(() => { updates++ })
  player.onCanplay(() => { mainCanplay++ })
  const results = []
  for (let i = 0; i < 2; i++) {
    const info = { id: String(i), source: 'local' }
    await coordinator.startPreload(info)
    try {
      await until(() => audios[i].readyState >= 3 && audios[i].preload == 'none', `preload ${i}`)
    } catch (error) {
      throw new Error(`${error.message}; ready=${audios[i].readyState}; preload=${audios[i].preload}; src=${audios[i].src}; errors=${JSON.stringify(audioErrors)}`)
    }
    const bufferedBefore = audios[i].buffered.end(0)
    const resource = await coordinator.startForeground({ musicInfo: info, reason: 'initial' })
    const buffered = coordinator.takePreloadedAudio(resource)
    if (buffered != audios[i]) throw new Error('Buffered element was not transferred')
    const assignmentsBefore = srcAssignments
    player.setResource(resource.url, { resource, preloadedAudio: buffered, shouldPlay: true })
    await until(() => player.getCurrentTime() > 0.15, `play ${i}`)
    const samples = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(samples)
    const peak = Math.max(...samples.map(Math.abs))
    results.push({
      bufferedBefore,
      assignments: srcAssignments - assignmentsBefore,
      volume: buffered.volume,
      rate: buffered.playbackRate,
      muted: buffered.muted,
      duration: player.getDuration(),
      time: player.getCurrentTime(),
      peak,
    })
    player.setPause()
    await until(() => paused >= i + 1, `pause ${i}`)
    player.setCurrentTime(2)
    player.setPlay()
    await until(() => player.getCurrentTime() > 2.1, `resume ${i}`)
  }
  coordinator.dispose()
  player.setStop()
  URL.revokeObjectURL(url)
  return { results, mainCanplay, playing, paused, updates }
}

app.whenReady().then(async() => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true } })
  win.webContents.setAudioMuted(true)
  await win.loadURL('about:blank')
  const playerCode = fs.readFileSync(path.join(output, 'player.js'), 'utf8')
  const coordinatorCode = fs.readFileSync(path.join(output, 'coordinator.js'), 'utf8')
  const result = await win.webContents.executeJavaScript(`(${run.toString()})(${JSON.stringify(playerCode)}, ${JSON.stringify(coordinatorCode)})`)
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result))
  win.destroy()
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
