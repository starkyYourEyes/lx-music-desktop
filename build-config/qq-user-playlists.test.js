/* eslint-disable n/no-deprecated-api */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { test } = require('node:test')
const typescript = require('typescript')

const root = path.resolve(__dirname, '..')
const previousLoader = require.extensions['.ts']
const previousResolve = Module._resolveFilename
require.extensions['.ts'] = (mod, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText
  mod._compile(output, filename)
}
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request.startsWith('@common/')) request = path.join(root, 'src/common', request.slice('@common/'.length))
  if (request.startsWith('@main/')) request = path.join(root, 'src/main', request.slice('@main/'.length))
  return previousResolve.call(this, request, parent, isMain, options)
}
const { createQQMusicUserPlaylistService } = require('../src/main/modules/qqMusic/userPlaylists.ts')
const { createQQMusicAccountService } = require('../src/main/modules/qqMusic/index.ts')
const { QQMusicAuthError } = require('../src/main/modules/qqMusic/song.ts')
require.extensions['.ts'] = previousLoader
Module._resolveFilename = previousResolve

const profile = { uin: '123456', nickname: 'Test account' }
const cookie = 'uin=123456; qqmusic_key=test-only-key'
const response = payload => ({ ok: true, status: 200, json: async() => payload })
const created = (id, name = `Created ${id}`) => ({ tid: id, dirid: 301, diss_name: name, diss_cover: 'https://y.gtimg.cn/created.jpg' })
const collected = (id, name = `Collected ${id}`) => ({ dissid: id, dissname: name, logo: 'https://y.gtimg.cn/collected.jpg' })
const fixture = (fetchImpl, overrides = {}) => createQQMusicUserPlaylistService({
  getCookie: () => cookie,
  getProfile: () => profile,
  fetchImpl,
  ...overrides,
})

test('fetches both account-owned lists, preserving real playlist IDs and kind', async() => {
  const calls = []
  const service = fixture(async(url, options) => {
    calls.push({ url, options })
    if (url.pathname.endsWith('fcg_user_created_diss')) {
      return response({ code: 0, data: { disslist: [created('101'), created('102', 'My likes')], total: 2 } })
    }
    return response({ code: 0, data: { cdlist: [collected('201'), collected('101')], totaldiss: 2 } })
  })
  const lists = await service.getUserPlaylists()
  assert.deepEqual(lists.map(({ sourceListId, kind }) => ({ sourceListId, kind })), [
    { sourceListId: '101', kind: 'created' },
    { sourceListId: '102', kind: 'created' },
    { sourceListId: '201', kind: 'collected' },
  ])
  assert.deepEqual(lists[0], {
    provider: 'qq_music',
    kind: 'created',
    id: '101',
    sourceListId: '101',
    name: 'Created 101',
    coverUrl: 'https://y.gtimg.cn/created.jpg',
    accountKey: profile.uin,
  })
  assert.equal(JSON.stringify(lists).includes('test-only-key'), false)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url.searchParams.get('hostuin'), profile.uin)
  assert.equal(calls[1].url.searchParams.get('userid'), profile.uin)
  assert.equal(calls[1].url.searchParams.get('reqtype'), '3')
  for (const { url, options } of calls) {
    assert.equal(url.protocol, 'https:')
    assert.equal(url.searchParams.get('format'), 'json')
    assert.notEqual(url.searchParams.get('g_tk'), '5381')
    assert.equal(options.headers.Cookie, cookie)
    assert.match(options.headers.Referer, /^https:\/\/y\.qq\.com\//)
  }
})

test('advances by raw page length before deduplication and follows totals across short pages', async() => {
  const offsets = { created: [], collected: [] }
  const service = fixture(async url => {
    const kind = url.pathname.endsWith('fcg_user_created_diss') ? 'created' : 'collected'
    const offset = Number(url.searchParams.get('sin'))
    offsets[kind].push(offset)
    if (kind == 'created') {
      return response({
        code: 0,
        data: {
          total: 4,
          disslist: offset == 0
            ? [created('101'), created('101')]
            : [created('102'), { dirid: 201, diss_name: 'Missing global ID' }],
        },
      })
    }
    return response({
      code: 0,
      data: {
        totaldiss: 3,
        cdlist: offset == 0
          ? [collected('201'), collected('201')]
          : [collected('202')],
      },
    })
  })
  assert.deepEqual((await service.getUserPlaylists()).map(item => item.id), ['101', '102', '201', '202'])
  assert.deepEqual(offsets, { created: [0, 2], collected: [0, 2] })
})

