const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describe, it } = require('node:test')
const typescript = require('typescript')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  module._compile(output, filename)
}

const root = path.resolve(__dirname, '../..')
const hookPath = path.join(root, 'src/renderer/core/useApp/usePlayer/usePlaybackRecorder.ts')
const recentActionPath = path.join(root, 'src/renderer/store/recentPlay/action.ts')
const listeningActionPath = path.join(root, 'src/renderer/store/listeningTime/action.ts')
const dataInitPath = path.join(root, 'src/renderer/core/useApp/useDataInit.ts')
const dataHandlerPath = path.join(root, 'src/main/modules/winMain/rendererEvent/data.ts')
const mainShutdownPath = path.join(root, 'src/main/modules/winMain/rendererEvent/rendererShutdown.ts')
const rendererShutdownPath = path.join(root, 'src/renderer/utils/shutdown.ts')
const recorderPath = path.join(root, 'src/renderer/core/playbackRecorder/index.ts')
const recentViewPath = path.join(root, 'src/renderer/views/RecentPlay/index.vue')

const UUID = '123e4567-e89b-42d3-a456-426614174000'
const UUID_2 = '223e4567-e89b-42d3-a456-426614174000'

const loadFeature = (filename, mocks = {}) => {
  assert.equal(fs.existsSync(filename), true, `missing Task 9 production module: ${path.relative(root, filename)}`)
  return loadTsModule(filename, mocks)
}

const track = (playablePayload = { id: 'track', source: 'local', name: 'Name', singer: 'Singer', meta: { filePath: 'D:/music.flac' } }) => ({
  source: 'local',
  sourceTrackId: 'track',
  name: 'Name',
  singer: 'Singer',
  durationMs: 120_000,
  playablePayload,
})

const selection = (overrides = {}) => ({
  track: track(),
  context: { type: 'playlist', id: 'list' },
  resume: { listId: 'list', indexHint: 0 },
  startReason: 'select',
  startPositionMs: 0,
  ...overrides,
})

const activityAck = (group, checkpointSeq) => ({
  playbackGroupUuid: group,
  sessionUuid: UUID_2,
  segmentNo: 0,
  checkpointSeq,
  cumulativePlayedMs: 0,
  cumulativeActiveMs: 0,
})

