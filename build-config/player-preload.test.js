const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const ts = require('typescript')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const load = require('../scripts/test-utils/load-ts-module')
const { createFakeClock, createPreloadSchedulingHarness } = require('./test-utils/playback-fallback-harness')

const root = path.resolve(__dirname, '..')
const coordinatorModule = load(path.join(root, 'src/renderer/core/music/playback/coordinator.ts'))
const stateModule = () => load(path.join(root, 'src/renderer/core/player/preloadState.ts'), {
  '@renderer/core/music/playback/coordinator': coordinatorModule,
})
const song = id => ({ id, source: 'wy', name: id, singer: 'Singer', meta: {} })
const flush = async() => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }

class Audio {
  src = ''
  muted = true
  listeners = new Map()
  addEventListener(name, handler) { this.listeners.set(name, handler) }
  removeEventListener(name, handler) { if (this.listeners.get(name) == handler) this.listeners.delete(name) }
  emit(name) { return this.listeners.get(name)?.() }
  pause() {}
  load() {}
  removeAttribute(name) { if (name == 'src') this.src = '' }
}

const directCoordinator = () => {
  const audios = []
  const clock = createFakeClock(0)
  const coordinator = coordinatorModule.createPlaybackResolutionCoordinator({
    clock,
    createRequest: async({ musicInfo }) => ({
      kind: 'direct', resource: { kind: 'direct', songIdentity: `wy:${musicInfo.id}`, url: `https://test/${musicInfo.id}` },
    }),
    createPreloadAudio() { const audio = new Audio(); audios.push(audio); return audio },
    detachForegroundResource() {},
  })
  coordinator.setForegroundHandlers({ resource() {}, failure() {} })
  return { coordinator, audios, clock }
}

test('completed preload retains its media element and transfers ownership exactly once', async() => {
  const { coordinator, audios } = directCoordinator()
  await coordinator.startPreload(song('next'))
  audios[0].emit('canplay')
  assert.equal(audios[0].src, 'https://test/next')
  const resource = await coordinator.startForeground({ musicInfo: song('next'), reason: 'initial' })
  assert.equal(resource.kind, 'validated')
  assert.equal(coordinator.takePreloadedAudio(resource), audios[0])
  assert.equal(coordinator.takePreloadedAudio(resource), null)
  coordinator.dispose()
  assert.equal(audios[0].src, 'https://test/next', 'the coordinator must not unload audio now owned by the player')
})

test('replacing or cancelling a completed preload releases its buffer', async() => {
  const { coordinator, audios } = directCoordinator()
  await coordinator.startPreload(song('old'))
  audios[0].emit('canplay')
  await coordinator.startPreload(song('new'))
  assert.equal(audios[0].src, '')
  audios[1].emit('canplay')
  coordinator.cancelPreload('preloadReplaced')
  assert.equal(audios[1].src, '')
})

test('a direct media error or timeout reports the failed identity only once', async() => {
  const { coordinator, audios, clock } = directCoordinator()
  const failed = []
  coordinator.onPreloadFailure(identity => failed.push(identity))
  await coordinator.startPreload(song('bad'))
  const oldError = audios[0].listeners.get('error')
  oldError()
  oldError()
  assert.deepEqual(failed, ['wy:bad'])
  await coordinator.startPreload(song('slow'))
  clock.advance(10_000)
  await flush()
  assert.deepEqual(failed, ['wy:bad', 'wy:slow'])
  assert.equal(audios[1].src, '')
})