test('requests only enabled kinds and skips even authentication when all kinds are disabled', async() => {
  for (const kind of ['created', 'collected']) {
    const calls = []
    const service = fixture(async url => {
      calls.push(url.pathname)
      return response({ code: 0, data: { disslist: [created('101')], cdlist: [collected('201')], total: 1, totaldiss: 1 } })
    })
    const lists = await service.getUserPlaylists([kind])
    assert.deepEqual(lists.map(item => item.kind), [kind])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].endsWith('fcg_user_created_diss'), kind == 'created')
  }
  const disabled = fixture(async() => assert.fail('must not send request'), { getCookie: () => '' })
  assert.deepEqual(await disabled.getUserPlaylists([]), [])
})

test('continues full created pages without totals and stops at an empty last page', async() => {
  const createdOffsets = []
  const service = fixture(async url => {
    if (!url.pathname.endsWith('fcg_user_created_diss')) return response({ code: 0, data: { totaldiss: 0, cdlist: [] } })
    const offset = Number(url.searchParams.get('sin'))
    const size = Number(url.searchParams.get('size'))
    createdOffsets.push(offset)
    return response({
      code: 0,
      data: {
        disslist: offset == 0
          ? Array.from({ length: size }, (_, index) => created(String(1000 + index)))
          : [],
      },
    })
  })
  const lists = await service.getUserPlaylists()
  assert.equal(lists.length, createdOffsets[1])
  assert.deepEqual(createdOffsets, [0, lists.length])
})

test('rejects repeated pages and contradictory empty pages instead of returning partial data', async() => {
  for (const repeat of [true, false]) {
    const service = fixture(async url => response({
      code: 0,
      data: {
        total: 10,
        disslist:
      repeat || url.searchParams.get('sin') == '0' ? [created('101')] : [],
      },
    }))
    await assert.rejects(service.getUserPlaylists(), { message: 'QQ Music user playlists request failed' })
  }
})

test('rejects malformed or private responses without treating them as an empty account', async() => {
  for (const payload of [{ code: 0 }, { code: 0, data: {} }, { code: 4000, data: { disslist: [] } }]) {
    await assert.rejects(fixture(async() => response(payload)).getUserPlaylists(), {
      message: 'QQ Music user playlists request failed',
    })
  }
})

test('classifies provider login errors for credential refresh and sanitizes transport failures', async() => {
  for (const payload of [{ code: 1000 }, { code: -1, subcode: -2, data: {} }]) {
    await assert.rejects(fixture(async() => response(payload)).getUserPlaylists(), QQMusicAuthError)
  }
  await assert.rejects(fixture(async() => ({ ok: false, status: 401 })).getUserPlaylists(), QQMusicAuthError)
  await assert.rejects(fixture(async() => { throw new Error(`network ${cookie}`) }).getUserPlaylists(), {
    message: 'QQ Music user playlists request failed',
  })
})

test('requires a matching account and rejects data that arrives after logout', async() => {
  for (const overrides of [{ getCookie: () => '' }, { getProfile: () => null }, { getProfile: () => ({ uin: '654321', nickname: 'Other' }) }]) {
    await assert.rejects(fixture(async() => assert.fail('must not send request'), overrides).getUserPlaylists(), QQMusicAuthError)
  }
  let currentCookie = cookie
  const service = fixture(async() => {
    currentCookie = ''
    return response({ code: 0, data: { disslist: [], cdlist: [], total: 0, totaldiss: 0 } })
  }, { getCookie: () => currentCookie })
  await assert.rejects(service.getUserPlaylists(), QQMusicAuthError)
})

test('account service refreshes expired credentials and retries user playlists', async() => {
  let account = { cookie, profile, updatedAtMs: 1 }
  let refreshes = 0
  let requests = 0
  const accounts = {
    getCookie: () => account.cookie,
    getStatus: () => ({ loggedIn: true, profile: account.profile, updatedAtMs: account.updatedAtMs }),
    save: async(provider, value) => { account = value },
    clear: async() => { account = { cookie: '', profile: null, updatedAtMs: 2 } },
  }
  const service = createQQMusicAccountService({
    accounts,
    loginService: { disposeAll: async() => {} },
    songService: {},
    dailyRecommendService: {},
    homeRecommendService: {},
    playlistDetailService: {},
    feedbackService: {},
    userPlaylistService: {
      getUserPlaylists: async kinds => {
        assert.deepEqual(kinds, ['collected'])
        requests++
        if (account.cookie == cookie) throw new QQMusicAuthError()
        return [{ id: '101' }]
      },
    },
    credentialService: {
      getRefreshDueAt: () => null,
      refresh: async() => { refreshes++; return cookie.replace('test-only-key', 'refreshed-test-key') },
    },
    onRefreshDiagnostic: () => {},
    musicUrlAuthorization: { transition: async(provider, change) => (await change()).value },
  })
  assert.deepEqual(await service.getUserPlaylists([]), [])
  assert.equal(refreshes, 0)
  assert.deepEqual(await service.getUserPlaylists(['collected']), [{ id: '101' }])
  assert.equal(requests, 2)
  assert.equal(refreshes, 1)
})