const settle = async() => {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

const createTransport = calls => async command => {
  calls.push(command)
  if (command.kind == 'start') {
    const group = command.request.playbackGroupUuid
    if (command.request.consent.privateMode) return { mode: 'private', playbackGroupUuid: group, checkpointSeq: 0 }
    if (!command.request.consent.recentAllowed && !command.request.consent.statsAllowed) {
      return { mode: 'resume-only', ack: { playbackGroupUuid: group, checkpointSeq: 0, positionMs: command.request.startPositionMs } }
    }
    return { mode: 'activity', ack: activityAck(group, 1) }
  }
  if (command.kind == 'resume') {
    return {
      playbackGroupUuid: command.request.playbackGroupUuid,
      checkpointSeq: command.request.checkpointSeq,
      positionMs: command.request.positionMs,
    }
  }
  const checkpoint = command.kind == 'commit' ? command.request.checkpoint : { playbackGroupUuid: command.request.playbackGroupUuid, checkpointSeq: 1 }
  return activityAck(checkpoint.playbackGroupUuid, checkpoint.checkpointSeq)
}

const createControlledPlaybackTransport = () => {
  const attempts = []
  let activeAttempts = 0
  let maxActiveAttempts = 0
  return {
    attempts,
    get activeAttempts() { return activeAttempts },
    get maxActiveAttempts() { return maxActiveAttempts },
    transport: command => new Promise((resolve, reject) => {
      activeAttempts++
      maxActiveAttempts = Math.max(maxActiveAttempts, activeAttempts)
      let settled = false
      const finish = callback => value => {
        assert.equal(settled, false)
        settled = true
        activeAttempts--
        callback(value)
      }
      attempts.push({
        command: structuredClone(command),
        resolve: finish(resolve),
        reject: finish(reject),
      })
    }),
  }
}

const loadRecorder = transport => loadTsModule(recorderPath, {
  '@renderer/utils/playback': { sendPlaybackCommand: transport },
  '../../utils/playback': { sendPlaybackCommand: transport },
}).createPlaybackRecorder({ transport })

const loadController = ({
  recorder,
  policy,
  clock,
  refreshRecent = async() => {},
  refreshListening = async() => {},
  createUuid = () => UUID,
}) => {
  const module = loadFeature(hookPath, {
    '@renderer/core/playbackRecorder': { createPlaybackRecorder: () => recorder },
    '@renderer/store/recentPlay/action': { initRecentPlayList: refreshRecent },
    '@renderer/store/listeningTime/action': { initListeningTimeStats: refreshListening },
    '@renderer/utils/ipc': { registerShutdownFlusher: () => () => {} },
    '@renderer/plugins/player': {},
    '@renderer/store/player/state': {},
    '@renderer/store/player/playbackRate': {},
    '@common/utils/vueTools': { onBeforeUnmount: () => {} },
  })
  return module.createPlaybackRecorderController({
    recorder,
    getPolicy: policy,
    now: clock.now,
    monotonicNow: clock.monotonicNow,
    createUuid,
    getPositionMs: clock.position,
    getDurationMs: () => 120_000,
    refreshRecent,
    refreshListening,
    timeZone: 'UTC',
    timers: clock.timers,
  })
}

const mountRecorderHook = ({ appEvent, recorder, currentTime = () => 47 }) => {
  let cleanup = () => {}
  const module = loadFeature(hookPath, {
    '@renderer/core/playbackRecorder': { createPlaybackRecorder: () => recorder },
    '@renderer/store/recentPlay/action': { initRecentPlayList: async() => {} },
    '@renderer/store/listeningTime/action': { initListeningTimeStats: async() => {} },
    '@renderer/utils/ipc': { registerShutdownFlusher: () => () => {} },
    '@renderer/plugins/player': {
      getCurrentTime: currentTime,
      getDuration: () => 120,
      getPlaybackRate: () => 1,
      onTimeupdate: () => () => {},
    },
    '@renderer/store/player/state': {
      playInfo: { playIndex: 7 },
      playMusicInfo: {
        musicInfo: { id: 'old', source: 'local', name: 'Old', singer: 'Singer', meta: { filePath: 'D:/old.flac' } },
        listId: 'old-list',
        isTempPlay: false,
      },
    },
    '@renderer/store/player/playbackRate': {},
    '@common/utils/vueTools': {
      toRaw: value => value,
      onBeforeUnmount: callback => { cleanup = callback },
    },
  })
  const previousWindow = global.window
  global.window = { app_event: appEvent }
  module.default()
  return () => {
    cleanup()
    global.window = previousWindow
  }
}

describe('playback recorder renderer cutover', () => {
  it('flush overrides a production-length retry backoff with one immediate ordered attempt', async() => {
    let attempts = 0
    const recorder = loadTsModule(recorderPath, {
      '../../utils/playback': { sendPlaybackCommand: async() => { throw new Error('unexpected default transport') } },
    }).createPlaybackRecorder({
      retry: { initialMs: 5_000, maxMs: 5_000 },
      transport: async command => {
        attempts++
        if (attempts == 1) throw new Error('transient send failure')
        assert.equal(command.kind, 'start')
        return { mode: 'activity', ack: activityAck(UUID, 1) }
      },
    })
    recorder.dispatch({
      type: 'start-requested',
      request: {
        version: 1,
        playbackGroupUuid: UUID,
        ...selection(),
        occurredAtMs: 100,
        consent: { recentAllowed: true, statsAllowed: true, privateMode: false },
      },
    })
    recorder.dispatch({ type: 'native-playing', playbackRate: 1, monotonicMs: 0, positionMs: 0, occurredAtMs: 100 })
    await settle()
    assert.equal(attempts, 1)

    const results = await Promise.all([
      recorder.flush({ timeoutMs: 500 }),
      recorder.flush({ timeoutMs: 500 }),
    ])

    assert.deepEqual(results, [true, true])
    assert.equal(attempts, 2)
    assert.equal(recorder.getState().outbox.length, 0)
  })

  it('concurrent flush callers share an existing in-flight send', async() => {
    let attempts = 0
    let resolveTransport
    const response = new Promise(resolve => { resolveTransport = resolve })
    const recorder = loadTsModule(recorderPath, {
      '../../utils/playback': { sendPlaybackCommand: async() => { throw new Error('unexpected default transport') } },
    }).createPlaybackRecorder({
      transport: async() => {
        attempts++
        return response
      },
    })
    recorder.dispatch({
      type: 'start-requested',
      request: {
        version: 1,
        playbackGroupUuid: UUID,
        ...selection(),
        occurredAtMs: 100,
        consent: { recentAllowed: true, statsAllowed: true, privateMode: false },
      },
    })
    recorder.dispatch({ type: 'native-playing', playbackRate: 1, monotonicMs: 0, positionMs: 0, occurredAtMs: 100 })
    await settle()

    const first = recorder.flush({ timeoutMs: 500 })
    const second = recorder.flush({ timeoutMs: 500 })
    assert.equal(attempts, 1)
    resolveTransport({ mode: 'activity', ack: activityAck(UUID, 1) })

    assert.deepEqual(await Promise.all([first, second]), [true, true])
    assert.equal(attempts, 1)
  })

  it('concurrent flushes retry once immediately when their in-flight send fails', async() => {
    const controlled = createControlledPlaybackTransport()
    const recorder = loadTsModule(recorderPath, {
      '../../utils/playback': { sendPlaybackCommand: async() => { throw new Error('unexpected default transport') } },
    }).createPlaybackRecorder({
      retry: { initialMs: 5_000, maxMs: 5_000 },
      transport: controlled.transport,
    })
    recorder.dispatch({
      type: 'start-requested',
      request: {
        version: 1,
        playbackGroupUuid: UUID,
        ...selection(),
        occurredAtMs: 100,
        consent: { recentAllowed: true, statsAllowed: true, privateMode: false },
      },
    })
    recorder.dispatch({ type: 'native-playing', playbackRate: 1, monotonicMs: 0, positionMs: 0, occurredAtMs: 100 })
    await settle()
    assert.equal(controlled.attempts.length, 1)

    const startedAt = Date.now()
    const firstFlush = recorder.flush({ timeoutMs: 250 })
    const secondFlush = recorder.flush({ timeoutMs: 500 })
    await settle()
    assert.equal(controlled.attempts.length, 1)
    controlled.attempts[0].reject(new Error('transient send failure'))
    await settle()

    assert.equal(controlled.attempts.length, 2)
    assert.equal(controlled.maxActiveAttempts, 1)
    assert.deepEqual(controlled.attempts[1].command, controlled.attempts[0].command)
    await settle()
    assert.equal(controlled.attempts.length, 2)
    controlled.attempts[1].resolve({ mode: 'activity', ack: activityAck(UUID, 1) })

    assert.deepEqual(await Promise.all([firstFlush, secondFlush]), [true, true])
    assert.ok(Date.now() - startedAt < 250)
    assert.equal(controlled.activeAttempts, 0)
    assert.equal(recorder.getState().outbox.length, 0)
  })

  it('an expired flush leaves a later send failure on normal backoff', async() => {
    const controlled = createControlledPlaybackTransport()
    const timers = []
    const clock = {
      now: () => 0,
      setTimeout(callback, delayMs) {
        const timer = { callback, delayMs }
        timers.push(timer)
        return timer
      },
      clearTimeout(timer) {
        const index = timers.indexOf(timer)
        if (index >= 0) timers.splice(index, 1)
      },
    }
    const recorder = loadTsModule(recorderPath, {
      '../../utils/playback': { sendPlaybackCommand: async() => { throw new Error('unexpected default transport') } },
    }).createPlaybackRecorder({
      clock,
      retry: { initialMs: 5_000, maxMs: 5_000 },
      transport: controlled.transport,
    })
    recorder.dispatch({
      type: 'start-requested',
      request: {
        version: 1,
        playbackGroupUuid: UUID,
        ...selection(),
        occurredAtMs: 100,
        consent: { recentAllowed: true, statsAllowed: true, privateMode: false },
      },
    })
    recorder.dispatch({ type: 'native-playing', playbackRate: 1, monotonicMs: 0, positionMs: 0, occurredAtMs: 100 })
    await settle()

    const flushing = recorder.flush({ timeoutMs: 25 })
    const timeout = timers.find(timer => timer.delayMs == 25)
    assert.ok(timeout)
    timers.splice(timers.indexOf(timeout), 1)
    timeout.callback()
    assert.equal(await flushing, false)

    controlled.attempts[0].reject(new Error('failure after flush expired'))
    await settle()
    assert.equal(controlled.attempts.length, 1)
    assert.deepEqual(timers.map(timer => timer.delayMs), [5_000])
  })

  it('a failed urgent retry returns to normal backoff without an immediate loop', async() => {
    const controlled = createControlledPlaybackTransport()
    const timers = []
    const clock = {
      now: () => 0,
      setTimeout(callback, delayMs) {
        const timer = { callback, delayMs }
        timers.push(timer)
        return timer
      },
      clearTimeout(timer) {
        const index = timers.indexOf(timer)
        if (index >= 0) timers.splice(index, 1)
      },
    }
    const recorder = loadTsModule(recorderPath, {
      '../../utils/playback': { sendPlaybackCommand: async() => { throw new Error('unexpected default transport') } },
    }).createPlaybackRecorder({
      clock,
      retry: { initialMs: 5_000, maxMs: 5_000 },
      transport: controlled.transport,
    })
    recorder.dispatch({
      type: 'start-requested',
      request: {
        version: 1,
        playbackGroupUuid: UUID,
        ...selection(),
        occurredAtMs: 100,
        consent: { recentAllowed: true, statsAllowed: true, privateMode: false },
      },
    })
    recorder.dispatch({ type: 'native-playing', playbackRate: 1, monotonicMs: 0, positionMs: 0, occurredAtMs: 100 })
    await settle()

    const flushing = recorder.flush({ timeoutMs: 250 })
    controlled.attempts[0].reject(new Error('first failure'))
    await settle()
    assert.equal(controlled.attempts.length, 2)
    controlled.attempts[1].reject(new Error('urgent retry failure'))
    await settle()

    assert.equal(controlled.attempts.length, 2)
    assert.equal(controlled.maxActiveAttempts, 1)
    assert.ok(timers.some(timer => timer.delayMs == 5_000))
    const timeout = timers.find(timer => timer.delayMs == 250)
    assert.ok(timeout)
    timers.splice(timers.indexOf(timeout), 1)
    timeout.callback()
    assert.equal(await flushing, false)
  })

  it('creates recent/session state only on first native playing and keeps duplicate playing idempotent', async() => {
    const calls = []
    let recentCount = 0
    const recorder = loadRecorder(async command => {
      const result = await createTransport(calls)(command)
      if (command.kind == 'start' && command.request.consent.recentAllowed) recentCount++
      return result
    })
    const clock = {
      now: () => 100,
      monotonicNow: () => 100,
      position: () => 0,
      timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 2, clearTimeout: () => {} },
    }
    const controller = loadController({
      recorder,
      policy: () => ({ recentAllowed: true, statsAllowed: true, privateMode: false }),
      clock,
    })

    controller.select(selection())
    await settle()
    assert.equal(recentCount, 0)
    controller.nativePlaying(1)
    await recorder.flush()
    assert.equal(recentCount, 1)
    controller.nativePlaying(1)
    await recorder.flush()
    assert.equal(recentCount, 1)
    assert.equal(calls.filter(call => call.kind == 'start').length, 1)
  })

  it('uses the emitted selection snapshot instead of stale audio or mutable player globals', async() => {
    const { AppEvent } = require('../../src/renderer/event/appEvent.ts')
    const appEvent = new AppEvent()
    const calls = []
    const recorder = loadRecorder(createTransport(calls))
    const unmount = mountRecorderHook({ appEvent, recorder })

    try {
      appEvent.musicToggled(selection({
        track: track({ id: 'new', source: 'local', name: 'New', singer: 'Singer', meta: { filePath: 'D:/new.flac' } }),
        resume: { listId: 'new-list', indexHint: 1 },
        startPositionMs: 0,
      }))
      appEvent.playerPlaying()
      await recorder.flush()

      assert.equal(calls[0].kind, 'start')
      assert.equal(calls[0].request.track.sourceTrackId, 'track')
      assert.equal(calls[0].request.resume.listId, 'new-list')
      assert.equal(calls[0].request.startPositionMs, 0)
    } finally {
      unmount()
    }
  })

  it('records requested pause/resume causes and uses device for unexpected native transitions', async() => {
    const { AppEvent } = require('../../src/renderer/event/appEvent.ts')
    const appEvent = new AppEvent()
    const calls = []
    const recorder = loadRecorder(createTransport(calls))
    const unmount = mountRecorderHook({ appEvent, recorder, currentTime: () => 0 })

    try {
      appEvent.musicToggled(selection())
      appEvent.playerPlaying()
      await recorder.flush()
      appEvent.playbackPauseRequested('remote')
      appEvent.playerPause()
      appEvent.playbackPauseRequested('user')
      appEvent.playbackResumeRequested('recovery')
      appEvent.playerPlaying()
      appEvent.playerPause()
      appEvent.playerPlaying()
      await recorder.flush()

      assert.deepEqual(
        calls.filter(call => call.kind == 'commit').map(call => call.request.fact),
        [
          { version: 1, type: 'pause', reason: 'remote' },
          { version: 1, type: 'resume', reason: 'recovery' },
          { version: 1, type: 'pause', reason: 'device' },
          { version: 1, type: 'resume', reason: 'device' },
        ],
      )
    } finally {
      unmount()
    }
  })

  it('records a final preplay load failure without creating a recent projection', async() => {
    const calls = []
    const recorder = loadRecorder(createTransport(calls))
    const clock = {
      now: () => 200,
      monotonicNow: () => 200,
      position: () => 0,
      timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 2, clearTimeout: () => {} },
    }
    const controller = loadController({
      recorder,
      policy: () => ({ recentAllowed: true, statsAllowed: true, privateMode: false }),
      clock,
    })

    controller.select(selection())
    controller.error({ stage: 'load', code: 4, recoverable: false, attempt: 2 })
    await recorder.flush()

    assert.deepEqual(calls.map(call => call.kind), ['preplay_failure'])
    assert.equal(calls[0].request.error.stage, 'load')
    assert.equal(calls[0].request.error.attempt, 2)
  })

  it('latches policy and isolates transport and projections by consent mode', async() => {
    const policies = [
      { recentAllowed: true, statsAllowed: true, privateMode: false },
      { recentAllowed: true, statsAllowed: false, privateMode: false },
      { recentAllowed: false, statsAllowed: true, privateMode: false },
      { recentAllowed: false, statsAllowed: false, privateMode: false },
      { recentAllowed: true, statsAllowed: true, privateMode: true },
    ]
    const expectedKinds = [
      ['start', 'commit'],
      ['start', 'commit'],
      ['start', 'commit'],
      ['resume', 'resume'],
      [],
    ]

    for (let index = 0; index < policies.length; index++) {
      const calls = []
      let currentPolicy = policies[index]
      let policyReads = 0
      let recentRefreshes = 0
      let listeningRefreshes = 0
      const recorder = loadRecorder(createTransport(calls))
      const clock = {
        now: () => 1_000,
        monotonicNow: () => 1_000,
        position: () => 0,
        timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 2, clearTimeout: () => {} },
      }
      const controller = loadController({
        recorder,
        policy: () => { policyReads++; return currentPolicy },
        clock,
        refreshRecent: async() => { recentRefreshes++ },
        refreshListening: async() => { listeningRefreshes++ },
      })

      controller.select(selection())
      assert.equal(policyReads, 0)
      controller.nativePlaying(1)
      currentPolicy = { recentAllowed: false, statsAllowed: false, privateMode: true }
      controller.sample()
      controller.pause('user')
      await recorder.flush()
      await settle()

      assert.equal(policyReads, 1)
      assert.deepEqual(calls.map(call => call.kind), expectedKinds[index])
      assert.equal(recentRefreshes > 0, policies[index].recentAllowed && !policies[index].privateMode)
      assert.equal(listeningRefreshes > 0, policies[index].statsAllowed && !policies[index].privateMode)
    }
  })

  it('allocates a fresh playback group when manual play retries a terminal preplay failure', async() => {
    const calls = []
    const recorder = loadRecorder(createTransport(calls))
    const uuids = [UUID, UUID_2]
    const clock = {
      now: () => 2_000,
      monotonicNow: () => 2_000,
      position: () => 0,
      timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 2, clearTimeout: () => {} },
    }
    const controller = loadController({
      recorder,
      policy: () => ({ recentAllowed: true, statsAllowed: true, privateMode: false }),
      clock,
      createUuid: () => uuids.shift(),
    })

    controller.select(selection())
    controller.error({ stage: 'load', code: 4, recoverable: false, attempt: 2 })
    await recorder.flush()
    controller.newAttempt()
    controller.nativePlaying(1)
    await recorder.flush()

    assert.deepEqual(calls.map(call => call.kind), ['preplay_failure', 'start'])
    assert.deepEqual(calls.map(call => call.request.playbackGroupUuid), [UUID, UUID_2])
  })

  it('uses a 15 second checkpoint and flushes every semantic boundary', async() => {
    const actions = []
    const flushes = []
    const intervals = []
    let phase = 'playing'
    const recorder = {
      dispatch(action) {
        actions.push(action)
        if (action.type == 'start-requested') phase = 'pending'
        if (action.type == 'native-playing') phase = 'playing'
        if (action.type == 'pause') phase = 'paused'
        if (action.type == 'resume') phase = 'playing'
        return { phase }
      },
      getState() { return { phase } },
      async flush(options) { flushes.push(options ?? null); return true },
    }
    let positionMs = 1_000
    const clock = {
      now: () => 10_000,
      monotonicNow: () => 10_000,
      position: () => positionMs,
      timers: {
        setInterval(callback, delayMs) { intervals.push({ callback, delayMs }); return intervals.length },
        clearInterval: () => {},
        setTimeout: () => 1,
        clearTimeout: () => {},
      },
    }
    const controller = loadController({
      recorder,
      policy: () => ({ recentAllowed: true, statsAllowed: true, privateMode: false }),
      clock,
    })

    controller.select(selection())
    controller.nativePlaying(1)
    controller.startTimers()
    assert.equal(intervals[0].delayMs, 15_000)
    intervals[0].callback()
    controller.pause('user')
    controller.resume('user', 1)
    controller.seek({ origin: 'bar', fromMs: 1_000, toMs: 5_000 })
    positionMs = 5_000
    controller.rateChanged(1.25)
    controller.error({ stage: 'buffer', code: null, recoverable: true, attempt: 1 })
    controller.advance({ automatic: false, reason: 'next' })
    controller.teardown()
    await settle()

    assert.deepEqual(actions.map(action => action.type), [
      'start-requested', 'native-playing', 'periodic-checkpoint', 'pause', 'resume',
      'seek-requested', 'rate-changed', 'error', 'skip', 'teardown',
    ])
    assert.equal(flushes.length, 9)
  })

  it('ignores the redundant natural_end advance after native ended closed the group', async() => {
    const calls = []
    const recorder = loadRecorder(createTransport(calls))
    const clock = {
      now: () => 3_000,
      monotonicNow: () => 3_000,
      position: () => 120_000,
      timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 2, clearTimeout: () => {} },
    }
    const controller = loadController({
      recorder,
      policy: () => ({ recentAllowed: true, statsAllowed: true, privateMode: false }),
      clock,
    })

    controller.select(selection())
    controller.nativePlaying(1)
    await recorder.flush()
    controller.naturalEnd()
    controller.advance({ automatic: true, reason: 'natural_end' })
    await recorder.flush()

    const endFacts = calls.filter(call => call.kind == 'commit' && call.request.fact?.type == 'play_end')
    assert.equal(endFacts.length, 1)
  })
})

