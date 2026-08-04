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
  parsePlaybackCheckpointAck,
  parsePlaybackCommitRequest,
  parsePlaybackEventDetails,
  parsePlaybackFact,
  parsePlaybackPreplayFailure,
  parsePlaybackRecorderCommand,
  parsePlaybackResume,
  parsePlaybackResumeAck,
  parsePlaybackResumeUpdate,
  parsePlaybackStartResult,
  parsePlaybackStartCommand,
  parseRecentTrack,
  parseListeningStats,
  sanitizePlayableTrack,
  validateCheckpointAfter,
} = require('../../src/common/storage/playbackValidation.ts')

const UUID = '123e4567-e89b-42d3-a456-426614174000'
const MAX_MS = 7 * 24 * 60 * 60 * 1000
const MAX_SOURCE_BYTES = 1024
const MAX_IDENTITY_BYTES = 16 * 1024
const MAX_DISPLAY_BYTES = 4 * 1024

const exactFourByteUtf8 = bytes => '\u{1f642}'.repeat(bytes / 4)

const webdavPayload = (overrides = {}) => ({
  id: 'track',
  source: 'webdav',
  name: 'Name',
  singer: 'Singer',
  interval: '02:00',
  meta: {
    songId: 'track',
    albumName: 'Album',
    path: 'music/a.flac',
    url: 'https://dav.example/music/',
    fileName: 'a.flac',
    ext: 'flac',
  },
  ...overrides,
})

const localPayload = (overrides = {}) => ({
  id: 'C:/music/a.flac',
  source: 'local',
  name: 'Name',
  singer: 'Singer',
  interval: null,
  meta: { songId: 'C:/music/a.flac', albumName: '', filePath: 'C:/music/a.flac', ext: 'flac' },
  ...overrides,
})

const onlinePayload = (source, meta = {}) => ({
  id: `${source}_track`,
  source,
  name: '',
  singer: '',
  interval: null,
  meta: { songId: 'track', albumName: '', qualitys: [], _qualitys: {}, ...meta },
})

