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
  parseCatalogPreferences,
  parseLocalStateSnapshot,
  parseLocalStateUpdate,
  parsePlaylistMetadataCommand,
  parseSearchHistoryCommand,
} = require('../../src/common/storage/stateValidation.ts')

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
const makePreferences = overrides => ({
  version: 1,
  leaderboard: { source: 'kw', boardId: 'b' },
  songList: { source: 'kg', sortId: 's', tagId: '' },
  search: { temp_source: 'tx', source: 'all', type: 'music' },
  ...overrides,
})

describe('non-activity storage contracts', () => {
  it('accepts catalog preference enum values and ID length boundaries', () => {
    const preferences = makePreferences({
      leaderboard: { source: 'mg', boardId: 'x'.repeat(256) },
      songList: { source: 'wy', sortId: 'y'.repeat(256), tagId: '' },
      search: { temp_source: 'kg', source: 'kw', type: 'songlist' },
    })

    assert.deepEqual(parseCatalogPreferences(preferences), preferences)
    assert.doesNotThrow(() => parseCatalogPreferences(makePreferences({
      songList: { source: 'kw', sortId: 's', tagId: 'z'.repeat(256) },
    })))
  })

  it('rejects invalid catalog preference enums, IDs, and extra properties', () => {
    assert.throws(() => parseCatalogPreferences(makePreferences({ leaderboard: { source: 'bd', boardId: 'b' } })))
    assert.throws(() => parseCatalogPreferences(makePreferences({ leaderboard: { source: 'kw', boardId: '' } })))
    assert.throws(() => parseCatalogPreferences(makePreferences({ songList: { source: 'kw', sortId: '', tagId: '' } })))
    assert.throws(() => parseCatalogPreferences(makePreferences({ songList: { source: 'kw', sortId: 's', tagId: 'x'.repeat(257) } })))
    assert.throws(() => parseCatalogPreferences(makePreferences({ search: { temp_source: 'kw', source: 'all', type: 'album' } })))
    assert.throws(() => parseCatalogPreferences({ ...makePreferences(), extra: true }))
    assert.throws(() => parseCatalogPreferences(makePreferences({ leaderboard: { source: 'kw', boardId: 'b', extra: true } })))
  })

  it('accepts local-state snapshot URL, query, scroll-map, and ID boundaries', () => {
    const snapshot = {
      version: 1,
      viewPrevState: { url: 'u'.repeat(4096), query: { q: 'x'.repeat(32760) } },
      listScrollPosition: Object.fromEntries(Array.from({ length: 10000 }, (_, index) => [`id${index}`, index])),
      listPrevSelectId: 'i'.repeat(256),
    }

    assert.equal(Buffer.byteLength(JSON.stringify(snapshot.viewPrevState.query), 'utf8'), 32768)
    assert.deepEqual(parseLocalStateSnapshot(snapshot), snapshot)
  })

  it('rejects malformed local-state snapshots and extra properties', () => {
    const base = {
      version: 1,
      viewPrevState: { url: '/search', query: {} },
      listScrollPosition: {},
      listPrevSelectId: 'default',
    }
    assert.throws(() => parseLocalStateSnapshot({ ...base, version: 2 }))
    assert.throws(() => parseLocalStateSnapshot({ ...base, listPrevSelectId: '' }))
    assert.throws(() => parseLocalStateSnapshot({ ...base, viewPrevState: { url: '', query: {} } }))
    assert.throws(() => parseLocalStateSnapshot({ ...base, viewPrevState: { url: '/search', query: {}, extra: true } }))
    assert.throws(() => parseLocalStateSnapshot({ ...base, listScrollPosition: { id: -1 } }))
    assert.throws(() => parseLocalStateSnapshot({ ...base, listScrollPosition: { id: Number.POSITIVE_INFINITY } }))
    assert.throws(() => parseLocalStateSnapshot({ ...base, listScrollPosition: Object.fromEntries(Array.from({ length: 10001 }, (_, index) => [`id${index}`, 0])) }))
    assert.throws(() => parseLocalStateSnapshot({ ...base, extra: true }))
  })

  it('accepts only the three registered local-state keys', () => {
    assert.equal(parseLocalStateUpdate({
      version: 1,
      key: 'view_prev_state',
      value: { url: '/search', query: {} },
      updatedAtMs: 0,
    }).key, 'view_prev_state')
    assert.equal(parseLocalStateUpdate({
      version: 1,
      key: 'list_scroll_positions',
      value: { default: 0 },
      updatedAtMs: MAX_SAFE_INTEGER,
    }).key, 'list_scroll_positions')
    assert.equal(parseLocalStateUpdate({
      version: 1,
      key: 'list_prev_select_id',
      value: 'default',
      updatedAtMs: 1,
    }).key, 'list_prev_select_id')
    assert.throws(() => parseLocalStateUpdate({ version: 1, key: 'arbitrary', value: {}, updatedAtMs: 1 }))
  })

  it('enforces local-state update payload and timestamp boundaries', () => {
    assert.throws(() => parseLocalStateUpdate({
      version: 1,
      key: 'view_prev_state',
      value: { url: '/search', query: { q: 'x'.repeat(32761) } },
      updatedAtMs: 1,
    }))
    assert.throws(() => parseLocalStateUpdate({ version: 1, key: 'list_prev_select_id', value: 'x'.repeat(257), updatedAtMs: 1 }))
    assert.throws(() => parseLocalStateUpdate({ version: 1, key: 'list_prev_select_id', value: 'default', updatedAtMs: -1 }))
    assert.throws(() => parseLocalStateUpdate({ version: 1, key: 'list_prev_select_id', value: 'default', updatedAtMs: MAX_SAFE_INTEGER + 1 }))
    assert.throws(() => parseLocalStateUpdate({ version: 1, key: 'list_prev_select_id', value: 'default', updatedAtMs: 1, extra: true }))
  })

  it('accepts all playlist metadata commands at their boundaries', () => {
    const profile = { description: 'x'.repeat(32750) }
    assert.equal(Buffer.byteLength(JSON.stringify(profile), 'utf8'), 32768)
    assert.deepEqual(parsePlaylistMetadataCommand({
      version: 1,
      action: 'upsert',
      playlistId: 'p'.repeat(256),
      value: { updateTime: MAX_SAFE_INTEGER, isAutoUpdate: true, profile },
      updatedAtMs: 0,
    }).value.profile, profile)
    assert.equal(parsePlaylistMetadataCommand({ version: 1, action: 'remove', playlistId: 'p' }).action, 'remove')
    assert.equal(parsePlaylistMetadataCommand({
      version: 1,
      action: 'retain',
      playlistIds: Array.from({ length: 10000 }, () => 'p'),
    }).playlistIds.length, 10000)
  })

  it('enforces playlist metadata ID, profile, integer, and retain limits', () => {
    const upsert = {
      version: 1,
      action: 'upsert',
      playlistId: 'p',
      value: { updateTime: 0, isAutoUpdate: false },
      updatedAtMs: 0,
    }
    assert.throws(() => parsePlaylistMetadataCommand({ ...upsert, playlistId: '' }))
    assert.throws(() => parsePlaylistMetadataCommand({ ...upsert, updatedAtMs: 1.5 }))
    assert.throws(() => parsePlaylistMetadataCommand({ ...upsert, value: { updateTime: -1, isAutoUpdate: false } }))
    assert.throws(() => parsePlaylistMetadataCommand({ ...upsert, value: { updateTime: 0, isAutoUpdate: 'yes' } }))
    assert.throws(() => parsePlaylistMetadataCommand({ ...upsert, value: { updateTime: 0, isAutoUpdate: false, profile: { createdAt: MAX_SAFE_INTEGER + 1 } } }))
    assert.throws(() => parsePlaylistMetadataCommand({ ...upsert, value: { updateTime: 0, isAutoUpdate: false, profile: { coverUrl: 'u'.repeat(4097) } } }))
    assert.throws(() => parsePlaylistMetadataCommand({ ...upsert, value: { updateTime: 0, isAutoUpdate: false, profile: { description: 'x'.repeat(32751) } } }))
    assert.throws(() => parsePlaylistMetadataCommand({ ...upsert, value: { updateTime: 0, isAutoUpdate: false, extra: true } }))
    assert.throws(() => parsePlaylistMetadataCommand({ version: 1, action: 'remove', playlistId: 'p', extra: true }))
    assert.throws(() => parsePlaylistMetadataCommand({ version: 1, action: 'retain', playlistIds: [''] }))
    assert.throws(() => parsePlaylistMetadataCommand({
      version: 1,
      action: 'retain',
      playlistIds: Array.from({ length: 10001 }, (_, index) => String(index)),
    }))
  })

  it('accepts search history commands at term and timestamp boundaries', () => {
    assert.equal(parseSearchHistoryCommand({ version: 1, action: 'record', term: 'x'.repeat(200), usedAtMs: MAX_SAFE_INTEGER }).term.length, 200)
    assert.equal(parseSearchHistoryCommand({ version: 1, action: 'remove', term: 'x' }).action, 'remove')
    assert.equal(parseSearchHistoryCommand({ version: 1, action: 'clear' }).action, 'clear')
  })

  it('rejects invalid search history payloads and extra properties', () => {
    assert.throws(() => parseSearchHistoryCommand({ version: 1, action: 'record', term: '', usedAtMs: 1 }))
    assert.throws(() => parseSearchHistoryCommand({ version: 1, action: 'record', term: 'x'.repeat(201), usedAtMs: 1 }))
    assert.throws(() => parseSearchHistoryCommand({ version: 1, action: 'record', term: 'x', usedAtMs: -1 }))
    assert.throws(() => parseSearchHistoryCommand({ version: 1, action: 'remove', term: 'x', usedAtMs: 1 }))
    assert.throws(() => parseSearchHistoryCommand({ version: 1, action: 'clear', extra: true }))
    assert.throws(() => parseSearchHistoryCommand({ version: 1, action: 'unknown' }))
  })

  it('reports field names without echoing rejected input values', () => {
    const secret = 'never-log-this-secret'
    assert.throws(
      () => parseSearchHistoryCommand({ version: 1, action: 'record', term: secret.repeat(20), usedAtMs: 1 }),
      error => error.message == 'Invalid term' && !error.message.includes(secret),
    )
    assert.throws(
      () => parseLocalStateUpdate({ version: 1, key: secret, value: {}, updatedAtMs: 1 }),
      error => error.message == 'Invalid key' && !error.message.includes(secret),
    )
  })
})