test('buffer handoff waits for the output device, including a newer selection arriving during that wait', async() => {
  const source = fs.readFileSync(path.join(root, 'src/renderer/plugins/player/index.ts'), 'utf8')
  const { outputText } = ts.transpileModule(source.replaceAll('import.meta.url', "'file:///unused.js'"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  const player = {}
  // eslint-disable-next-line no-new-func
  new Function('exports', outputText)(player)
  let ready
  const outputReady = new Promise(resolve => { ready = resolve })
  let plays = 0
  const buffered = new Audio()
  buffered.src = 'https://test/one'
  buffered.play = async() => { plays++ }
  buffered.readyState = 3
  const resource = player.createPlayerResourceController({
    audio: new Audio(), canonicalizeUrl: value => value, adoptAudio: async() => outputReady,
  })
  resource.setResource(buffered.src, {
    resource: { kind: 'validated', songIdentity: 'wy:one', url: buffered.src }, preloadedAudio: buffered,
  })
  assert.equal(buffered.autoplay, false)
  assert.equal(plays, 0)
  resource.setResource('https://test/two', { resource: { kind: 'direct', songIdentity: 'wy:two', url: 'https://test/two' } })
  assert.equal(buffered.autoplay, false)
  assert.equal(plays, 0)
  ready()
  await flush()
  assert.equal(buffered.autoplay, true)
  assert.equal(plays, 1)
  assert.equal(resource.getResourceContext().songIdentity, 'wy:two')
})

test('preloading starts at five seconds even without known track duration', async() => {
  const harness = createPreloadSchedulingHarness()
  harness.tick(4.9, 0)
  assert.equal(harness.selectorCallCount, 0)
  harness.tick(5, 0)
  await harness.waitForSelection(1)
  harness.resolveSelection(1, song('next'))
  await harness.flush()
  assert.deepEqual(harness.coordinatorStartIdentities, ['wy:next'])
  harness.dispose()
})

const createQueueHarness = () => {
  const state = stateModule()
  const requests = []
  let stops = 0
  const list = ['current', 'bad1', 'bad2', 'good'].map(song)
  const settings = { 'player.togglePlayMethod': 'listLoop', 'player.preloadNext': true, 'player.autoSkipOnError': true }
  const player = {
    playMusicInfo: { musicInfo: list[0], listId: 'list', isTempPlay: false },
    playInfo: { playerListId: 'list', playerPlayIndex: 0 },
    tempPlayList: [],
    playedList: [],
    musicInfo: {},
    currentPlaybackQuality: { value: null },
    isPlay: { value: true },
    playbackNotice: { value: '' },
  }
  const actions = load(path.join(root, 'src/renderer/core/player/action.ts'), {
    '@renderer/plugins/player': { playerResourceController: { setStop() { stops++ }, setResource() {} } },
    '@renderer/store/player/state': player,
    '@renderer/store/player/action': {
      getList: () => list,
      setPlayMusicInfo(listId, info, isTempPlay) { Object.assign(player.playMusicInfo, { listId, musicInfo: info, isTempPlay }) },
      setPlayListId(listId) { player.playInfo.playerListId = listId },
      setMusicInfo(info) { Object.assign(player.musicInfo, info) },
      removeTempPlayList(index) { player.tempPlayList.splice(index, 1) },
      clearPlayedList() { player.playedList.length = 0 },
      clearTempPlayeList() { player.tempPlayList.length = 0 },
      setAllStatus() {},
    },
    '@renderer/store/setting': { appSetting: settings },
    '@renderer/store/party': { party: {} },
    '../music/index': { getPicPath: async() => '', getLyricInfo: async() => ({ rawlrcInfo: {} }) },
    './preloadState': state,
    './utils': { filterList: async() => ({ filteredList: list.slice(), playerIndex: 0 }) },
    '@renderer/utils/index': { getRandom: () => 0 },
    '@renderer/store/list/action': {},
    '@renderer/store/list/state': {},
    '@renderer/core/dislikeList': {},
    '@renderer/core/music/playback': {
      ...coordinatorModule,
      playbackResolutionCoordinator: {
        setForegroundHandlers() {},
        cancelForeground() {},
        dispose() {},
        startForeground: async({ musicInfo }) => {
          requests.push(musicInfo.id)
          return { kind: 'direct', songIdentity: `wy:${musicInfo.id}`, url: `https://test/${musicInfo.id}` }
        },
      },
    },
    '@common/utils/playbackSourceError': {},
  })
  return { actions, player, list, state, settings, requests, get stops() { return stops } }
}

test('preview skips failed tracks in order without advancing the current song or mutating the playlist', async() => {
  const { actions, player, list } = createQueueHarness()
  const before = JSON.stringify({ player, list })
  const next = await actions.getNextPlayMusicInfo(new Set(['wy:bad1', 'wy:bad2']))
  assert.equal(next.musicInfo.id, 'good')
  assert.equal(JSON.stringify({ player, list }), before)
})

test('temporary queue has priority but failed entries are not consumed during preview', async() => {
  const { actions, player } = createQueueHarness()
  player.tempPlayList.push(...['queued-bad', 'queued-good'].map(id => ({ musicInfo: song(id), listId: null, isTempPlay: true })))
  const next = await actions.getNextPlayMusicInfo(new Set(['wy:queued-bad']))
  assert.equal(next.musicInfo.id, 'queued-good')
  assert.equal(player.tempPlayList.length, 2)
})

test('random selection stays fixed between preview and next, and excludes failed candidates', async() => {
  const { actions, settings } = createQueueHarness()
  settings['player.togglePlayMethod'] = 'random'
  const excluded = new Set(['wy:current', 'wy:bad1', 'wy:bad2'])
  const first = await actions.getNextPlayMusicInfo(excluded)
  const second = await actions.getNextPlayMusicInfo(excluded)
  assert.equal(first.musicInfo.id, 'good')
  assert.equal(second, first)
})

test('removing the reserved random song invalidates it before playback', async() => {
  const { actions, settings, list } = createQueueHarness()
  settings['player.togglePlayMethod'] = 'random'
  const excluded = new Set(['wy:current', 'wy:bad1'])
  assert.equal((await actions.getNextPlayMusicInfo(excluded)).musicInfo.id, 'bad2')
  list.splice(2, 1)
  assert.equal((await actions.getNextPlayMusicInfo(excluded)).musicInfo.id, 'good')
})

test('single repeat and explicit next keep their existing meanings', async() => {
  const { actions, settings } = createQueueHarness()
  settings['player.togglePlayMethod'] = 'singleLoop'
  assert.equal((await actions.getNextPlayMusicInfo()).musicInfo.id, 'current')
  assert.equal((await actions.getNextPlayMusicInfo(new Set(), false)).musicInfo.id, 'bad1')
})

test('exhausted lists terminate and five distinct failures stop a run until reset', async() => {
  const { actions, state, list } = createQueueHarness()
  assert.equal(await actions.getNextPlayMusicInfo(new Set(list.map(info => `wy:${info.id}`))), null)
  for (let i = 0; i < 5; i++) state.preloadFailureState.add(song(`bad${i}`))
  assert.equal(state.preloadFailureState.stopped, true)
  assert.equal(state.preloadFailureState.add(song('bad0')), false)
  state.preloadFailureState.reset()
  assert.equal(state.preloadFailureState.stopped, false)
  assert.equal(state.preloadFailureState.failed.size, 0)
})

const withPlaybackWindow = async work => {
  const previous = global.window
  global.window = {
    lx: { isPlayedStop: false },
    app_event: new Proxy({}, { get: () => () => {} }),
    i18n: { t: key => key },
  }
  try { await work(); await flush() } finally { global.window = previous }
}

test('automatic next consumes the successful preview while skipping failed temporary entries', async() => withPlaybackWindow(async() => {
  const h = createQueueHarness()
  h.actions.initializePlaybackActionController()
  h.player.tempPlayList.push({ musicInfo: song('queued-bad'), listId: null, isTempPlay: true })
  for (const id of ['queued-bad', 'bad1', 'bad2']) h.state.preloadFailureState.add(song(id))
  await h.actions.playNext({ automatic: true, reason: 'natural_end', startReason: 'auto' })
  await flush()
  assert.deepEqual(h.requests, ['good'])
  assert.equal(h.player.playMusicInfo.musicInfo.id, 'good')
  assert.equal(h.player.tempPlayList.length, 0)
  assert.deepEqual(h.list.map(info => info.id), ['current', 'bad1', 'bad2', 'good'])
}))

test('five failures stop actual automatic continuation; manually selecting a failed song starts a fresh attempt', async() => withPlaybackWindow(async() => {
  const h = createQueueHarness()
  h.actions.initializePlaybackActionController()
  for (let i = 0; i < 5; i++) h.state.preloadFailureState.add(song(`bad${i}`))
  await h.actions.playNext({ automatic: true, reason: 'natural_end', startReason: 'auto' })
  await flush()
  assert.deepEqual(h.requests, [])
  assert.equal(h.stops, 1)
  assert.equal(h.player.playMusicInfo.musicInfo.id, 'current')
  assert.match(h.player.playbackNotice.value, /player__preload_stopped/)
  h.actions.playListById('list', 'bad1')
  await flush()
  assert.deepEqual(h.requests, ['bad1'])
  assert.equal(h.state.preloadFailureState.stopped, false)
  assert.equal(h.player.playbackNotice.value, '')
}))

const createLivePreloadHarness = () => {
  const previousWindow = global.window
  const previousPerformance = global.performance
  const emitter = new EventEmitter()
  const state = stateModule()
  const player = { musicInfo: { id: 'current' }, playMusicInfo: { musicInfo: song('current') }, playbackNotice: { value: '' } }
  const settings = {
    'player.preloadNext': true,
    'player.autoSkipOnError': true,
    'common.apiFallbackSources': [],
    'player.togglePlayMethod': 'listLoop',
  }
  const list = Array.from({ length: 7 }, (_, i) => song(`next${i}`))
  const starts = []
  const cancels = []
  let elapsed = 0
  let position = 0
  let tick
  let settingsChanged
  let queueChanged
  let selectionCalls = 0
  let dispose
  let failed
  global.window = { app_event: emitter, i18n: { t: (key, vars) => `${key}:${vars?.name ?? ''}` } }
  global.performance = { now: () => elapsed }
  const hook = load(path.join(root, 'src/renderer/core/useApp/usePlayer/usePreloadNextMusic.ts'), {
    '@common/utils': { log: { debug() {} } },
    '@common/utils/playbackSourceError': load(path.join(root, 'src/common/utils/playbackSourceError.ts')),
    '@common/utils/vueTools': { onBeforeUnmount: fn => { dispose = fn }, watch: (_, fn) => { if (!settingsChanged) settingsChanged = fn; else queueChanged = fn; return () => {} } },
    '@renderer/plugins/player': { getCurrentTime: () => position, onTimeupdate: fn => { tick = fn; return () => {} } },
    '@renderer/store/player/playProgress': { playProgress: { nowPlayTime: 0, maxPlayTime: 200 } },
    '@renderer/store/player/state': player,
    '@renderer/store/party': { party: {} },
    '@renderer/core/player/preloadState': state,
    '@renderer/store/setting': { appSetting: settings },
    '@renderer/core/player': {
      resetRandomNextMusicInfo() {},
      getNextPlayMusicInfo: async excluded => {
        selectionCalls++
        const info = list.find(item => !excluded.has(`wy:${item.id}`))
        return info ? { musicInfo: info, listId: 'list', isTempPlay: false } : null
      },
    },
    '@renderer/core/music/playback': {
      getPlaybackSongIdentity: coordinatorModule.getPlaybackSongIdentity,
      playbackResolutionCoordinator: {
        startPreload: async info => { starts.push(info.id) },
        cancelPreload: reason => cancels.push(reason),
        onPreloadFailure: handler => { failed = handler; return () => {} },
      },
    },
  }).default
  hook()
  return {
    starts,
    cancels,
    emitter,
    settings,
    player,
    state,
    get selectionCalls() { return selectionCalls },
    queueChanged() { queueChanged() },
    tick(ms, time) { elapsed = ms; position = time; tick() },
    fail(id) { failed(`wy:${id}`, new Error('Unavailable')) },
    settingsChanged() { settingsChanged() },
    dispose() { dispose(); global.window = previousWindow; global.performance = previousPerformance },
  }
}

test('five seconds means stable wall time; pauses restart the delay and slow playback still preloads', async() => {
  const h = createLivePreloadHarness()
  try {
    h.emitter.emit('playerPlaying')
    h.tick(4000, 2)
    assert.equal(h.starts.length, 0)
    h.emitter.emit('playerPause')
    h.tick(20_000, 2)
    assert.equal(h.starts.length, 0)
    h.emitter.emit('playerPlaying')
    h.tick(24_900, 4.45)
    assert.equal(h.starts.length, 0)
    h.tick(25_000, 4.5)
    await flush()
    assert.deepEqual(h.starts, ['next0'])
  } finally { h.dispose() }
})

test('background failures advance the lookahead, show bar notices, and stop after five without changing the playing song', async() => {
  const h = createLivePreloadHarness()
  try {
    h.emitter.emit('playerPlaying')
    h.tick(5000, 5)
    await flush()
    for (let i = 0; i < 5; i++) {
      h.fail(`next${i}`)
      await flush()
    }
    assert.deepEqual(h.starts, ['next0', 'next1', 'next2', 'next3', 'next4'])
    assert.equal(h.state.preloadFailureState.stopped, true)
    assert.match(h.player.playbackNotice.value, /player__preload_stopped/)
    assert.equal(h.player.playMusicInfo.musicInfo.id, 'current')
    h.tick(9000, 9)
    await flush()
    assert.equal(h.starts.length, 5)
  } finally { h.dispose() }
})

test('disabled automatic skipping reports a preload failure without bypassing the track; disabling preload cancels it', async() => {
  const h = createLivePreloadHarness()
  try {
    h.settings['player.autoSkipOnError'] = false
    h.emitter.emit('playerPlaying')
    h.tick(5000, 5)
    await flush()
    h.fail('next0')
    await flush()
    assert.match(h.player.playbackNotice.value, /player__preload_failed:next0/)
    assert.equal(h.state.preloadFailureState.failed.size, 0)
    h.settings['player.preloadNext'] = false
    h.settingsChanged()
    h.tick(10_000, 10)
    await flush()
    assert.deepEqual(h.starts, ['next0'])
    assert.ok(h.cancels.length)
    assert.equal(h.player.playbackNotice.value, '')
  } finally { h.dispose() }
})

test('steady playback reuses the queue preview, while queue edits recheck it without discarding the same buffer', async() => {
  const h = createLivePreloadHarness()
  try {
    h.emitter.emit('playerPlaying')
    for (let time = 5; time < 60; time += 4) {
      h.tick(time * 1000, time)
      await flush()
    }
    assert.equal(h.selectionCalls, 1)
    h.queueChanged()
    h.tick(60_000, 60)
    await flush()
    assert.equal(h.selectionCalls, 2)
    assert.deepEqual(h.starts, ['next0'])
  } finally { h.dispose() }
})
