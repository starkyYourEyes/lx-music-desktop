const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  module._compile(output, filename)
}

const handlerPath = '../../src/main/modules/winMain/rendererEvent/playback.ts'
const rendererPath = '../../src/renderer/utils/playback.ts'
const recorderPath = '../../src/renderer/core/playbackRecorder/index.ts'
const commonRoot = path.resolve(__dirname, '../../src/common')

const UUID = '123e4567-e89b-42d3-a456-426614174000'
const UUID_2 = '223e4567-e89b-42d3-a456-426614174000'
const UUID_3 = '323e4567-e89b-42d3-a456-426614174000'

const start = (overrides = {}) => ({
  version: 1,
  playbackGroupUuid: UUID,
  track: { source: 'webdav', sourceTrackId: 'track', name: 'Name', singer: 'Singer', durationMs: 120000, playablePayload: null },
  context: { type: 'playlist', id: 'list' },
  resume: { listId: 'list', indexHint: 0 },
  startReason: 'select',
  startPositionMs: 0,
  occurredAtMs: 100,
  consent: { recentAllowed: true, statsAllowed: true, privateMode: false },
  ...overrides,
})

const checkpoint = (checkpointSeq = 2, overrides = {}) => ({
  playbackGroupUuid: UUID,
  checkpointSeq,
  cumulativePlayedMs: 1000,
  cumulativeActiveMs: 1000,
  positionMs: 1000,
  durationMs: 120000,
  occurredAtMs: 1100,
  ...overrides,
})

const commit = (checkpointSeq = 2) => ({ version: 1, checkpoint: checkpoint(checkpointSeq) })

const resumeUpdate = (checkpointSeq = 2) => ({
  version: 1,
  playbackGroupUuid: UUID,
  checkpointSeq,
  track: { source: 'webdav', sourceTrackId: 'track' },
  listId: 'list',
  indexHint: 0,
  positionMs: 1000,
  durationMs: 120000,
  updatedAtMs: 1100,
})

const preplayFailure = () => ({
  ...start(),
  error: { version: 1, type: 'error', stage: 'url', code: null, recoverable: false, attempt: 0 },
})

const activityAck = (checkpointSeq = 2, overrides = {}) => ({
  playbackGroupUuid: UUID,
  sessionUuid: UUID_2,
  segmentNo: 0,
  checkpointSeq,
  cumulativePlayedMs: checkpointSeq >= 2 ? 1000 : 0,
  cumulativeActiveMs: checkpointSeq >= 2 ? 1000 : 0,
  ...overrides,
})

const resumeAck = (checkpointSeq = 2, overrides = {}) => ({
  playbackGroupUuid: UUID,
  checkpointSeq,
  positionMs: checkpointSeq >= 2 ? 1000 : 0,
  ...overrides,
})

const recentTrack = {
  version: 1,
  ...start().track,
  lastPlayedAtMs: 1100,
  legacyRank: null,
}

const listening = {
  version: 1,
  total: { baselinePlayedMs: 0, livePlayedMs: 1000, baselineActiveMs: 0, liveActiveMs: 1000, playedMs: 1000, activeMs: 1000 },
  daily: [],
  tracks: [],
  updatedAtMs: 1100,
}

const savedResume = {
  version: 1,
  source: 'webdav',
  sourceTrackId: 'track',
  listId: 'list',
  indexHint: 0,
  positionMs: 1000,
  durationMs: 120000,
  updatedAtMs: 1100,
}