describe('query-backed renderer state', () => {
  it('loads recent rows with nullable playable payloads without fabricating music data', async() => {
    const recentPlayList = []
    const row = { version: 1, ...track(null), lastPlayedAtMs: 10, legacyRank: null }
    const { initRecentPlayList, getRecentPlayablePayload } = loadFeature(recentActionPath, {
      '@common/utils': { throttle: callback => callback },
      '@common/utils/vueTools': { toRaw: value => value },
      '@renderer/utils/ipc': {
        getRecentPlayList: async() => { throw new Error('legacy recent reader used') },
        saveRecentPlayList: () => { throw new Error('legacy recent writer used') },
      },
      '@renderer/utils/playback': { getRecentPlayback: async limit => { assert.equal(limit, 520); return [row] } },
      './state': { recentPlayList },
    })

    await initRecentPlayList()

    assert.deepEqual(recentPlayList, [row])
    assert.equal(getRecentPlayablePayload(recentPlayList[0]), null)
  })

  it('loads ListeningStatsV1 millisecond arrays without a legacy shadow object', async() => {
    const listeningTimeStats = {
      version: 1,
      total: {},
      daily: [],
      tracks: [],
      updatedAtMs: 0,
    }
    const result = {
      version: 1,
      total: { baselinePlayedMs: 1_000, livePlayedMs: 2_000, baselineActiveMs: 3_000, liveActiveMs: 4_000, playedMs: 3_000, activeMs: 7_000 },
      daily: [{ localDay: '2026-08-01', baselinePlayedMs: 0, livePlayedMs: 2_000, baselineActiveMs: 0, liveActiveMs: 2_500, playedMs: 2_000, activeMs: 2_500 }],
      tracks: [{ ...track(null), baselinePlayedMs: 0, livePlayedMs: 2_000, baselineActiveMs: 0, liveActiveMs: 2_500, playedMs: 2_000, activeMs: 2_500 }],
      updatedAtMs: 99,
    }
    const { initListeningTimeStats } = loadFeature(listeningActionPath, {
      '@common/utils': { throttle: callback => callback },
      '@common/utils/listeningTime': {},
      '@renderer/utils/ipc': {
        getListeningTimeStats: async() => { throw new Error('legacy listening reader used') },
        saveListeningTimeStats: () => { throw new Error('legacy listening writer used') },
      },
      '@renderer/store/player/state': {},
      '@renderer/utils/playback': { getListeningPlayback: async() => result },
      './state': { listeningTimeStats },
    })

    await initListeningTimeStats()

    assert.deepEqual(listeningTimeStats, result)
  })

  it('resolves resume by source identity before accepting a still-matching index hint', () => {
    const { resolvePlaybackResume } = loadFeature(dataInitPath, {
      '@renderer/utils/ipc': {},
      '@renderer/utils/playback': {},
      '@renderer/utils/musicSdk': {},
      '@common/utils': {},
      '@renderer/store/list/action': {},
      '@renderer/store/list/group': { initializeUserListGroups: async() => {} },
      '@renderer/core/player': {},
      '@common/utils/vueTools': {},
      '@renderer/store/setting': {},
      '@renderer/store/player/state': {},
      '@renderer/core/dislikeList': {},
      './useInitUserApi': () => async() => {},
    })
    const list = [
      { id: 'wrong', source: 'local', meta: { filePath: 'D:/wrong.flac' } },
      { id: 'track', source: 'local', meta: { filePath: 'D:/music.flac' } },
    ]
    const resume = {
      version: 1,
      source: 'local',
      sourceTrackId: 'track',
      listId: 'list',
      indexHint: 0,
      positionMs: 3_000,
      durationMs: 120_000,
      updatedAtMs: 10,
    }

    assert.deepEqual(resolvePlaybackResume(resume, list), { listId: 'list', index: 1, time: 3, maxTime: 120 })
    assert.equal(resolvePlaybackResume({ ...resume, sourceTrackId: 'missing' }, list), null)
  })

  it('disables both play and add-to-list controls for a nullable recent payload', () => {
    const source = fs.readFileSync(recentViewPath, 'utf8')
    assert.match(source, /:play-btn="item\.playablePayload != null"/)
    assert.match(source, /:list-add-btn="item\.playablePayload != null"/)
    assert.match(source, /const musicInfo = recentPlayItems\.value\[index\]\?\.playablePayload/)
  })
})

