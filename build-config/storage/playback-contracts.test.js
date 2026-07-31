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

const {
  getPlaybackStartMode,
  parsePlaybackCheckpoint,
  parsePlaybackCommitRequest,
  parsePlaybackEventDetails,
  parsePlaybackFact,
  parsePlaybackPreplayFailure,
  parsePlaybackResumeUpdate,
  parsePlaybackStartCommand,
  sanitizePlayableTrack,
  validateCheckpointAfter,
} = require('../../src/common/storage/playbackValidation.ts')

const UUID = '123e4567-e89b-42d3-a456-426614174000'
const MAX_MS = 7 * 24 * 60 * 60 * 1000

const track = (overrides = {}) => ({
  source: 'webdav',
  sourceTrackId: 'track',
  name: 'Name',
  singer: 'Singer',
  durationMs: 120000,
  playablePayload: {
    id: 'track',
    source: 'webdav',
    name: 'Name',
    singer: 'Singer',
    interval: '02:00',
    meta: { songId: 'track', albumName: 'Album', path: 'music/a.flac', url: 'https://expired.example/a?token=SECRET' },
  },
  ...overrides,
})

const start = (overrides = {}) => ({
  version: 1,
  playbackGroupUuid: UUID,
  track: track(),
  context: { type: 'playlist', id: 'list' },
  resume: { listId: 'list', indexHint: 0 },
  startReason: 'select',
  startPositionMs: 0,
  occurredAtMs: 1,
  consent: { recentAllowed: true, statsAllowed: true, privateMode: false },
  ...overrides,
})

const checkpoint = (overrides = {}) => ({
  playbackGroupUuid: UUID,
  checkpointSeq: 1,
  cumulativePlayedMs: 10,
  cumulativeActiveMs: 9,
  positionMs: 10,
  durationMs: 120000,
  occurredAtMs: 1,
  ...overrides,
})

