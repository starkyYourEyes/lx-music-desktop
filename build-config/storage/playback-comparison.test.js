const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
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
const comparisonPath = path.join(root, 'src/renderer/core/playbackRecorder/comparison.ts')
const controllerPath = path.join(root, 'src/renderer/core/useApp/usePlayer/usePlaybackRecorder.ts')
const previousNodeEnv = process.env.NODE_ENV
const previousCompare = process.env.LX_STORAGE_COMPARE_PLAYBACK

afterEach(() => {
  if (previousNodeEnv == null) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previousNodeEnv
  if (previousCompare == null) delete process.env.LX_STORAGE_COMPARE_PLAYBACK
  else process.env.LX_STORAGE_COMPARE_PLAYBACK = previousCompare
  for (const filename of [comparisonPath, controllerPath]) {
    try { delete require.cache[require.resolve(filename)] } catch {}
  }
})

const track = (sourceTrackId = 'track-secret') => ({
  source: 'source-secret',
  sourceTrackId,
})

const loadComparison = () => {
  assert.equal(fs.existsSync(comparisonPath), true, 'Task 11 comparison module is missing')
  return require(comparisonPath)
}

describe('development playback comparison', () => {
  it('is enabled only by the exact non-production opt-in', () => {
    const { playbackComparisonEnabled } = loadComparison()

    process.env.NODE_ENV = 'development'
    process.env.LX_STORAGE_COMPARE_PLAYBACK = '1'
    assert.equal(playbackComparisonEnabled(), true)

    for (const [nodeEnv, optIn] of [
      ['production', '1'],
      ['development', '0'],
      ['development', 'true'],
      ['test', undefined],
    ]) {
      process.env.NODE_ENV = nodeEnv
      if (optIn == null) delete process.env.LX_STORAGE_COMPARE_PLAYBACK
      else process.env.LX_STORAGE_COMPARE_PLAYBACK = optIn
      assert.equal(playbackComparisonEnabled(), false)
    }
  })

  it('normalizes fractional seconds and compares total, day, and salted track deltas', () => {
    const { createPlaybackComparison } = loadComparison()
    const compare = createPlaybackComparison({
      isEnabled: () => true,
      salt: Buffer.alloc(32, 7),
      log: () => { throw new Error('zero differences must not log') },
    })

    compare.recordNewDelta({ playedMs: 1_251, localDay: '2026-08-01', track: track() })
    compare.recordLegacyDelta({
      seconds: 1.2506,
      occurredAtMs: new Date(2026, 7, 1, 12).getTime(),
      localDay: '2026-08-01',
      track: track(),
    })

    assert.deepEqual(compare.flush(), {
      version: 1,
      playedDifferenceMs: 0,
      dailyDifferencesMs: [],
      trackDifferences: [],
    })
  })

  it('feeds one accepted stats-allowed delta to both models without retaining music payloads', () => {
    const { createPlaybackComparison } = loadComparison()
    const diagnostics = []
    const compare = createPlaybackComparison({
      isEnabled: () => true,
      salt: Buffer.alloc(32, 9),
      log: value => diagnostics.push(value),
    })
    const input = {
      playedMs: 1_250,
      occurredAtMs: new Date(2026, 7, 2, 12).getTime(),
      localDay: '2026-08-02',
      track: {
        ...track(),
        name: 'PRIVATE_NAME',
        singer: 'PRIVATE_SINGER',
        playablePayload: { token: 'PRIVATE_TOKEN' },
      },
    }

    compare.recordAcceptedDelta(input)
    assert.deepEqual(compare.flush(), {
      version: 1,
      playedDifferenceMs: 0,
      dailyDifferencesMs: [],
      trackDifferences: [],
    })
    assert.equal(diagnostics.length, 0)
    assert.doesNotMatch(JSON.stringify(compare), /PRIVATE_|source-secret|track-secret|2026-08-02/)
  })

  it('uses the injected timestamp to expose an independent legacy day-bucket mismatch', () => {
    const { createPlaybackComparison } = loadComparison()
    const compare = createPlaybackComparison({
      isEnabled: () => true,
      salt: Buffer.alloc(32, 10),
      log: () => {},
    })

    compare.recordNewDelta({ playedMs: 1_000, localDay: '2026-08-01', track: track() })
    compare.recordLegacyDelta({
      seconds: 1,
      occurredAtMs: new Date(2026, 7, 2, 12).getTime(),
      localDay: '2026-08-01',
      track: track(),
    })

    const diagnostic = compare.flush()
    assert.equal(diagnostic.playedDifferenceMs, 0)
    assert.deepEqual([...diagnostic.dailyDifferencesMs].sort((a, b) => a - b), [-1_000, 1_000])
    assert.deepEqual(diagnostic.trackDifferences, [])
  })

  it('hashes source and track ID as an unambiguous tuple', () => {
    const { createPlaybackComparison } = loadComparison()
    const compare = createPlaybackComparison({
      isEnabled: () => true,
      salt: Buffer.alloc(32, 12),
      log: () => {},
    })

    compare.recordNewDelta({
      playedMs: 10,
      localDay: '2026-08-01',
      track: { source: 'source/part', sourceTrackId: 'track' },
    })
    compare.recordLegacyDelta({
      seconds: 0.01,
      occurredAtMs: new Date(2026, 7, 1, 12).getTime(),
      localDay: '2026-08-01',
      track: { source: 'source', sourceTrackId: 'part/track' },
    })

    const diagnostic = compare.flush()
    assert.equal(diagnostic.trackDifferences.length, 2)
    assert.deepEqual(diagnostic.trackDifferences.map(value => value.playedDifferenceMs).sort((a, b) => a - b), [-10, 10])
  })

  it('bounds mismatch state, emits hashes and numbers only, and clears it on flush', () => {
    const { createPlaybackComparison } = loadComparison()
    const logged = []
    const compare = createPlaybackComparison({
      isEnabled: () => true,
      salt: Buffer.alloc(32, 11),
      maxEntries: 2,
      log: value => logged.push(value),
    })

    for (let index = 0; index < 5; index++) {
      compare.recordNewDelta({ playedMs: 10 + index, localDay: `2026-08-0${index + 1}`, track: track(`secret-${index}`) })
    }
    const diagnostic = compare.flush()
    assert.equal(diagnostic.version, 1)
    assert.equal(diagnostic.trackDifferences.length <= 2, true)
    assert.equal(diagnostic.dailyDifferencesMs.length <= 2, true)
    assert.equal(logged.length, 1)
    const serialized = JSON.stringify(diagnostic)
    assert.doesNotMatch(serialized, /source-secret|track-secret|secret-|2026-08|PRIVATE|payload|name|singer/i)
    for (const entry of diagnostic.trackDifferences) {
      assert.match(entry.trackHash, /^[a-f0-9]{64}$/)
      assert.equal(Number.isSafeInteger(entry.playedDifferenceMs), true)
    }
    assert.deepEqual(compare.flush(), {
      version: 1,
      playedDifferenceMs: 0,
      dailyDifferencesMs: [],
      trackDifferences: [],
    })
  })

  it('records only the reducer accepted stats delta and flushes at a checkpoint', () => {
    const calls = []
    let state = {
      phase: 'idle',
      playbackGroupUuid: null,
      cumulativePlayedMs: 0,
      session: null,
    }
    const recorder = {
      getState: () => state,
      dispatch(action) {
        if (action.type == 'start-requested') state = { ...state, phase: 'pending', playbackGroupUuid: action.request.playbackGroupUuid, session: action.request }
        if (action.type == 'native-playing') state = { ...state, phase: 'playing' }
        if (action.type == 'sample') state = { ...state, cumulativePlayedMs: 1_250 }
        if (action.type == 'periodic-checkpoint') state = { ...state, cumulativePlayedMs: 1_500 }
        return state
      },
      flush: async() => true,
    }
    const comparison = {
      recordAcceptedDelta: value => calls.push(['delta', value]),
      flush: () => { calls.push(['flush']); return { version: 1, playedDifferenceMs: 0, dailyDifferencesMs: [], trackDifferences: [] } },
    }
    const controller = loadTsModule(controllerPath, {
      '@renderer/core/playbackRecorder': { createPlaybackRecorder: () => recorder },
      '@renderer/store/recentPlay/action': { initRecentPlayList: async() => {} },
      '@renderer/store/listeningTime/action': { initListeningTimeStats: async() => {} },
      '@renderer/utils/ipc': { registerShutdownFlusher: () => () => {} },
      '@renderer/plugins/player': {},
      '@renderer/store/player/state': {},
      '@renderer/store/player/playbackRate': {},
      '@common/utils/vueTools': { onBeforeUnmount: () => {} },
    }).createPlaybackRecorderController({
      recorder,
      comparison,
      now: () => Date.parse('2026-08-01T01:00:00.000Z'),
      monotonicNow: () => 2_250,
      getPositionMs: () => 2_250,
      getDurationMs: () => 30_000,
      timeZone: 'UTC',
      timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 2, clearTimeout: () => {} },
    })

    controller.select({
      track: { source: 'test', sourceTrackId: 'one', name: 'Name', singer: 'Singer', durationMs: 30_000, playablePayload: null },
      context: { type: null, id: null },
      resume: { listId: null, indexHint: null },
      startReason: 'select',
      startPositionMs: 0,
    })
    controller.nativePlaying(1)
    controller.sample()
    controller.checkpoint()

    assert.equal(calls[0][0], 'delta')
    assert.equal(calls[0][1].playedMs, 1_250)
    assert.equal(calls[0][1].localDay, '2026-08-01')
    assert.equal(calls[1][0], 'delta')
    assert.equal(calls[1][1].playedMs, 250)
    assert.deepEqual(calls[2], ['flush'])
  })

  it('contains no legacy persistence or legacy data IPC dependency', () => {
    const source = [comparisonPath, controllerPath].map(filename => fs.readFileSync(filename, 'utf8')).join('\n')
    assert.doesNotMatch(source, /saveListeningTimeStats|rendererInvoke|DATA_KEYS\.listeningTimeStats|savePlayInfo|saveRecentPlayList/)
  })
})