const loadSourceModule = (modulePath, stubs = {}) => {
  const originalLoad = Module._load
  Module._load = function(request, parent, isMain) {
    if (Object.hasOwn(stubs, request)) return stubs[request]
    if (request == '@common/mainIpc') return { mainHandle: () => {} }
    if (request.startsWith('@common/')) {
      return originalLoad.call(this, path.join(commonRoot, `${request.slice('@common/'.length)}.ts`), parent, isMain)
    }
    if (request.startsWith('@renderer/')) {
      return originalLoad.call(this, path.resolve(__dirname, '../../src/renderer', `${request.slice('@renderer/'.length)}.ts`), parent, isMain)
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return require(modulePath)
  } finally {
    Module._load = originalLoad
  }
}

const settle = async() => {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

afterEach(() => {
  for (const modulePath of [handlerPath, rendererPath, recorderPath]) {
    try { delete require.cache[require.resolve(modulePath)] } catch {}
  }
})

describe('typed playback IPC', () => {
  it('validates and dispatches all seven endpoint contracts', async() => {
    const calls = []
    const results = {
      start: { mode: 'activity', ack: activityAck(1) },
      commit: activityAck(),
      resume: resumeAck(),
      failure: activityAck(1),
      recent: [recentTrack],
      listening,
      savedResume,
    }
    const { createPlaybackHandlers } = loadSourceModule(handlerPath)
    const handlers = createPlaybackHandlers({
      playbackStart: request => { calls.push(['start', request]); return results.start },
      playbackCommit: request => { calls.push(['commit', request]); return results.commit },
      playbackUpdateResume: request => { calls.push(['resume', request]); return results.resume },
      playbackRecordPreplayFailure: request => { calls.push(['failure', request]); return results.failure },
      playbackGetRecent: request => { calls.push(['recent', request]); return results.recent },
      playbackGetListeningStats: () => { calls.push(['listening']); return results.listening },
      playbackGetResume: () => { calls.push(['saved-resume']); return results.savedResume },
    })

    assert.strictEqual(await handlers.start(start()), results.start)
    assert.strictEqual(await handlers.commit(commit()), results.commit)
    assert.strictEqual(await handlers.resumeUpdate(resumeUpdate()), results.resume)
    assert.strictEqual(await handlers.preplayFailure(preplayFailure()), results.failure)
    assert.strictEqual(await handlers.recentGet({ version: 1, limit: 2 }), results.recent)
    assert.strictEqual(await handlers.listeningGet(undefined), results.listening)
    assert.strictEqual(await handlers.resumeGet(undefined), results.savedResume)
    assert.deepEqual(calls.map(call => call[0]), ['start', 'commit', 'resume', 'failure', 'recent', 'listening', 'saved-resume'])
  })

  it('rejects malformed and hostile inputs before worker dispatch without leaking accessor errors', async() => {
    const workerCalls = []
    const { createPlaybackHandlers } = loadSourceModule(handlerPath)
    const unexpected = name => value => { workerCalls.push([name, value]); throw new Error('worker reached') }
    const handlers = createPlaybackHandlers({
      playbackStart: unexpected('start'),
      playbackCommit: unexpected('commit'),
      playbackUpdateResume: unexpected('resume'),
      playbackRecordPreplayFailure: unexpected('failure'),
      playbackGetRecent: unexpected('recent'),
      playbackGetListeningStats: unexpected('listening'),
      playbackGetResume: unexpected('saved-resume'),
    })
    const secret = 'sentinel-request-body'
    const hostile = new Proxy({}, { ownKeys() { throw new Error(secret) } })
    const cases = [
      () => handlers.start({ ...start(), playbackGroupUuid: 'bad' }),
      () => handlers.commit({ version: 1, checkpoint: { checkpointSeq: -1 } }),
      () => handlers.resumeUpdate({ ...resumeUpdate(), checkpointSeq: -1 }),
      () => handlers.preplayFailure({ ...preplayFailure(), error: { version: 1, type: 'pause', reason: 'user' } }),
      () => handlers.recentGet({ version: 1, limit: 0 }),
      () => handlers.listeningGet({}),
      () => handlers.resumeGet(null),
      () => handlers.commit(hostile),
      () => handlers.recentGet(hostile),
    ]
    for (const invoke of cases) {
      await assert.rejects(invoke, error => !String(error?.message).includes(secret))
    }
    assert.deepEqual(workerCalls, [])
  })

  it('validates every worker output and does not return hostile result sentinels', async() => {
    const secret = 'sentinel-worker-result'
    const hostile = new Proxy({}, { ownKeys() { throw new Error(secret) } })
    const hostileRecent = new Proxy([], {
      get(target, key, receiver) {
        if (key == 'then') return undefined
        if (key == 'map') throw new Error(secret)
        return Reflect.get(target, key, receiver)
      },
    })
    const { createPlaybackHandlers } = loadSourceModule(handlerPath)
    const handlers = createPlaybackHandlers({
      playbackStart: () => ({ mode: 'activity', ack: resumeAck() }),
      playbackCommit: () => hostile,
      playbackUpdateResume: () => ({ ...resumeAck(), extra: true }),
      playbackRecordPreplayFailure: () => ({ ...activityAck(), checkpointSeq: -1 }),
      playbackGetRecent: () => hostileRecent,
      playbackGetListeningStats: () => ({ ...listening, extra: true }),
      playbackGetResume: () => ({ ...savedResume, extra: true }),
    })
    const cases = [
      () => handlers.start(start()),
      () => handlers.commit(commit()),
      () => handlers.resumeUpdate(resumeUpdate()),
      () => handlers.preplayFailure(preplayFailure()),
      () => handlers.recentGet({ version: 1, limit: 2 }),
      () => handlers.listeningGet(undefined),
      () => handlers.resumeGet(undefined),
    ]
    for (const invoke of cases) {
      await assert.rejects(invoke, error => !String(error?.message).includes(secret))
    }
  })

  it('normalizes hostile worker outcomes for every endpoint without leaking sentinels', async() => {
    const secret = 'sentinel-worker-rejection'
    const hostileThenable = Object.create(null, {
      then: { get() { throw new Error(secret) } },
    })
    const validDependencies = () => ({
      playbackStart: () => ({ mode: 'activity', ack: activityAck(1) }),
      playbackCommit: () => activityAck(),
      playbackUpdateResume: () => resumeAck(),
      playbackRecordPreplayFailure: () => activityAck(1),
      playbackGetRecent: () => [recentTrack],
      playbackGetListeningStats: () => listening,
      playbackGetResume: () => savedResume,
    })
    const cases = [
      ['playbackStart', 'start', handlers => handlers.start(start())],
      ['playbackCommit', 'commit', handlers => handlers.commit(commit())],
      ['playbackUpdateResume', 'resume update', handlers => handlers.resumeUpdate(resumeUpdate())],
      ['playbackRecordPreplayFailure', 'preplay failure', handlers => handlers.preplayFailure(preplayFailure())],
      ['playbackGetRecent', 'recent', handlers => handlers.recentGet({ version: 1, limit: 2 })],
      ['playbackGetListeningStats', 'listening', handlers => handlers.listeningGet(undefined)],
      ['playbackGetResume', 'resume', handlers => handlers.resumeGet(undefined)],
    ]
    const { createPlaybackHandlers } = loadSourceModule(handlerPath)
    for (const [index, [dependency, endpoint, invoke]] of cases.entries()) {
      const dependencies = validDependencies()
      dependencies[dependency] = () => index % 2 == 0
        ? hostileThenable
        : Promise.reject(new Error(secret))
      const handlers = createPlaybackHandlers(dependencies)
      await assert.rejects(
        invoke(handlers),
        error => error.message == `Invalid playback ${endpoint} result` && !error.message.includes(secret),
      )
    }
  })

  it('maps renderer calls to the exact seven channels and query envelopes', async() => {
    const calls = []
    const channels = {
      playback_start: 'main_playback_start',
      playback_commit: 'main_playback_commit',
      playback_resume_update: 'main_playback_resume_update',
      playback_preplay_failure: 'main_playback_preplay_failure',
      playback_recent_get: 'main_playback_recent_get',
      playback_listening_get: 'main_playback_listening_get',
      playback_resume_get: 'main_playback_resume_get',
    }
    const playback = loadSourceModule(rendererPath, {
      '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: channels },
      '@common/rendererIpc': { rendererInvoke: (...args) => { calls.push(args); return Promise.resolve(null) } },
    })
    await playback.startPlayback(start())
    await playback.commitPlayback(commit())
    await playback.updatePlaybackResume(resumeUpdate())
    await playback.recordPlaybackPreplayFailure(preplayFailure())
    await playback.getRecentPlayback(3)
    await playback.getListeningPlayback()
    await playback.getPlaybackResume()
    assert.deepEqual(calls, [
      [channels.playback_start, start()],
      [channels.playback_commit, commit()],
      [channels.playback_resume_update, resumeUpdate()],
      [channels.playback_preplay_failure, preplayFailure()],
      [channels.playback_recent_get, { version: 1, limit: 3 }],
      [channels.playback_listening_get],
      [channels.playback_resume_get],
    ])
  })
})

describe('reliable playback command delivery', () => {
  const createRecorder = options => loadSourceModule(recorderPath).createPlaybackRecorder(options)

  const queueActivityCommit = async(recorder) => {
    recorder.dispatch({ type: 'start-requested', request: start() })
    recorder.dispatch({ type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1, occurredAtMs: 100 })
    await settle()
    recorder.dispatch({ type: 'pause', reason: 'user', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1100 })
  }

  it('sends only the outbox head and preserves queue order while it is in flight', async() => {
    const requests = []
    let resolveStart
    const recorder = createRecorder({
      transport: command => {
        requests.push(structuredClone(command))
        if (command.kind == 'start') return new Promise(resolve => { resolveStart = resolve })
        return Promise.resolve(activityAck(command.request.checkpoint.checkpointSeq))
      },
      retry: { initialMs: 1, maxMs: 4 },
    })
    recorder.dispatch({ type: 'start-requested', request: start() })
    recorder.dispatch({ type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1, occurredAtMs: 100 })
    recorder.dispatch({ type: 'pause', reason: 'user', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1100 })
    recorder.dispatch({ type: 'resume', reason: 'user', monotonicMs: 2000, positionMs: 1000, playbackRate: 1, occurredAtMs: 2100 })
    await settle()
    assert.deepEqual(requests.map(command => command.kind), ['start'])
    resolveStart({ mode: 'activity', ack: activityAck(1) })
    assert.equal(await recorder.flush({ timeoutMs: 100 }), true)
    assert.deepEqual(requests.map(command => command.kind), ['start', 'commit', 'commit'])
    assert.deepEqual(requests.slice(1).map(command => command.request.checkpoint.checkpointSeq), [2, 3])
  })

  it('retries a lost acknowledgement with the exact same group and sequence', async() => {
    const requests = []
    const applied = new Map()
    let loseResponse = true
    const recorder = createRecorder({
      transport: async command => {
        requests.push(structuredClone(command))
        if (command.kind == 'start') return { mode: 'activity', ack: activityAck(1) }
        const key = `${command.request.checkpoint.playbackGroupUuid}:${command.request.checkpoint.checkpointSeq}`
        if (!applied.has(key)) applied.set(key, structuredClone(command.request.fact))
        if (loseResponse) { loseResponse = false; throw new Error('response lost after commit') }
        return activityAck(command.request.checkpoint.checkpointSeq)
      },
      retry: { initialMs: 1, maxMs: 4 },
    })
    await queueActivityCommit(recorder)
    assert.equal(await recorder.flush({ timeoutMs: 100 }), true)
    const commits = requests.filter(command => command.kind == 'commit')
    assert.deepEqual(commits.map(command => [command.request.checkpoint.playbackGroupUuid, command.request.checkpoint.checkpointSeq]), [[UUID, 2], [UUID, 2]])
    assert.equal(applied.size, 1)
    assert.deepEqual([...applied.values()], [{ version: 1, type: 'pause', reason: 'user' }])
  })

  it('keeps the head for stale, wrong-group, and wrong-mode acknowledgements', async() => {
    const responses = [
      activityAck(2, { playbackGroupUuid: UUID_3 }),
      activityAck(1),
      resumeAck(2),
      activityAck(2),
    ]
    const attempts = []
    const recorder = createRecorder({
      transport: async command => {
        attempts.push(structuredClone(command))
        if (command.kind == 'start') return { mode: 'activity', ack: activityAck(1) }
        return responses.shift()
      },
      retry: { initialMs: 1, maxMs: 2 },
    })
    await queueActivityCommit(recorder)
    assert.equal(await recorder.flush({ timeoutMs: 100 }), true)
    const commits = attempts.filter(command => command.kind == 'commit')
    assert.equal(commits.length, 4)
    assert.ok(commits.every(command => command.request.checkpoint.playbackGroupUuid == UUID))
    assert.ok(commits.every(command => command.request.checkpoint.checkpointSeq == 2))
  })

  it('applies start, resume-only, private, and preplay-failure results without mixing group modes', async() => {
    const resumeRecorder = createRecorder({
      transport: async command => command.kind == 'start'
        ? { mode: 'resume-only', ack: resumeAck(0) }
        : resumeAck(command.request.checkpointSeq),
      retry: { initialMs: 1, maxMs: 2 },
    })
    resumeRecorder.dispatch({ type: 'start-requested', request: start({ consent: { recentAllowed: false, statsAllowed: false, privateMode: false } }) })
    resumeRecorder.dispatch({ type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1, occurredAtMs: 100 })
    await settle()
    resumeRecorder.dispatch({ type: 'periodic-checkpoint', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1100 })
    assert.equal(await resumeRecorder.flush({ timeoutMs: 100 }), true)
    assert.equal(resumeRecorder.getState().outbox.length, 0)

    const privateRecorder = createRecorder({ transport: async() => ({ mode: 'private', playbackGroupUuid: UUID, checkpointSeq: 0 }) })
    privateRecorder.dispatch({ type: 'start-requested', request: start({ consent: { recentAllowed: true, statsAllowed: true, privateMode: true } }) })
    privateRecorder.dispatch({ type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1, occurredAtMs: 100 })
    assert.equal(await privateRecorder.flush({ timeoutMs: 100 }), true)
    privateRecorder.dispatch({ type: 'periodic-checkpoint', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1100 })
    assert.equal(privateRecorder.getState().outbox.length, 0)

    const failureRecorder = createRecorder({ transport: async() => activityAck(1), retry: { initialMs: 1, maxMs: 2 } })
    failureRecorder.dispatch({ type: 'start-requested', request: start() })
    failureRecorder.dispatch({ type: 'error', stage: 'url', code: null, recoverable: false, attempt: 0, monotonicMs: 0, positionMs: 0, occurredAtMs: 100 })
    assert.equal(await failureRecorder.flush({ timeoutMs: 100 }), true)
    assert.equal(failureRecorder.getState().outbox.length, 0)

    let wrongModeOnce = true
    const modeRecorder = createRecorder({
      transport: async() => {
        if (wrongModeOnce) { wrongModeOnce = false; return { mode: 'resume-only', ack: resumeAck(1) } }
        return { mode: 'activity', ack: activityAck(1) }
      },
      retry: { initialMs: 1, maxMs: 2 },
    })
    modeRecorder.dispatch({ type: 'start-requested', request: start() })
    modeRecorder.dispatch({ type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1, occurredAtMs: 100 })
    assert.equal(await modeRecorder.flush({ timeoutMs: 100 }), true)
    assert.equal(modeRecorder.getState().deliveryMode, 'activity')
  })

  it('shares one in-flight attempt across concurrent flush calls', async() => {
    let attempts = 0
    let resolveStart
    const recorder = createRecorder({
      transport: () => {
        attempts++
        return new Promise(resolve => { resolveStart = resolve })
      },
    })
    recorder.dispatch({ type: 'start-requested', request: start() })
    recorder.dispatch({ type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1, occurredAtMs: 100 })
    await settle()
    const first = recorder.flush({ timeoutMs: 100 })
    const second = recorder.flush({ timeoutMs: 100 })
    assert.equal(attempts, 1)
    resolveStart({ mode: 'activity', ack: activityAck(1) })
    assert.deepEqual(await Promise.all([first, second]), [true, true])
  })

  it('bounds flush timeout and preserves a hanging head', async() => {
    const recorder = createRecorder({ transport: () => new Promise(() => {}) })
    recorder.dispatch({ type: 'start-requested', request: start() })
    recorder.dispatch({ type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1, occurredAtMs: 100 })
    const before = Date.now()
    assert.equal(await recorder.flush({ timeoutMs: 15 }), false)
    assert.ok(Date.now() - before < 250)
    assert.equal(recorder.getState().outbox[0].kind, 'start')
  })

  it('stops retrying when the window dies and leaves the failed head untouched', async() => {
    let alive = true
    let attempts = 0
    const timers = []
    const recorder = createRecorder({
      transport: async() => { attempts++; throw new Error('transport closed') },
      isAlive: () => alive,
      clock: {
        now: () => 0,
        setTimeout: callback => { timers.push(callback); return callback },
        clearTimeout: timer => {
          const index = timers.indexOf(timer)
          if (index >= 0) timers.splice(index, 1)
        },
      },
      retry: { initialMs: 5, maxMs: 10 },
    })
    recorder.dispatch({ type: 'start-requested', request: start() })
    recorder.dispatch({ type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1, occurredAtMs: 100 })
    await settle()
    assert.equal(timers.length, 1)
    alive = false
    timers.shift()()
    await settle()
    assert.equal(await recorder.flush({ timeoutMs: 20 }), false)
    assert.equal(attempts, 1)
    assert.equal(recorder.getState().outbox[0].kind, 'start')
  })

  it('uses bounded exponential backoff while transport remains alive', async() => {
    const delays = []
    const timers = []
    const clock = {
      now: () => 0,
      setTimeout: (callback, delay) => {
        delays.push(delay)
        timers.push(callback)
        return callback
      },
      clearTimeout: timer => {
        const index = timers.indexOf(timer)
        if (index >= 0) timers.splice(index, 1)
      },
    }
    const recorder = createRecorder({
      transport: async() => { throw new Error('offline') },
      clock,
      retry: { initialMs: 5, maxMs: 20 },
    })
    recorder.dispatch({ type: 'start-requested', request: start() })
    recorder.dispatch({ type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1, occurredAtMs: 100 })
    await settle()
    for (let i = 0; i < 3; i++) {
      const timer = timers.shift()
      assert.ok(timer)
      timer()
      await settle()
    }
    assert.deepEqual(delays.slice(0, 4), [5, 10, 20, 20])
    assert.equal(recorder.getState().outbox[0].kind, 'start')
  })

  it('rejects retry options that could create a zero-delay or inverted backoff', () => {
    const invalid = [
      { initialMs: 0, maxMs: 0 },
      { initialMs: -1, maxMs: 10 },
      { initialMs: 1, maxMs: 0 },
      { initialMs: 10, maxMs: 5 },
      { initialMs: Number.NaN, maxMs: 10 },
      { initialMs: 1, maxMs: Number.POSITIVE_INFINITY },
    ]
    for (const retry of invalid) {
      assert.throws(
        () => createRecorder({ transport: async() => activityAck(1), retry }),
        /Invalid playback retry options/,
      )
    }
    assert.doesNotThrow(() => createRecorder({ transport: async() => activityAck(1), retry: { initialMs: 1, maxMs: 1 } }))
  })

  it('sends nothing when the queued outbox mixes modes within one group', async() => {
    const requests = []
    const timers = []
    const recorder = createRecorder({
      transport: async command => { requests.push(command); return { mode: 'activity', ack: activityAck(1) } },
      clock: {
        now: () => 0,
        setTimeout: callback => { timers.push(callback); return callback },
        clearTimeout: () => {},
      },
    })
    recorder.dispatch({ type: 'start-requested', request: start() })
    recorder.dispatch({ type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1, occurredAtMs: 100 })
    recorder.dispatch({
      type: 'repeat',
      request: start({ consent: { recentAllowed: false, statsAllowed: false, privateMode: false } }),
      monotonicMs: 1000,
      positionMs: 1000,
      occurredAtMs: 1100,
    })
    recorder.dispatch({ type: 'native-playing', monotonicMs: 1100, positionMs: 0, playbackRate: 1, occurredAtMs: 1200 })
    await settle()
    assert.deepEqual(requests, [])
    assert.deepEqual(recorder.getState().outbox.map(command => command.kind), ['start', 'commit', 'start'])
    assert.ok(recorder.getState().outbox.every(command => {
      if (command.kind == 'commit') return command.request.checkpoint.playbackGroupUuid == UUID
      return command.request.playbackGroupUuid == UUID
    }))
  })

  it('does not apply an in-flight acknowledgement after the queued group becomes mixed-mode', async() => {
    const requests = []
    const timers = []
    let resolveStart
    const recorder = createRecorder({
      transport: command => {
        requests.push(command)
        return new Promise(resolve => { resolveStart = resolve })
      },
      clock: {
        now: () => 0,
        setTimeout: callback => { timers.push(callback); return callback },
        clearTimeout: () => {},
      },
    })
    recorder.dispatch({ type: 'start-requested', request: start() })
    recorder.dispatch({ type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1, occurredAtMs: 100 })
    await settle()
    assert.equal(requests.length, 1)
    recorder.dispatch({
      type: 'repeat',
      request: start({ consent: { recentAllowed: false, statsAllowed: false, privateMode: false } }),
      monotonicMs: 1000,
      positionMs: 1000,
      occurredAtMs: 1100,
    })
    recorder.dispatch({ type: 'native-playing', monotonicMs: 1100, positionMs: 0, playbackRate: 1, occurredAtMs: 1200 })
    resolveStart({ mode: 'activity', ack: activityAck(1) })
    await settle()
    assert.equal(requests.length, 1)
    assert.deepEqual(recorder.getState().outbox.map(command => command.kind), ['start', 'commit', 'start'])
  })

  it('never logs request bodies or music payloads on validation and delivery failure', async() => {
    const logged = []
    const originals = { log: console.log, warn: console.warn, error: console.error }
    console.log = (...args) => logged.push(args)
    console.warn = (...args) => logged.push(args)
    console.error = (...args) => logged.push(args)
    try {
      const { createPlaybackHandlers } = loadSourceModule(handlerPath)
      const handlers = createPlaybackHandlers({
        playbackStart: () => { throw new Error('unexpected') },
        playbackCommit: () => { throw new Error('unexpected') },
        playbackUpdateResume: () => { throw new Error('unexpected') },
        playbackRecordPreplayFailure: () => { throw new Error('unexpected') },
        playbackGetRecent: () => { throw new Error('unexpected') },
        playbackGetListeningStats: () => { throw new Error('unexpected') },
        playbackGetResume: () => { throw new Error('unexpected') },
      })
      await assert.rejects(handlers.start({ ...start(), track: { ...start().track, playablePayload: { secret: 'music-secret' } }, extra: true }))
      let alive = true
      const recorder = createRecorder({
        transport: async() => { alive = false; throw new Error('offline') },
        isAlive: () => alive,
        retry: { initialMs: 1000, maxMs: 1000 },
      })
      recorder.dispatch({ type: 'start-requested', request: start({ track: { ...start().track, name: 'music-secret' } }) })
      recorder.dispatch({ type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1, occurredAtMs: 100 })
      await settle()
      assert.deepEqual(logged, [])
    } finally {
      console.log = originals.log
      console.warn = originals.warn
      console.error = originals.error
    }
  })
})