describe('legacy activity endpoint freeze', () => {
  it('keeps legacy access before the authoritative marker and disables get/set before store access after it', async() => {
    const calls = []
    let marker = null
    let markerReads = 0
    const { createDataHandlers } = loadFeature(dataHandlerPath, {
      '@common/constants': { STORE_NAMES: { DATA: 'data' } },
      '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: {} },
      '@common/mainIpc': { mainOn: () => {}, mainHandle: () => {} },
      '@main/utils/store': {},
    })
    const handlers = createDataHandlers(() => ({
      get(key) { calls.push(['get', key]); return { key } },
      set(key, value) { calls.push(['set', key, value]) },
    }), {
      getPlaybackActivityMigrationMarker: async() => { markerReads++; return marker },
    })

    assert.deepEqual(await handlers.get('playInfo'), { key: 'playInfo' })
    marker = {
      name: 'legacy_data_v1.playback_activity',
      sourceSha256: 'a'.repeat(64),
      completedAtMs: 1,
      detailsJson: '{}',
    }
    await assert.rejects(handlers.get('recentPlayList'), error => error.message == 'legacy_activity_disabled')
    await assert.rejects(handlers.set({ path: 'listeningTimeStats', data: {} }), error => error.message == 'legacy_activity_disabled')
    assert.deepEqual(calls, [['get', 'playInfo']])
    assert.equal(markerReads, 2)
  })

  it('does not treat an arbitrary or malformed marker as the playback activity cutover', async() => {
    const calls = []
    let marker = { name: 'other', sourceSha256: 'a'.repeat(64), completedAtMs: 1, detailsJson: '{}' }
    const { createDataHandlers } = loadFeature(dataHandlerPath, {
      '@common/constants': { STORE_NAMES: { DATA: 'data' } },
      '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: {} },
      '@common/mainIpc': { mainOn: () => {}, mainHandle: () => {} },
      '@main/utils/store': {},
    })
    const handlers = createDataHandlers(() => ({
      get(key) { calls.push(key); return null },
      set() {},
    }), {
      getPlaybackActivityMigrationMarker: async() => marker,
    })

    await handlers.get('playInfo')
    marker = { name: 'legacy_data_v1.playback_activity', sourceSha256: 'invalid', completedAtMs: 1, detailsJson: '{}' }
    await handlers.get('recentPlayList')
    assert.deepEqual(calls, ['playInfo', 'recentPlayList'])
  })

  it('registers legacy handlers without opening data.json after the authoritative marker', async() => {
    const registered = new Map()
    let storeProviderCalls = 0
    const marker = {
      name: 'legacy_data_v1.playback_activity',
      sourceSha256: 'a'.repeat(64),
      completedAtMs: 1,
      detailsJson: '{}',
    }
    const previousLx = global.lx
    global.lx = {
      worker: { dbService: { getPlaybackActivityMigrationMarker: async() => marker } },
    }

    try {
      const module = loadFeature(dataHandlerPath, {
        '@common/constants': { STORE_NAMES: { DATA: 'data' } },
        '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: { get_data: 'get', save_data: 'set' } },
        '@common/mainIpc': {
          mainHandle(name, handler) { registered.set(name, handler) },
          mainOn(name, handler) { registered.set(name, handler) },
        },
        '@main/utils/store': {
          __esModule: true,
          default() {
            storeProviderCalls++
            throw new Error('legacy store opened')
          },
        },
      })

      module.default()
      await assert.rejects(
        registered.get('get')({ params: 'playInfo' }),
        error => error.message == 'legacy_activity_disabled',
      )
      assert.equal(storeProviderCalls, 0)
    } finally {
      global.lx = previousLx
    }
  })
})

