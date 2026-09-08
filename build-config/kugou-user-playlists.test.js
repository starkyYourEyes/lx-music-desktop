/* eslint-disable n/no-deprecated-api */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const typescript = require('typescript')

const root = path.resolve(__dirname, '..')
const previousLoader = require.extensions['.ts']
const previousNativeRequire = global.__non_webpack_require__
require.extensions['.ts'] = (mod, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText
  mod._compile(output, filename)
}
global.__non_webpack_require__ = require
const { createKugouApiClient } = require(path.join(root, 'src/main/modules/kugouMusic/api.ts'))
const { KugouAuthError } = require(path.join(root, 'src/main/modules/kugouMusic/recommend.ts'))
const { createKugouUserPlaylistService } = require(path.join(root, 'src/main/modules/kugouMusic/userPlaylists.ts'))
require.extensions['.ts'] = previousLoader
if (previousNativeRequire == null) delete global.__non_webpack_require__
else global.__non_webpack_require__ = previousNativeRequire

const response = (info, extra = {}) => ({ status: 200, body: { status: 1, error_code: 0, data: { info, ...extra } } })
const playlist = (id, extra = {}) => ({ listid: id, global_collection_id: `collection_${id}`, list_create_userid: 'fixture-owner', name: `Playlist ${id}`, ...extra })
const fixture = (userPlaylist, extra = {}) => createKugouUserPlaylistService({
  api: { userPlaylist },
  getCookie: () => 'token=fixture-credential',
  getProfile: () => ({ userId: 'fixture-owner', nickname: 'Fixture' }),
  ...extra,
})

test('uses the pinned SDK authenticated playlist endpoint and injected transport', async() => {
  let request
  const api = createKugouApiClient(undefined, {
    request: async options => {
      request = options
      return response([])
    },
  })
  await api.userPlaylist({ cookie: 'token=fixture-credential;userid=123', page: 2, pagesize: 100 })
  assert.equal(request.url, '/v7/get_all_list')
  assert.equal(request.headers['x-router'], 'cloudlist.service.kugou.com')
  assert.equal(request.encryptType, 'android')
  assert.equal(request.method.toLowerCase(), 'post')
  assert.equal(request.data.token, 'fixture-credential')
  assert.equal(request.data.userid, '123')
  assert.equal(request.data.page, 2)
  assert.equal(request.data.pagesize, 100)
  assert.equal(typeof request.cookie.KUGOU_API_MID, 'string')
})

test('normalizes created and collected cloud playlists to existing Kugou detail links', async() => {
  const service = fixture(async params => {
    assert.equal(params.cookie, 'token=fixture-credential')
    assert.equal(params.userid, 'fixture-owner')
    return response([
      playlist('own', { pic: 'https://img.example/{size}/cover.jpg' }),
      playlist('saved', { list_create_userid: 'another-owner', list_create_gid: 'collection_original' }),
      playlist('album', { list_create_userid: 'another-owner', authors: [{ name: 'Artist' }] }),
      { specialid: 456, list_create_userid: 'fixture-owner', name: 'Public special' },
      { global_collection_id: 'collection_favorites', type: 0, name: 'Favorites' },
    ])
  })
  assert.deepEqual(await service.getUserPlaylists(), [
    { provider: 'kugou', kind: 'created', id: 'collection_own', sourceListId: 'https://www.kugou.com/songlist/?global_collection_id=collection_own', name: 'Playlist own', coverUrl: 'https://img.example/240/cover.jpg', accountKey: 'fixture-owner' },
    { provider: 'kugou', kind: 'collected', id: 'collection_original', sourceListId: 'https://www.kugou.com/songlist/?global_collection_id=collection_original', name: 'Playlist saved', coverUrl: '', accountKey: 'fixture-owner' },
    { provider: 'kugou', kind: 'created', id: 'id_456', sourceListId: 'id_456', name: 'Public special', coverUrl: '', accountKey: 'fixture-owner' },
    { provider: 'kugou', kind: 'created', id: 'collection_favorites', sourceListId: 'https://www.kugou.com/songlist/?global_collection_id=collection_favorites', name: 'Favorites', coverUrl: '', accountKey: 'fixture-owner' },
  ])
})

test('follows reported totals across short pages and deduplicates overlaps', async() => {
  const calls = []
  const service = fixture(async({ page }) => {
    calls.push(page)
    if (page == 1) return response([playlist('a'), playlist('b')], { total: 4 })
    if (page == 2) return response([playlist('b'), playlist('c')], { total: 4 })
    return response([playlist('d')], { total: 4 })
  })
  assert.deepEqual((await service.getUserPlaylists()).map(item => item.id), ['collection_a', 'collection_b', 'collection_c', 'collection_d'])
  assert.deepEqual(calls, [1, 2, 3])
})

