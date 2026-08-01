const assert = require('node:assert/strict')
const fs = require('node:fs')
const { describe, it } = require('node:test')
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

const { createPlaybackRecorderState, reduce } = require('../../src/renderer/core/playbackRecorder/reducer.ts')
const { nextLocalDayBoundary } = require('../../src/renderer/core/playbackRecorder/boundary.ts')

const UUID = '123e4567-e89b-42d3-a456-426614174000'
const UUID_2 = '223e4567-e89b-42d3-a456-426614174000'

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

const activityAck = (checkpointSeq = 1) => ({
  mode: 'activity',
  ack: { playbackGroupUuid: UUID, sessionUuid: UUID_2, segmentNo: 0, checkpointSeq, cumulativePlayedMs: 0, cumulativeActiveMs: 0 },
})

const lastCommand = state => state.outbox.at(-1)

const playingState = (sample = { monotonicMs: 0, positionMs: 0, playbackRate: 1 }, consent = undefined) => {
  let state = createPlaybackRecorderState()
  state = reduce(state, { type: 'start-requested', request: start(consent == null ? {} : { consent }) })
  state = reduce(state, { type: 'native-playing', ...sample })
  return reduce(state, { type: 'start-result', result: activityAck() })
}

describe('pure playback recorder', () => {
  it('emits start only for the first native playing event and keeps its group stable', () => {
    let state = createPlaybackRecorderState()
    state = reduce(state, { type: 'start-requested', request: start() })
    assert.equal(state.phase, 'pending')
    assert.equal(state.outbox.length, 0)
    state = reduce(state, { type: 'native-playing', monotonicMs: 1000, positionMs: 500, playbackRate: 1 })
    state = reduce(state, { type: 'native-playing', monotonicMs: 2000, positionMs: 1500, playbackRate: 1 })
    assert.equal(state.outbox.length, 1)
    assert.equal(state.outbox[0].kind, 'start')
    assert.equal(state.playbackGroupUuid, UUID)
    assert.equal(state.checkpointSeq, 1)
  })

  it('reserves the worker start sequence before a delayed activity start result', () => {
    let state = createPlaybackRecorderState()
    state = reduce(state, { type: 'start-requested', request: start() })
    state = reduce(state, { type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1 })
    assert.equal(state.checkpointSeq, 1)
    state = reduce(state, { type: 'pause', reason: 'user', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    assert.equal(lastCommand(state).request.checkpoint.checkpointSeq, 2)
    state = reduce(state, { type: 'start-result', result: activityAck(1) })
    assert.equal(state.checkpointSeq, 2)
    assert.equal(state.outbox.length, 1)
    assert.deepEqual(state.outbox[0].request.fact, { version: 1, type: 'pause', reason: 'user' })
  })

  it('records only playing deltas across pause, resume, buffering, and rate changes', () => {
    let state = playingState()
    state = reduce(state, { type: 'sample', monotonicMs: 1000, positionMs: 1000 })
    state = reduce(state, { type: 'pause', reason: 'user', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    state = reduce(state, { type: 'sample', monotonicMs: 5000, positionMs: 1000 })
    state = reduce(state, { type: 'resume', reason: 'user', monotonicMs: 5000, positionMs: 1000, playbackRate: 1, occurredAtMs: 1700000005000 })
    state = reduce(state, { type: 'buffering-start', monotonicMs: 7000, positionMs: 3000, occurredAtMs: 1700000007000 })
    state = reduce(state, { type: 'sample', monotonicMs: 9000, positionMs: 3000 })
    state = reduce(state, { type: 'buffering-end', monotonicMs: 9000, positionMs: 3000, playbackRate: 1, occurredAtMs: 1700000009000 })
    state = reduce(state, { type: 'rate-changed', monotonicMs: 10000, positionMs: 4000, playbackRate: 2, occurredAtMs: 1700000010000 })
    state = reduce(state, { type: 'sample', monotonicMs: 11000, positionMs: 6000 })
    state = reduce(state, { type: 'teardown', monotonicMs: 11000, positionMs: 6000, occurredAtMs: 1700000011000 })
    assert.equal(state.cumulativeActiveMs, 5000)
    assert.equal(state.cumulativePlayedMs, 6000)
    assert.equal(lastCommand(state).request.checkpoint.cumulativePlayedMs, 6000)
  })

  it('does not discard a delayed valid background sample', () => {
    let state = playingState({ monotonicMs: 1000, positionMs: 1000, playbackRate: 1 })
    state = reduce(state, { type: 'sample', monotonicMs: 7000, positionMs: 7000 })
    assert.equal(state.cumulativePlayedMs, 6000)
    assert.equal(state.cumulativeActiveMs, 6000)
  })

  it('excludes an implausible media jump and establishes a fresh sampling baseline', () => {
    let state = playingState()
    state = reduce(state, { type: 'sample', monotonicMs: 1000, positionMs: 1000 })
    state = reduce(state, { type: 'sample', monotonicMs: 2000, positionMs: 90000 })
    assert.equal(state.cumulativeActiveMs, 2000)
    assert.equal(state.cumulativePlayedMs, 1000)
    state = reduce(state, { type: 'sample', monotonicMs: 3000, positionMs: 91000 })
    assert.equal(state.cumulativePlayedMs, 2000)
  })

  it('excludes a party seek and resets sampling baselines', () => {
    let state = playingState()
    state = reduce(state, { type: 'sample', monotonicMs: 1000, positionMs: 1000 })
    state = reduce(state, { type: 'seek-requested', origin: 'party', fromMs: 1000, toMs: 90000, monotonicMs: 2000, occurredAtMs: 1700000002000 })
    assert.equal(state.cumulativePlayedMs, 1000)
    assert.equal(lastCommand(state).request.fact.origin, 'party')
    assert.equal(state.sample.positionMs, 90000)
    state = reduce(state, { type: 'sample', monotonicMs: 3000, positionMs: 91000 })
    assert.equal(state.cumulativePlayedMs, 2000)
  })

  it('keeps statistics counters at zero when statistics consent is disabled', () => {
    let state = playingState({ monotonicMs: 0, positionMs: 0, playbackRate: 1 }, { recentAllowed: true, statsAllowed: false, privateMode: false })
    state = reduce(state, { type: 'sample', monotonicMs: 4000, positionMs: 4000 })
    assert.equal(state.cumulativePlayedMs, 0)
    assert.equal(state.cumulativeActiveMs, 0)
  })

  it('records natural end, manual skip, automatic skip, retryable error, and final pre-play error distinctly', () => {
    let state = playingState()
    state = reduce(state, { type: 'natural-end', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    assert.deepEqual(lastCommand(state).request.fact, { version: 1, type: 'play_end', reason: 'natural_end' })
    assert.equal(state.phase, 'closing')

    state = playingState()
    state = reduce(state, { type: 'skip', reason: 'next', automatic: false, monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    assert.deepEqual(lastCommand(state).request.fact, { version: 1, type: 'skip', reason: 'next', automatic: false })

    state = playingState()
    state = reduce(state, { type: 'skip', reason: 'next', automatic: true, monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    assert.deepEqual(lastCommand(state).request.fact, { version: 1, type: 'skip', reason: 'next', automatic: true })

    state = playingState()
    state = reduce(state, { type: 'error', stage: 'buffer', code: 2, recoverable: true, attempt: 1, monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    assert.equal(lastCommand(state).request.fact.recoverable, true)
    assert.equal(state.phase, 'buffering')

    state = reduce(createPlaybackRecorderState(), { type: 'start-requested', request: start() })
    state = reduce(state, { type: 'error', stage: 'url', code: null, recoverable: false, attempt: 0, monotonicMs: 500, positionMs: 0, occurredAtMs: 1700000000500 })
    assert.equal(lastCommand(state).kind, 'preplay_failure')
    assert.equal(state.phase, 'closing')
  })

  it('creates a fresh pending session for repeat after checkpointing the completed session', () => {
    let state = playingState()
    state = reduce(state, { type: 'repeat', request: start({ playbackGroupUuid: UUID_2, startReason: 'auto' }), monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    assert.deepEqual(state.outbox.at(-1).request.fact, { version: 1, type: 'play_end', reason: 'natural_end' })
    assert.equal(state.phase, 'pending')
    assert.equal(state.playbackGroupUuid, UUID_2)
    state = reduce(state, { type: 'native-playing', monotonicMs: 2000, positionMs: 0, playbackRate: 1 })
    assert.equal(lastCommand(state).kind, 'start')
  })

  it('checkpoints before teardown and keeps failed commands queued until an equal-or-newer acknowledgement', () => {
    let state = playingState()
    state = reduce(state, { type: 'teardown', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    const checkpoint = lastCommand(state).request.checkpoint
    assert.equal(state.phase, 'closing')
    assert.equal(state.outbox[0].kind, 'commit')
    state = reduce(state, { type: 'send-failed' })
    assert.equal(state.outbox[0].kind, 'commit')
    state = reduce(state, { type: 'acknowledged', ack: { playbackGroupUuid: UUID, sessionUuid: UUID_2, segmentNo: 0, checkpointSeq: checkpoint.checkpointSeq - 1, cumulativePlayedMs: 0, cumulativeActiveMs: 0 } })
    assert.equal(state.outbox.length, 1)
    state = reduce(state, { type: 'acknowledged', ack: { playbackGroupUuid: UUID, sessionUuid: UUID_2, segmentNo: 0, checkpointSeq: checkpoint.checkpointSeq, cumulativePlayedMs: checkpoint.cumulativePlayedMs, cumulativeActiveMs: checkpoint.cumulativeActiveMs } })
    assert.equal(state.outbox.length, 0)

    let unsequencedStart = createPlaybackRecorderState()
    unsequencedStart = reduce(unsequencedStart, { type: 'start-requested', request: start() })
    unsequencedStart = reduce(unsequencedStart, { type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1 })
    unsequencedStart = reduce(unsequencedStart, { type: 'teardown', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    unsequencedStart = reduce(unsequencedStart, { type: 'acknowledged', ack: { playbackGroupUuid: UUID, sessionUuid: UUID_2, segmentNo: 0, checkpointSeq: 2, cumulativePlayedMs: 1000, cumulativeActiveMs: 1000 } })
    assert.equal(unsequencedStart.outbox.length, 1)
    assert.equal(unsequencedStart.outbox[0].kind, 'start')
  })

  it('emits a checkpoint with an explicit civil-day boundary', () => {
    let state = playingState()
    state = reduce(state, {
      type: 'day-boundary',
      monotonicMs: 1000,
      positionMs: 1000,
      occurredAtMs: 2000,
      nextLocalDay: '2026-08-02',
      utcOffsetMinutes: 480,
    })
    assert.deepEqual(lastCommand(state).request.boundary, {
      type: 'day_boundary',
      nextLocalDay: '2026-08-02',
      utcOffsetMinutes: 480,
    })
    assert.equal(lastCommand(state).request.checkpoint.occurredAtMs, 2000)
  })

  it('persists sampled periodic progress without adding a fact', () => {
    let state = playingState()
    state = reduce(state, { type: 'periodic-checkpoint', monotonicMs: 4000, positionMs: 4000, occurredAtMs: 1700000004000 })
    assert.equal(state.cumulativePlayedMs, 4000)
    assert.equal(state.cumulativeActiveMs, 4000)
    assert.equal(lastCommand(state).request.checkpoint.checkpointSeq, 2)
    assert.equal(Object.hasOwn(lastCommand(state).request, 'fact'), false)
  })

  it('keeps a retryable pre-play error pending until one final failure is emitted', () => {
    let state = reduce(createPlaybackRecorderState(), { type: 'start-requested', request: start() })
    state = reduce(state, { type: 'error', stage: 'url', code: null, recoverable: true, attempt: 1, monotonicMs: 500, positionMs: 0, occurredAtMs: 1700000000500 })
    assert.equal(state.phase, 'pending')
    assert.equal(state.pending.playbackGroupUuid, UUID)
    assert.equal(state.outbox.length, 0)
    state = reduce(state, { type: 'error', stage: 'url', code: null, recoverable: false, attempt: 2, monotonicMs: 600, positionMs: 0, occurredAtMs: 1700000000600 })
    assert.equal(state.phase, 'closing')
    assert.equal(state.outbox.length, 1)
    assert.equal(state.outbox[0].kind, 'preplay_failure')
  })

  it('correlates delayed start results without regressing a newer group sequence', () => {
    let state = createPlaybackRecorderState()
    state = reduce(state, { type: 'start-requested', request: start() })
    state = reduce(state, { type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1 })
    state = reduce(state, { type: 'repeat', request: start({ playbackGroupUuid: UUID_2, startReason: 'auto' }), monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    state = reduce(state, { type: 'native-playing', monotonicMs: 2000, positionMs: 0, playbackRate: 1 })
    state = reduce(state, { type: 'periodic-checkpoint', monotonicMs: 3000, positionMs: 1000, occurredAtMs: 1700000003000 })
    state = reduce(state, { type: 'start-result', result: activityAck() })
    assert.equal(state.playbackGroupUuid, UUID_2)
    assert.equal(state.checkpointSeq, 2)
    assert.equal(state.outbox.filter(command => command.kind == 'start').length, 1)
    assert.equal(state.outbox.find(command => command.kind == 'start').request.playbackGroupUuid, UUID_2)
  })

  it('ignores stale acknowledgements after a newer acknowledgement for the same group', () => {
    let state = playingState()
    state = reduce(state, { type: 'periodic-checkpoint', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    state = reduce(state, { type: 'periodic-checkpoint', monotonicMs: 2000, positionMs: 2000, occurredAtMs: 1700000002000 })
    state = reduce(state, { type: 'acknowledged', ack: { playbackGroupUuid: UUID, sessionUuid: UUID_2, segmentNo: 0, checkpointSeq: 3, cumulativePlayedMs: 2000, cumulativeActiveMs: 2000 } })
    state = reduce(state, { type: 'acknowledged', ack: { playbackGroupUuid: UUID, sessionUuid: UUID_2, segmentNo: 0, checkpointSeq: 2, cumulativePlayedMs: 1000, cumulativeActiveMs: 1000 } })
    assert.equal(state.acknowledged.checkpointSeq, 3)
    assert.equal(state.outbox.length, 0)
  })

  it('checkpoints statistics clear without creating a user-visible fact or new segment', () => {
    let state = playingState()
    state = reduce(state, { type: 'statistics-clear', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    assert.equal(state.playbackGroupUuid, UUID)
    assert.equal(state.checkpointSeq, 2)
    assert.equal(state.cumulativePlayedMs, 1000)
    assert.equal(Object.hasOwn(lastCommand(state).request, 'fact'), false)
    state = reduce(state, { type: 'sample', monotonicMs: 2000, positionMs: 2000 })
    assert.equal(state.cumulativePlayedMs, 2000)
  })

  it('uses explicit epoch timestamps for commands and rejects monotonic-time fallback', () => {
    assert.throws(() => reduce(playingState(), { type: 'teardown', monotonicMs: 1000, positionMs: 1000 }), /occurredAtMs/)
    let state = playingState()
    state = reduce(state, { type: 'teardown', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    assert.equal(lastCommand(state).request.checkpoint.occurredAtMs, 1700000001000)
  })

  it('records user and system seeks with their explicit origins', () => {
    for (const origin of ['bar', 'media_session']) {
      let state = playingState()
      state = reduce(state, { type: 'seek-requested', origin, fromMs: 0, toMs: 1000, monotonicMs: 1000, occurredAtMs: 1700000001000 })
      assert.equal(lastCommand(state).request.fact.origin, origin)
    }
  })

  it('keeps private, resume-only, and activity policy combinations distinct', () => {
    let privateState = createPlaybackRecorderState()
    privateState = reduce(privateState, { type: 'start-requested', request: start({ consent: { recentAllowed: true, statsAllowed: true, privateMode: true } }) })
    privateState = reduce(privateState, { type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1 })
    assert.equal(privateState.checkpointSeq, 0)
    privateState = reduce(privateState, { type: 'start-result', result: { mode: 'private', playbackGroupUuid: UUID, checkpointSeq: 0 } })
    privateState = reduce(privateState, { type: 'periodic-checkpoint', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    assert.equal(privateState.outbox.length, 0)
    assert.equal(privateState.cumulativePlayedMs, 1000)
    assert.equal(privateState.checkpointSeq, 0)

    let resumeOnly = createPlaybackRecorderState()
    resumeOnly = reduce(resumeOnly, { type: 'start-requested', request: start({ consent: { recentAllowed: false, statsAllowed: false, privateMode: false } }) })
    resumeOnly = reduce(resumeOnly, { type: 'native-playing', monotonicMs: 0, positionMs: 0, playbackRate: 1 })
    assert.equal(resumeOnly.checkpointSeq, 0)
    resumeOnly = reduce(resumeOnly, { type: 'start-result', result: { mode: 'resume-only', ack: { playbackGroupUuid: UUID, checkpointSeq: 0, positionMs: 0 } } })
    resumeOnly = reduce(resumeOnly, { type: 'periodic-checkpoint', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    assert.equal(lastCommand(resumeOnly).kind, 'resume')
    assert.equal(resumeOnly.cumulativePlayedMs, 0)

    let activity = playingState(undefined, { recentAllowed: false, statsAllowed: true, privateMode: false })
    activity = reduce(activity, { type: 'periodic-checkpoint', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    assert.equal(lastCommand(activity).kind, 'commit')
    assert.equal(activity.cumulativePlayedMs, 1000)
  })

  it('records recent-only playback as activity while keeping statistics counters at zero', () => {
    let state = playingState(undefined, { recentAllowed: true, statsAllowed: false, privateMode: false })
    state = reduce(state, { type: 'periodic-checkpoint', monotonicMs: 1000, positionMs: 1000, occurredAtMs: 1700000001000 })
    assert.equal(lastCommand(state).kind, 'commit')
    assert.equal(state.cumulativePlayedMs, 0)
    assert.equal(state.cumulativeActiveMs, 0)
  })

  it('uses civil midnight across 23-hour and 25-hour DST days', () => {
    const spring = nextLocalDayBoundary({
      afterMs: Date.parse('2026-03-08T05:00:00.000Z'),
      timeZone: 'America/New_York',
    })
    assert.deepEqual(spring, {
      occurredAtMs: Date.parse('2026-03-09T04:00:00.000Z'),
      nextLocalDay: '2026-03-09',
      utcOffsetMinutes: -240,
    })

    const fall = nextLocalDayBoundary({
      afterMs: Date.parse('2026-11-01T04:00:00.000Z'),
      timeZone: 'America/New_York',
    })
    assert.deepEqual(fall, {
      occurredAtMs: Date.parse('2026-11-02T05:00:00.000Z'),
      nextLocalDay: '2026-11-02',
      utcOffsetMinutes: -300,
    })

    const santiago = nextLocalDayBoundary({
      afterMs: Date.parse('2026-09-05T12:00:00.000Z'),
      timeZone: 'America/Santiago',
    })
    assert.deepEqual(santiago, {
      occurredAtMs: Date.parse('2026-09-06T04:00:00.000Z'),
      nextLocalDay: '2026-09-06',
      utcOffsetMinutes: -180,
    })
  })
})
