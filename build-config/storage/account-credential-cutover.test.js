const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { after, describe, it } = require('node:test')
const typescript = require('typescript')

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(output, filename)
}

const sourceRoot = path.resolve(__dirname, '../../src')
const originalResolveFilename = Module._resolveFilename
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request.startsWith('@main/')) request = path.join(sourceRoot, 'main', request.slice('@main/'.length))
  if (request.startsWith('@common/')) request = path.join(sourceRoot, 'common', request.slice('@common/'.length))
  return originalResolveFilename.call(this, request, parent, isMain, options)
}

after(() => {
  Module._resolveFilename = originalResolveFilename
  // eslint-disable-next-line n/no-deprecated-api
  delete require.extensions['.ts']
})

const createRepository = () => {
  const accounts = new Map()
  const saves = []
  const clears = []
  return {
    saves,
    clears,
    getCookie(provider) {
      return accounts.get(provider)?.cookie ?? null
    },
    getStatus(provider) {
      const account = accounts.get(provider)
      return account == null
        ? { loggedIn: false, profile: null, updatedAtMs: null, persistence: null }
        : { loggedIn: true, profile: account.profile, updatedAtMs: account.updatedAtMs, persistence: 'encrypted' }
    },
    async save(provider, account) {
      saves.push({ provider, ...account })
      accounts.set(provider, { ...account })
      return { persistence: 'encrypted' }
    },
    async clear(provider) {
      clears.push(provider)
      accounts.delete(provider)
    },
  }
}

const createQQMusicService = () => {
  const { createQQMusicAccountService } = require('../../src/main/modules/qqMusic/index.ts')
  const accounts = createRepository()
  const service = createQQMusicAccountService({
    accounts,
    loginService: {
      createLoginQr: async() => ({ key: 'key', qrurl: '', qrimg: '' }),
      checkLoginQr: async() => ({
        state: 'success',
        message: 'ok',
        cookie: 'qqmusic_key=key; uin=7',
      }),
      cancelLoginQr: async() => {},
      disposeAll: async() => {},
    },
    songService: { getGuessLikeSongs: async() => [] },
    dailyRecommendService: { getDailyRecommendSongs: async() => [] },
    homeRecommendService: { getHomeRecommendation: async() => ({}) },
    playlistDetailService: { getPlaylistDetail: async() => ({}) },
    feedbackService: { likeMusic: async() => {}, dislikeMusic: async() => {} },
    credentialService: { getRefreshDueAt: () => null, refresh: async cookie => cookie },
    now: () => 20,
  })
  return { accounts, service }
}

describe('account credential cutover', () => {
  it('persists a QQ Music login through the repository before returning success', async() => {
    const { accounts, service } = createQQMusicService()
    const originalSave = accounts.save
    let releaseSave
    const saveStarted = new Promise(resolve => {
      accounts.save = async(...args) => {
        resolve()
        await new Promise(resolve => { releaseSave = resolve })
        return await originalSave.apply(accounts, args)
      }
    })
    let resolved = false
    const checking = service.checkLoginQr('request-id').then(result => {
      resolved = true
      return result
    })

    await saveStarted
    assert.equal(resolved, false)
    releaseSave()
    const result = await checking

    assert.equal(result.isLoggedIn, true)
    assert.deepEqual(accounts.saves, [{
      provider: 'qq_music',
      cookie: 'qqmusic_key=key; uin=7',
      profile: { uin: '7', nickname: 'QQ 音乐账号' },
      updatedAtMs: 20,
    }])
  })

  it('treats an unavailable NetEase credential as logged out without clearing QQ Music', async() => {
    const { createNeteaseAccountService } = require('../../src/main/modules/netease/account.ts')
    const accounts = createRepository()
    accounts.getStatus = provider => provider == 'netease'
      ? { loggedIn: false, profile: null, updatedAtMs: null, persistence: null }
      : { loggedIn: true, profile: { uin: '7', nickname: 'Q' }, updatedAtMs: 1, persistence: 'encrypted' }
    const service = createNeteaseAccountService({
      accounts,
      api: {
        login_qr_key: async() => ({}),
        login_qr_create: async() => ({}),
        login_qr_check: async() => ({}),
        login_status: async() => ({}),
        logout: async() => ({}),
      },
    })

    assert.deepEqual(await service.getAccountStatus(), { isLoggedIn: false, profile: null })
    assert.deepEqual(accounts.clears, [])
  })
})