test('uses has_more and counts album rows when completing pagination', async() => {
  const calls = []
  const service = fixture(async({ page }) => {
    calls.push(page)
    return page == 1
      ? response([playlist('a')], { has_more: 1 })
      : response([playlist('b'), playlist('album', { list_create_userid: 'another-owner', authors: ['Artist'] })], { total: 3, has_more: 0 })
  })
  assert.equal((await service.getUserPlaylists()).length, 2)
  assert.deepEqual(calls, [1, 2])
})

test('continues full pages without total metadata and stops at an empty page', async() => {
  let calls = 0
  const service = fixture(async({ page, pagesize }) => {
    calls++
    return response(page == 1 ? Array.from({ length: pagesize }, (_, index) => playlist(String(index))) : [])
  })
  assert.equal((await service.getUserPlaylists()).length, 100)
  assert.equal(calls, 2)
})

test('rejects repeating or prematurely empty pages instead of publishing a partial snapshot', async() => {
  for (const repeated of [false, true]) {
    let calls = 0
    const service = fixture(async() => {
      calls++
      return response(calls == 1 || repeated ? [playlist('a')] : [], { total: 2 })
    })
    await assert.rejects(service.getUserPlaylists(), /KuGou user playlists request failed/)
    assert.equal(calls, 2)
  }
})

test('rejects malformed data and account-scoped IDs instead of silently dropping playlists', async() => {
  for (const value of [
    { status: 200, body: { status: 1, data: {} } },
    { status: 200, body: 'unexpected gateway response' },
    response([{ listid: 123, name: 'Account-scoped list', list_create_userid: 'fixture-owner' }]),
    response([{ global_collection_id: 'unsafe&value', name: 'Malformed', type: 0 }]),
  ]) {
    await assert.rejects(fixture(async() => value).getUserPlaylists(), /KuGou user playlists request failed/)
  }
  assert.deepEqual(await fixture(async() => response([], { total: 0 })).getUserPlaylists(), [])
})

test('invalidates only explicit authentication failures and sanitizes upstream failures', async() => {
  for (const value of [
    { status: 401, body: {} },
    { status: 200, body: { error_code: 2001, status: 0 } },
    { status: 200, body: { status: 0, error_msg: 'token expired' } },
    { response: { status: 403, body: {} } },
  ]) {
    let invalidations = 0
    const service = fixture(async() => {
      if (value.response) throw value
      return value
    }, { onAuthFailure: async() => { invalidations++ } })
    await assert.rejects(service.getUserPlaylists(), error => error instanceof KugouAuthError)
    assert.equal(invalidations, 1)
  }
  let invalidations = 0
  const service = fixture(async() => { throw new Error('network failure token=fixture-credential') }, {
    onAuthFailure: async() => { invalidations++ },
  })
  await assert.rejects(service.getUserPlaylists(), error => error.message == 'KuGou user playlists request failed')
  assert.equal(invalidations, 0)
})

test('requires a logged-in profile and cookie before sending requests', async() => {
  for (const extra of [{ getCookie: () => '' }, { getProfile: () => null }]) {
    let calls = 0
    const service = fixture(async() => { calls++; return response([]) }, extra)
    await assert.rejects(service.getUserPlaylists(), error => error instanceof KugouAuthError)
    assert.equal(calls, 0)
  }
})

test('honors enabled kinds and skips all requests when both kinds are disabled', async() => {
  let calls = 0
  const service = fixture(async() => {
    calls++
    return response([playlist('a'), playlist('b', { list_create_userid: 'another-owner' })])
  })
  assert.deepEqual(await service.getUserPlaylists([]), [])
  assert.equal(calls, 0)
  assert.deepEqual((await service.getUserPlaylists(['created'])).map(item => item.kind), ['created'])
  assert.deepEqual((await service.getUserPlaylists(['collected'])).map(item => item.kind), ['collected'])
})

test('discards old-account responses and never clears a replacement account', async() => {
  for (const rejected of [false, true]) {
    let currentCookie = 'initial-fixture'
    let invalidations = 0
    const service = fixture(async() => {
      currentCookie = 'replacement-fixture'
      if (rejected) throw Object.assign(new Error('Authentication failed'), { response: { status: 401, body: {} } })
      return response([playlist('a')])
    }, {
      getCookie: () => currentCookie,
      onAuthFailure: async() => { invalidations++ },
    })
    await assert.rejects(service.getUserPlaylists(), /KuGou account changed while loading playlists/)
    assert.equal(invalidations, 0)
  }
})