describe('bounded main-to-renderer shutdown flush', () => {
  it('registers playback, matches acknowledgements, passes 2500ms, and cleans pending state', async() => {
    let registered
    let request
    const bridgeModule = loadFeature(mainShutdownPath, {})
    const bridge = bridgeModule.createRendererShutdownBridge({
      registerShutdownFlusher(name, flush) { registered = { name, flush }; return () => {} },
      send(value) { request = value },
      isRendererAlive: () => true,
      createRequestId: () => UUID,
      setTimeout: () => 1,
      clearTimeout: () => {},
    })
    bridge.registerPlayback()

    assert.equal(registered.name, 'playback')
    const pending = registered.flush()
    assert.equal(request.timeoutMs, 2_500)
    assert.equal(bridge.acknowledge({ version: 1, requestId: '323e4567-e89b-42d3-a456-426614174000', name: 'playback', ok: true }), false)
    assert.equal(bridge.acknowledge({ version: 1, requestId: UUID, name: 'playback', ok: true }), true)
    await pending
    assert.equal(bridge.pendingCount(), 0)
  })

  it('rejects false acknowledgements, timeout, and dead-renderer requests without leaking pending state', async() => {
    const callbacks = []
    let alive = true
    let registered
    const bridge = loadFeature(mainShutdownPath).createRendererShutdownBridge({
      registerShutdownFlusher(name, flush) { registered = { name, flush }; return () => {} },
      send: () => {},
      isRendererAlive: () => alive,
      createRequestId: () => UUID,
      setTimeout(callback) { callbacks.push(callback); return callbacks.length },
      clearTimeout: () => {},
    })
    bridge.registerPlayback()

    const failed = registered.flush()
    bridge.acknowledge({ version: 1, requestId: UUID, name: 'playback', ok: false })
    await assert.rejects(failed, /renderer_playback_flush_failed/)
    assert.equal(bridge.pendingCount(), 0)

    const timedOut = registered.flush()
    callbacks.at(-1)()
    await assert.rejects(timedOut, /renderer_playback_flush_timeout/)
    assert.equal(bridge.pendingCount(), 0)

    alive = false
    await assert.rejects(registered.flush(), /renderer_unavailable/)
    assert.equal(bridge.pendingCount(), 0)
  })

  it('renderer registry invokes only the named flusher and reports false or thrown results', async() => {
    const sent = []
    const listeners = new Map()
    const module = loadFeature(rendererShutdownPath, {
      '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: { storage_shutdown_flush_request: 'request', storage_shutdown_flush_ack: 'ack' } },
      '@common/rendererIpc': {
        rendererOn(name, listener) { listeners.set(name, listener) },
        rendererSend(name, value) { sent.push([name, value]) },
      },
    })
    const registry = module.createRendererShutdownRegistry()
    const timeouts = []
    const unregister = registry.registerShutdownFlusher('playback', async timeoutMs => { timeouts.push(timeoutMs); return true })

    await listeners.get('request')({ params: { version: 1, requestId: UUID, name: 'playback', timeoutMs: 2_500 } })
    unregister()
    await listeners.get('request')({ params: { version: 1, requestId: UUID_2, name: 'playback', timeoutMs: 2_500 } })
    registry.registerShutdownFlusher('playback', async() => { throw new Error('flush failed') })
    await listeners.get('request')({ params: { version: 1, requestId: '323e4567-e89b-42d3-a456-426614174000', name: 'playback', timeoutMs: 2_500 } })

    assert.deepEqual(timeouts, [2_500])
    assert.deepEqual(sent, [
      ['ack', { version: 1, requestId: UUID, name: 'playback', ok: true }],
      ['ack', { version: 1, requestId: UUID_2, name: 'playback', ok: false }],
      ['ack', { version: 1, requestId: '323e4567-e89b-42d3-a456-426614174000', name: 'playback', ok: false }],
    ])
  })
})