const track = (overrides = {}) => ({
  source: 'webdav',
  sourceTrackId: 'track',
  name: 'Name',
  singer: 'Singer',
  durationMs: 120000,
  playablePayload: webdavPayload(),
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

  it('bounds every persisted playback scalar by UTF-8 bytes across all DTO families', () => {
    const sourceAscii = 's'.repeat(MAX_SOURCE_BYTES)
    const sourceUtf8 = exactFourByteUtf8(MAX_SOURCE_BYTES)
    const identityAscii = 'i'.repeat(MAX_IDENTITY_BYTES)
    const identityUtf8 = exactFourByteUtf8(MAX_IDENTITY_BYTES)
    const displayAscii = 'd'.repeat(MAX_DISPLAY_BYTES)
    const displayUtf8 = exactFourByteUtf8(MAX_DISPLAY_BYTES)
    for (const [value, expectedBytes] of [
      [sourceAscii, MAX_SOURCE_BYTES],
      [sourceUtf8, MAX_SOURCE_BYTES],
      [identityAscii, MAX_IDENTITY_BYTES],
      [identityUtf8, MAX_IDENTITY_BYTES],
      [displayAscii, MAX_DISPLAY_BYTES],
      [displayUtf8, MAX_DISPLAY_BYTES],
    ]) assert.equal(Buffer.byteLength(value, 'utf8'), expectedBytes)

    const boundedTrack = track({
      source: sourceAscii,
      sourceTrackId: identityUtf8,
      name: displayAscii,
      singer: displayUtf8,
      playablePayload: null,
    })
    const boundedStart = start({
      track: boundedTrack,
      resume: { listId: identityAscii, indexHint: null },
    })
    const boundedResumeUpdate = {
      version: 1,
      playbackGroupUuid: UUID,
      checkpointSeq: 1,
      track: { source: sourceUtf8, sourceTrackId: identityAscii },
      listId: identityUtf8,
      indexHint: null,
      positionMs: 0,
      durationMs: null,
      updatedAtMs: 1,
    }
    const boundedResume = {
      version: 1,
      source: sourceAscii,
      sourceTrackId: identityUtf8,
      listId: identityAscii,
      indexHint: null,
      positionMs: 0,
      durationMs: null,
      updatedAtMs: 1,
    }
    const boundedRecent = {
      version: 1,
      ...boundedTrack,
      lastPlayedAtMs: 1,
      legacyRank: null,
    }
    const boundedStats = {
      version: 1,
      total: { baselinePlayedMs: 0, livePlayedMs: 0, baselineActiveMs: 0, liveActiveMs: 0, playedMs: 0, activeMs: 0 },
      daily: [],
      tracks: [{
        baselinePlayedMs: 0,
        livePlayedMs: 0,
        baselineActiveMs: 0,
        liveActiveMs: 0,
        playedMs: 0,
        activeMs: 0,
        source: sourceUtf8,
        sourceTrackId: identityAscii,
        name: displayUtf8,
        singer: displayAscii,
        durationMs: null,
      }],
      updatedAtMs: 1,
    }
    const boundedFailure = {
      ...boundedStart,
      error: { version: 1, type: 'error', stage: 'url', code: null, recoverable: false, attempt: 0 },
    }

    for (const [parse, value] of [
      [parsePlaybackStartCommand, boundedStart],
      [parsePlaybackPreplayFailure, boundedFailure],
      [parsePlaybackResumeUpdate, boundedResumeUpdate],
      [parsePlaybackResume, boundedResume],
      [parseRecentTrack, boundedRecent],
      [parseListeningStats, boundedStats],
    ]) assert.deepEqual(parse(value), value)

    const oversizedSourceAscii = `${sourceAscii}x`
    const oversizedSourceUtf8 = `${sourceUtf8}x`
    const oversizedIdentityAscii = `${identityAscii}x`
    const oversizedIdentityUtf8 = `${identityUtf8}x`
    const oversizedDisplayAscii = `${displayAscii}x`
    const oversizedDisplayUtf8 = `${displayUtf8}x`
    for (const [value, expectedBytes] of [
      [oversizedSourceAscii, MAX_SOURCE_BYTES + 1],
      [oversizedSourceUtf8, MAX_SOURCE_BYTES + 1],
      [oversizedIdentityAscii, MAX_IDENTITY_BYTES + 1],
      [oversizedIdentityUtf8, MAX_IDENTITY_BYTES + 1],
      [oversizedDisplayAscii, MAX_DISPLAY_BYTES + 1],
      [oversizedDisplayUtf8, MAX_DISPLAY_BYTES + 1],
    ]) assert.equal(Buffer.byteLength(value, 'utf8'), expectedBytes)

    const rejected = [
      () => parsePlaybackStartCommand(start({ track: track({ source: oversizedSourceAscii, playablePayload: null }) })),
      () => parsePlaybackPreplayFailure({
        ...start({ track: track({ sourceTrackId: oversizedIdentityUtf8, playablePayload: null }) }),
        error: { version: 1, type: 'error', stage: 'url', code: null, recoverable: false, attempt: 0 },
      }),
      () => parsePlaybackResumeUpdate({ ...boundedResumeUpdate, listId: oversizedIdentityAscii }),
      () => parsePlaybackResume({ ...boundedResume, source: oversizedSourceUtf8 }),
      () => parseRecentTrack({ ...boundedRecent, name: oversizedDisplayAscii }),
      () => parseListeningStats({
        ...boundedStats,
        tracks: [{ ...boundedStats.tracks[0], singer: oversizedDisplayUtf8 }],
      }),
    ]
    for (const parse of rejected) assert.throws(parse)
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
      { version: 1, type: 'pause', reason: 'device' },
      { version: 1, type: 'seek', origin: 'buffer_recovery', fromMs: 0, toMs: MAX_MS },
      { version: 1, type: 'skip', reason: 'queue_removed', automatic: true },
      { version: 1, type: 'play_end', reason: 'natural_end' },
      { version: 1, type: 'error', stage: 'unknown', code: null, recoverable: false, attempt: 0 },
    ]
    for (const fact of valid) assert.deepEqual(parsePlaybackFact(fact), fact)

    const invalid = [
      { version: 1, type: 'play_start', reason: 'user' },
      { version: 1, type: 'pause', reason: 'auto' },
      { version: 1, type: 'pause', reason: 'system' },
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

  it('removes expiring and private fields recursively but preserves canonical WebDAV and local locators', () => {
    const input = webdavPayload({
      meta: {
        songId: 'track',
        albumName: 'Album',
        path: 'music/a.flac',
        url: 'https://dav.example/music/',
        fileName: 'a.flac',
        ext: 'flac',
        cookie: 'SECRET',
        roomId: 'room',
        embeddedLyric: 'lyrics',
        artist: 'Artist',
        nested: { token: 'SECRET', stable: 'keep', playerState: { positionMs: 5 } },
      },
    })
    const result = sanitizePlayableTrack(input)
    assert.equal(result.meta.path, 'music/a.flac')
    assert.equal(result.meta.url, 'https://dav.example/music/')
    assert.equal(result.meta.artist, 'Artist')
    assert.equal(JSON.stringify(result).includes('SECRET'), false)
    assert.equal(JSON.stringify(result).includes('room'), false)
    assert.equal(JSON.stringify(result).includes('lyrics'), false)
    assert.equal(JSON.stringify(result).includes('positionMs'), false)
    input.meta.path = 'changed'
    assert.equal(result.meta.path, 'music/a.flac')

    const local = sanitizePlayableTrack(localPayload())
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

  it('requires actual local and WebDAV locator variants while retaining only a canonical WebDAV root', () => {
    assert.throws(() => sanitizePlayableTrack(localPayload({ meta: { songId: 'x', albumName: '', ext: 'flac' } })))
    assert.throws(() => sanitizePlayableTrack(webdavPayload({ meta: { songId: 'x', albumName: '', path: 'a.flac', fileName: 'a.flac', ext: 'flac' } })))
    assert.throws(() => sanitizePlayableTrack(webdavPayload({ meta: { songId: 'x', albumName: '', path: '../a.flac', url: 'https://dav.example/music/', fileName: 'a.flac', ext: 'flac' } })))
    assert.throws(() => sanitizePlayableTrack(webdavPayload({ meta: { songId: 'x', albumName: '', path: 'a.flac', url: 'https://user:SECRET@dav.example/music/', fileName: 'a.flac', ext: 'flac' } })))
    const queryRoot = webdavPayload({ meta: { songId: 'x', albumName: '', path: 'a.flac', url: 'https://dav.example/music/?token=SECRET', fileName: 'a.flac', ext: 'flac' } })
    assert.throws(() => sanitizePlayableTrack(queryRoot))
    assert.equal(queryRoot.meta.url, 'https://dav.example/music/?token=SECRET')
    assert.throws(() => sanitizePlayableTrack(webdavPayload({ meta: { songId: 'x', albumName: '', path: 'a.flac', url: 'https://dav.example/music/#fragment', fileName: 'a.flac', ext: 'flac' } })))
  })

  it('accepts every documented online MusicInfo discriminant and removes provider URLs', () => {
    const valid = [
      onlinePayload('kw'),
      onlinePayload('wy'),
      onlinePayload('kg', { hash: 'hash' }),
      onlinePayload('tx', { strMediaMid: 'media' }),
      onlinePayload('mg', { copyrightId: 'copyright' }),
    ]
    for (const value of valid) {
      value.meta.picUrl = 'https://provider.example/expired'
      assert.equal(JSON.stringify(sanitizePlayableTrack(value)).includes('provider.example'), false)
    }
    assert.throws(() => sanitizePlayableTrack(onlinePayload('kg')))
    assert.throws(() => sanitizePlayableTrack(onlinePayload('tx')))
    assert.throws(() => sanitizePlayableTrack(onlinePayload('mg')))
    assert.throws(() => sanitizePlayableTrack(onlinePayload('unsupported')))
  })

  it('projects only declared durable MusicInfo fields and validates exact quality values', () => {
    const local = sanitizePlayableTrack(localPayload({
      meta: {
        songId: 'local',
        albumName: 'Album',
        filePath: 'C:/music/a.flac',
        ext: 'flac',
        recommendTag: 'tag',
        apiKey: 'SECRET',
        secret: 'SECRET',
        sessionSecret: 'SECRET',
        nested: { apiKey: 'SECRET' },
      },
    }))
    assert.deepEqual(local.meta, { songId: 'local', albumName: 'Album', filePath: 'C:/music/a.flac', ext: 'flac', recommendTag: 'tag' })

    const webdav = sanitizePlayableTrack(webdavPayload({
      meta: {
        songId: 'remote',
        albumName: 'Album',
        url: 'https://dav.example/music/',
        path: 'music/a.flac',
        fileName: 'a.flac',
        ext: 'flac',
        title: 'Title',
        artist: 'Artist',
        album: null,
        albumArtist: null,
        year: 2026,
        genre: ['Rock'],
        hasEmbeddedPic: true,
        size: 1,
        etag: 'etag',
        lastModified: 'date',
        picPath: 'covers/a.jpg',
        apiKey: 'SECRET',
        secret: 'SECRET',
        sessionSecret: 'SECRET',
        nested: { secret: 'SECRET' },
      },
    }))
    assert.deepEqual(webdav.meta, {
      songId: 'remote',
      albumName: 'Album',
      url: 'https://dav.example/music/',
      path: 'music/a.flac',
      fileName: 'a.flac',
      ext: 'flac',
      title: 'Title',
      artist: 'Artist',
      album: null,
      albumArtist: null,
      year: 2026,
      genre: ['Rock'],
      hasEmbeddedPic: true,
      size: 1,
      etag: 'etag',
      lastModified: 'date',
      picPath: 'covers/a.jpg',
    })
    assert.equal(JSON.stringify(webdav).includes('SECRET'), false)

    const variants = [
      onlinePayload('kw', { albumId: 1, qualitys: [{ type: '128k', size: null }], _qualitys: { '128k': { size: null } } }),
      onlinePayload('wy', { albumId: 'album', qualitys: [{ type: '320k', size: '1M' }], _qualitys: { '320k': { size: '1M' } } }),
      onlinePayload('kg', { hash: 'hash', qualitys: [{ type: 'flac', size: null, hash: 'h' }], _qualitys: { flac: { size: null, hash: 'h' } } }),
      onlinePayload('tx', { strMediaMid: 'media', id: 1, albumMid: 'album', songType: 1 }),
      onlinePayload('mg', { copyrightId: 'copyright' }),
    ]
    for (const variant of variants) {
      variant.meta.apiKey = 'SECRET'
      variant.meta.secret = 'SECRET'
      variant.meta.sessionSecret = 'SECRET'
      assert.equal(JSON.stringify(sanitizePlayableTrack(variant)).includes('SECRET'), false)
    }
    assert.throws(() => sanitizePlayableTrack(onlinePayload('kw', { qualitys: [{ type: 'invalid', size: null }] })))
    assert.throws(() => sanitizePlayableTrack(onlinePayload('kg', { hash: 'hash', qualitys: [{ type: 'flac', size: null, hash: 'h', extra: true }] })))
    assert.throws(() => sanitizePlayableTrack(onlinePayload('wy', { _qualitys: { bad: { size: null } } })))
  })

  it('enforces declared WebDAV optional nullability and isolates genre arrays', () => {
    const meta = {
      songId: 'remote',
      albumName: 'Album',
      url: 'https://dav.example/music/',
      path: 'music/a.flac',
      fileName: 'a.flac',
      ext: 'flac',
      title: null,
      artist: null,
      album: null,
      albumArtist: null,
      year: null,
      genre: ['Rock'],
      picPath: null,
      hasEmbeddedPic: false,
      size: 1,
      etag: 'etag',
      lastModified: 'date',
    }
    const result = sanitizePlayableTrack(webdavPayload({ meta }))
    meta.genre[0] = 'Changed'
    meta.genre.push('Injected')
    assert.deepEqual(result.meta.genre, ['Rock'])
    for (const key of ['size', 'etag', 'lastModified']) {
      assert.throws(() => sanitizePlayableTrack(webdavPayload({ meta: { ...meta, [key]: null } })))
    }
    assert.doesNotThrow(() => sanitizePlayableTrack(webdavPayload({
      meta: {
        ...meta,
        title: null,
        artist: null,
        album: null,
        albumArtist: null,
        year: null,
        genre: null,
        picPath: null,
      },
    })))
  })

  it('rejects forged and reused fixed-error messages from proxy traps', () => {
    const forged = 'Invalid secret'
    const fakeError = { message: forged }
    const object = new Proxy(start(), { get() { throw new Error(forged) } })
    const plainObject = new Proxy(start(), { get() { throw fakeError } })
    const proxy = new Proxy(webdavPayload(), { ownKeys() { throw new Error(forged) } })
    for (const [parse, field] of [
      [() => parsePlaybackStartCommand(object), 'start'],
      [() => parsePlaybackStartCommand(plainObject), 'start'],
      [() => sanitizePlayableTrack(proxy), 'playablePayload'],
    ]) assert.throws(parse, error => error.message == `Invalid ${field}` && error.message != forged)

    let escapedError
    try {
      parsePlaybackFact({ version: 1, type: 'skip', reason: 'auto', automatic: true })
    } catch (error) {
      escapedError = error
    }
    assert.ok(escapedError instanceof Error)
    assert.match(escapedError.message, /^Invalid [A-Za-z.]+$/)
    const sentinel = 'REUSED_VALIDATION_ERROR_SENTINEL'
    try {
      escapedError.message = sentinel
    } catch {}
    assert.equal(Object.isFrozen(escapedError), true)
    assert.match(escapedError.message, /^Invalid [A-Za-z.]+$/)
    assert.equal(escapedError.message.includes(sentinel), false)

    for (const [parse, field] of [
      [() => parsePlaybackFact(new Proxy({ version: 1, type: 'pause', reason: 'user' }, { ownKeys() { throw escapedError } })), 'fact'],
      [() => parsePlaybackStartCommand(new Proxy(start(), { ownKeys() { throw escapedError } })), 'start'],
    ]) {
      assert.throws(parse, error => error !== escapedError && error.message == `Invalid ${field}` && !error.message.includes(sentinel))
    }
  })

  it('normalizes proxy failures from public boundaries without leaking sentinels', () => {
    const secret = 'PROXY_SENTINEL_MUST_NOT_LEAK'
    const throwingObject = new Proxy(start(), { get() { throw new Error(secret) } })
    const throwingPayload = new Proxy(webdavPayload(), { ownKeys() { throw new Error(secret) } })
    const throwingArray = new Proxy([], { getOwnPropertyDescriptor() { throw new Error(secret) } })
    const cases = [
      [() => parsePlaybackStartCommand(throwingObject), 'start'],
      [() => sanitizePlayableTrack(throwingPayload), 'playablePayload'],
      [() => parsePlaybackEventDetails(throwingArray), 'details'],
      [() => parseListeningStats(new Proxy({ version: 1, total: {}, daily: [], tracks: [], updatedAtMs: 0 }, { ownKeys() { throw new Error(secret) } })), 'listeningStats'],
    ]
    for (const [parse, field] of cases) {
      assert.throws(parse, error => error.message == `Invalid ${field}` && !error.message.includes(secret))
    }
  })

  it('accepts empty DTO strings except capped context and does not execute accessor values', () => {
    const command = start({
      track: track({ source: '', sourceTrackId: '', name: '', singer: '' }),
      context: { type: '', id: '' },
      resume: { listId: '', indexHint: null },
    })
    assert.equal(parsePlaybackStartCommand(command).context.type, '')
    const secret = 'ACCESSOR_SECRET_MUST_NOT_LEAK'
    const getter = Object.defineProperty(start(), 'version', { enumerable: true, get() { throw new Error(secret) } })
    assert.throws(() => parsePlaybackStartCommand(getter), error => error.message == 'Invalid start' && !error.message.includes(secret))
    const array = []
    Object.defineProperty(array, 0, { enumerable: true, get() { throw new Error(secret) } })
    assert.throws(() => parsePlaybackEventDetails(array), error => error.message == 'Invalid details' && !error.message.includes(secret))
    const stats = {
      version: 1,
      total: { baselinePlayedMs: 0, livePlayedMs: 0, baselineActiveMs: 0, liveActiveMs: 0, playedMs: 0, activeMs: 0 },
      daily: [],
      tracks: [],
      updatedAtMs: 0,
    }
    Object.defineProperty(stats.daily, 0, { enumerable: true, get() { throw new Error(secret) } })
    assert.throws(() => parseListeningStats(stats), error => error.message == 'Invalid daily' && !error.message.includes(secret))
  })

  it('validates and clones every acknowledgement, result, recorder, recent, statistics, and resume parser', () => {
    const checkpointAck = { playbackGroupUuid: UUID, sessionUuid: UUID, segmentNo: 0, checkpointSeq: 1, cumulativePlayedMs: 1, cumulativeActiveMs: 1 }
    const resumeAck = { playbackGroupUuid: UUID, checkpointSeq: 1, positionMs: 0 }
    assert.deepEqual(parsePlaybackCheckpointAck(checkpointAck), checkpointAck)
    assert.deepEqual(parsePlaybackResumeAck(resumeAck), resumeAck)
    assert.deepEqual(parsePlaybackStartResult({ mode: 'activity', ack: checkpointAck }), { mode: 'activity', ack: checkpointAck })
    assert.deepEqual(parsePlaybackStartResult({ mode: 'resume-only', ack: resumeAck }), { mode: 'resume-only', ack: resumeAck })
    assert.deepEqual(parsePlaybackStartResult({ mode: 'private', playbackGroupUuid: UUID, checkpointSeq: 0 }), { mode: 'private', playbackGroupUuid: UUID, checkpointSeq: 0 })
    assert.deepEqual(parsePlaybackRecorderCommand({ kind: 'start', request: start() }).kind, 'start')
    assert.deepEqual(parsePlaybackRecorderCommand({ kind: 'commit', request: { version: 1, checkpoint: checkpoint() } }).kind, 'commit')
    assert.deepEqual(parsePlaybackRecorderCommand({ kind: 'resume', request: { version: 1, playbackGroupUuid: UUID, checkpointSeq: 0, track: { source: '', sourceTrackId: '' }, listId: '', indexHint: null, positionMs: 0, durationMs: null, updatedAtMs: 0 } }).kind, 'resume')
    assert.deepEqual(parsePlaybackRecorderCommand({ kind: 'preplay_failure', request: { ...start(), error: { version: 1, type: 'error', stage: 'url', code: null, recoverable: true, attempt: 0 } } }).kind, 'preplay_failure')

    const recent = { version: 1, ...track({ playablePayload: localPayload() }), lastPlayedAtMs: null, legacyRank: null }
    const parsedRecent = parseRecentTrack(recent)
    assert.deepEqual(parsedRecent, recent)
    assert.notStrictEqual(parsedRecent.playablePayload, recent.playablePayload)
    const stats = {
      version: 1,
      total: { baselinePlayedMs: 0, livePlayedMs: 0, baselineActiveMs: 0, liveActiveMs: 0, playedMs: 0, activeMs: 0 },
      daily: [{ baselinePlayedMs: 0, livePlayedMs: 0, baselineActiveMs: 0, liveActiveMs: 0, playedMs: 0, activeMs: 0, localDay: '2026-07-29' }],
      tracks: [{ baselinePlayedMs: 0, livePlayedMs: 0, baselineActiveMs: 0, liveActiveMs: 0, playedMs: 0, activeMs: 0, source: '', sourceTrackId: '', name: '', singer: '', durationMs: null }],
      updatedAtMs: 0,
    }
    assert.deepEqual(parseListeningStats(stats), stats)
    const resume = { version: 1, source: '', sourceTrackId: '', listId: '', indexHint: null, positionMs: 0, durationMs: null, updatedAtMs: 0 }
    assert.deepEqual(parsePlaybackResume(resume), resume)

    for (const value of [
      { ...checkpointAck, sessionUuid: 'not-a-uuid' },
      { ...resumeAck, positionMs: MAX_MS + 1 },
      { mode: 'activity', ack: { ...checkpointAck, extra: true } },
      { kind: 'unknown', request: {} },
      { ...recent, legacyRank: -1 },
      { ...stats, tracks: [{ ...stats.tracks[0], durationMs: MAX_MS + 1 }] },
      { ...resume, indexHint: -1 },
    ]) {
      assert.throws(() => {
        if ('sessionUuid' in value) parsePlaybackCheckpointAck(value)
        else if ('positionMs' in value && 'playbackGroupUuid' in value) parsePlaybackResumeAck(value)
        else if ('mode' in value) parsePlaybackStartResult(value)
        else if ('kind' in value) parsePlaybackRecorderCommand(value)
        else if ('legacyRank' in value) parseRecentTrack(value)
        else if ('tracks' in value) parseListeningStats(value)
        else parsePlaybackResume(value)
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