describe('playback activity contracts', () => {
  it('accepts the exact start command at documented scalar boundaries', () => {
    const command = start({
      track: track({ durationMs: null, playablePayload: null }),
      context: { type: 'x'.repeat(256), id: null },
      resume: { listId: null, indexHint: 1000000 },
      startPositionMs: MAX_MS,
      occurredAtMs: Number.MAX_SAFE_INTEGER,
    })
    const result = parsePlaybackStartCommand(command)
    assert.deepEqual(result, command)
    assert.notStrictEqual(result, command)
    assert.notStrictEqual(result.track, command.track)
  })

  it('rejects version, keys, UUID variants, nullable fields, and scalar range regressions', () => {
    const cases = [
      start({ version: 2 }),
      { ...start(), extra: true },
      start({ playbackGroupUuid: UUID.toUpperCase() }),
      start({ playbackGroupUuid: '123e4567-e89b-12d3-a456-426614174000' }),
      start({ context: { type: null, id: undefined } }),
      start({ resume: { listId: 'list', indexHint: 1.5 } }),
      start({ resume: { listId: 'list', indexHint: 1000001 } }),
      start({ startPositionMs: Number.NaN }),
      start({ startPositionMs: Number.POSITIVE_INFINITY }),
      start({ startPositionMs: -1 }),
      start({ startPositionMs: MAX_MS + 1 }),
      start({ context: { type: 'x'.repeat(257), id: null } }),
    ]
    for (const value of cases) assert.throws(() => parsePlaybackStartCommand(value))
  })

  it('validates every playback fact enum and exact fact shape', () => {
    const valid = [
      { version: 1, type: 'play_start', reason: 'statistics_clear' },
      { version: 1, type: 'pause', reason: 'recovery' },
      { version: 1, type: 'resume', reason: 'remote' },
      { version: 1, type: 'seek', origin: 'buffer_recovery', fromMs: 0, toMs: MAX_MS },
      { version: 1, type: 'skip', reason: 'queue_removed', automatic: true },
      { version: 1, type: 'play_end', reason: 'natural_end' },
      { version: 1, type: 'error', stage: 'unknown', code: null, recoverable: false, attempt: 0 },
    ]
    for (const fact of valid) assert.deepEqual(parsePlaybackFact(fact), fact)

    const invalid = [
      { version: 1, type: 'play_start', reason: 'user' },
      { version: 1, type: 'pause', reason: 'auto' },
      { version: 1, type: 'seek', origin: 'drag', fromMs: 0, toMs: 1 },
      { version: 1, type: 'skip', reason: 'auto' },
      { version: 1, type: 'skip', reason: 'next', automatic: 'true' },
      { version: 1, type: 'play_end', reason: 'skip' },
      { version: 1, type: 'error', stage: 'network', code: null, recoverable: false, attempt: 0 },
      { version: 1, type: 'error', stage: 'load', code: 1.5, recoverable: false, attempt: 0 },
      { version: 1, type: 'seek', origin: 'bar', fromMs: 0, toMs: 1, extra: true },
    ]
    for (const fact of invalid) assert.throws(() => parsePlaybackFact(fact))
  })

  it('rejects untyped skips and cumulative checkpoint regressions', () => {
    assert.throws(() => parsePlaybackFact({ version: 1, type: 'skip', reason: 'auto' }))
    const previous = checkpoint()
    assert.throws(() => validateCheckpointAfter(previous, { ...previous, checkpointSeq: 2, cumulativePlayedMs: 9 }))
    assert.throws(() => validateCheckpointAfter(previous, { ...previous, checkpointSeq: 2, cumulativeActiveMs: 8 }))
    assert.throws(() => validateCheckpointAfter(previous, { ...previous, checkpointSeq: 1 }))
    assert.throws(() => validateCheckpointAfter(previous, { ...previous, playbackGroupUuid: '223e4567-e89b-42d3-a456-426614174000', checkpointSeq: 2 }))
  })

  it('accepts only bounded integer checkpoint and resume fields', () => {
    assert.deepEqual(parsePlaybackCheckpoint(checkpoint({ durationMs: null, positionMs: MAX_MS })), checkpoint({ durationMs: null, positionMs: MAX_MS }))
    for (const value of [
      checkpoint({ checkpointSeq: -1 }),
      checkpoint({ cumulativePlayedMs: 1.5 }),
      checkpoint({ cumulativeActiveMs: Number.POSITIVE_INFINITY }),
      checkpoint({ durationMs: MAX_MS + 1 }),
      checkpoint({ positionMs: -1 }),
      checkpoint({ occurredAtMs: -1 }),
    ]) assert.throws(() => parsePlaybackCheckpoint(value))

    assert.throws(() => parsePlaybackResumeUpdate({
      version: 1,
      playbackGroupUuid: UUID,
      checkpointSeq: 1,
      track: { source: 'webdav', sourceTrackId: 'track' },
      listId: null,
      indexHint: null,
      positionMs: 0,
      durationMs: null,
      updatedAtMs: 1,
      extra: true,
    }))
  })

  it('enforces UTF-8 JSON byte caps and rejects non-JSON payload data', () => {
    assert.equal(Buffer.byteLength(JSON.stringify('浣'.repeat(5461)), 'utf8'), 16385)
    assert.throws(() => parsePlaybackEventDetails('浣'.repeat(5461)))
    assert.doesNotThrow(() => parsePlaybackEventDetails('浣'.repeat(5460)))
    assert.throws(() => parsePlaybackEventDetails({ nested: { value: undefined } }))
    assert.throws(() => parsePlaybackEventDetails({ nested: [Number.NaN] }))
    const cyclic = { nested: true }
    cyclic.self = cyclic
    assert.throws(() => parsePlaybackEventDetails(cyclic))
    assert.throws(() => parsePlaybackStartCommand(start({ track: track({ playablePayload: { id: 'x', meta: { blob: '浣'.repeat(43691) } } }) })))
  })

  it('removes expiring and private fields recursively but preserves WebDAV and local locators', () => {
    const input = {
      id: 'track',
      source: 'webdav',
      name: 'Name',
      singer: 'Singer',
      interval: null,
      meta: {
        songId: 'track',
        albumName: 'Album',
        path: 'music/a.flac',
        url: 'https://expired',
        cookie: 'SECRET',
        roomId: 'room',
        embeddedLyric: 'lyrics',
        artist: 'Artist',
        nested: { token: 'SECRET', stable: 'keep', playerState: { positionMs: 5 } },
      },
    }
    const result = sanitizePlayableTrack(input)
    assert.equal(result.meta.path, 'music/a.flac')
    assert.equal(result.meta.artist, 'Artist')
    assert.equal(JSON.stringify(result).includes('https://expired'), false)
    assert.equal(JSON.stringify(result).includes('SECRET'), false)
    assert.equal(JSON.stringify(result).includes('room'), false)
    assert.equal(JSON.stringify(result).includes('lyrics'), false)
    assert.equal(JSON.stringify(result).includes('positionMs'), false)
    input.meta.path = 'changed'
    assert.equal(result.meta.path, 'music/a.flac')

    const local = sanitizePlayableTrack({ id: 'local', source: 'local', name: 'Name', singer: 'Singer', interval: null, meta: { songId: 'local', albumName: 'Album', filePath: 'C:/music/a.flac' } })
    assert.equal(local.meta.filePath, 'C:/music/a.flac')
  })

  it('rejects hostile payload objects without leaking their contents', () => {
    const secret = 'DO_NOT_ECHO_PLAYABLE_SECRET'
    const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error(secret) } })
    const invalid = [undefined, 1n, getter, new Date(), { toJSON() { throw new Error(secret) } }]
    for (const value of invalid) {
      assert.throws(() => sanitizePlayableTrack(value), error => {
        assert.equal(error.message, 'Invalid playablePayload')
        assert.equal(error.message.includes(secret), false)
        return true
      })
    }
  })

  it('derives fixed consent modes and rejects malformed preplay failures', () => {
    assert.equal(getPlaybackStartMode({ recentAllowed: true, statsAllowed: true, privateMode: false }), 'activity')
    assert.equal(getPlaybackStartMode({ recentAllowed: false, statsAllowed: false, privateMode: false }), 'resume-only')
    assert.equal(getPlaybackStartMode({ recentAllowed: true, statsAllowed: true, privateMode: true }), 'private')
    assert.throws(() => getPlaybackStartMode({ recentAllowed: true, statsAllowed: 'yes', privateMode: false }))

    const failure = { ...start(), error: { version: 1, type: 'error', stage: 'load', code: null, recoverable: true, attempt: 0 } }
    const parsedFailure = parsePlaybackPreplayFailure(failure)
    assert.equal(parsedFailure.error.stage, 'load')
    assert.equal(JSON.stringify(parsedFailure).includes('expired.example'), false)
    assert.throws(() => parsePlaybackPreplayFailure({ ...failure, error: { version: 1, type: 'pause', reason: 'user' } }))
  })

  it('accepts only the documented commit alternatives', () => {
    const commit = { version: 1, checkpoint: checkpoint(), fact: { version: 1, type: 'skip', reason: 'next', automatic: true } }
    assert.deepEqual(parsePlaybackCommitRequest(commit), commit)
    assert.deepEqual(parsePlaybackCommitRequest({ version: 1, checkpoint: checkpoint(), boundary: { type: 'day_boundary', nextLocalDay: '2026-07-29', utcOffsetMinutes: 480 } }).boundary.type, 'day_boundary')
    assert.throws(() => parsePlaybackCommitRequest({ version: 1, checkpoint: checkpoint(), fact: { version: 1, type: 'play_end', reason: 'natural_end' }, boundary: { type: 'day_boundary', nextLocalDay: '2026-07-29', utcOffsetMinutes: 480 } }))
    assert.throws(() => parsePlaybackCommitRequest({ version: 1, checkpoint: checkpoint(), boundary: { type: 'day_boundary', nextLocalDay: 'not-a-day', utcOffsetMinutes: 480 } }))
  })
})