describe('legacy writer removal', () => {
  it('contains no renderer legacy activity save calls or data keys', () => {
    const files = [
      'src/renderer/core/useApp/usePlayer/usePlayer.ts',
      'src/renderer/core/useApp/usePlayer/usePlayProgress.ts',
      'src/renderer/store/recentPlay/action.ts',
      'src/renderer/store/listeningTime/action.ts',
      'src/renderer/core/useApp/useDataInit.ts',
    ]
    const source = files.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n')
    assert.doesNotMatch(source, /savePlayInfo|saveRecentPlayList|saveListeningTimeStats/)
    assert.doesNotMatch(source, /DATA_KEYS\.(?:playInfo|recentPlayList|listeningTimeStats)/)
  })

  it('keeps the retained-delete User API wrapper byte-for-byte unchanged from the merge base', () => {
    const current = fs.readFileSync(path.join(root, 'src/renderer/utils/ipc.ts'), 'utf8').replaceAll('\r\n', '\n')
    const wrapper = current.match(/export const removeUserApi = async\([\s\S]*?\n}\nexport const onShowUserApiUpdateAlert/)
    assert.ok(wrapper)
    const { execFileSync } = require('node:child_process')
    const base = execFileSync('git', ['show', 'a05e265d:src/renderer/utils/ipc.ts'], { cwd: root, encoding: 'utf8' }).replaceAll('\r\n', '\n')
    const baseWrapper = base.match(/export const removeUserApi = async\([\s\S]*?\n}\nexport const onShowUserApiUpdateAlert/)
    assert.equal(wrapper[0], baseWrapper[0])
  })
})
