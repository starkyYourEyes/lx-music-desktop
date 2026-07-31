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

const deferred = () => {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

const qqCookie = (uin, key = 'key') => `qqmusic_key=${key}; uin=${uin}`

const saveAccount = async(accounts, provider, cookie, profile, updatedAtMs = 1) => {
  await accounts.save(provider, { cookie, profile, updatedAtMs })
  accounts.saves.length = 0
}

const createQQMusicService = ({
  accounts = createRepository(),
  loginResult = { state: 'success', message: 'ok', cookie: qqCookie('7') },
  credentialService = { getRefreshDueAt: () => null, refresh: async cookie => cookie },
  songService = { getGuessLikeSongs: async() => [] },
} = {}) => {
  const { createQQMusicAccountService } = require('../../src/main/modules/qqMusic/index.ts')
  const service = createQQMusicAccountService({
    accounts,
    loginService: {
      createLoginQr: async() => ({ key: 'key', qrurl: '', qrimg: '' }),
      checkLoginQr: async() => loginResult,
      cancelLoginQr: async() => {},
      disposeAll: async() => {},
    },
    songService,
    dailyRecommendService: { getDailyRecommendSongs: async() => [] },
    homeRecommendService: { getHomeRecommendation: async() => ({}) },
    playlistDetailService: { getPlaylistDetail: async() => ({}) },
    feedbackService: { likeMusic: async() => {}, dislikeMusic: async() => {} },
    credentialService,
    now: () => 20,
    schedule: () => undefined,
    onRefreshDiagnostic: () => {},
  })
  return { accounts, service }
}

const createNeteaseService = ({ accounts = createRepository(), api, now = () => 300_000 } = {}) => {
  const { createNeteaseAccountService } = require('../../src/main/modules/netease/account.ts')
  return {
    accounts,
    service: createNeteaseAccountService({ accounts, api, now }),
  }
}

describe('account credential cutover', () => {
  it('expires a QQ Music QR result when its save completes after a newer QR generation', async() => {
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
    await service.createLoginQr('00000000-0000-4000-8000-000000000000', 0)
    releaseSave()
    const result = await checking

    assert.deepEqual(result, {
      state: 'expired',
      message: '二维码已过期',
      isLoggedIn: false,
      profile: null,
    })
    assert.deepEqual(accounts.saves, [{
      provider: 'qq_music',
      cookie: 'qqmusic_key=key; uin=7',
      profile: { uin: '7', nickname: 'QQ 音乐账号' },
      updatedAtMs: 20,
    }])
  })

  it('treats an unavailable NetEase credential as logged out without clearing QQ Music', async() => {
    const accounts = createRepository()
    accounts.getStatus = provider => provider == 'netease'
      ? {
          loggedIn: false,
          profile: null,
          updatedAtMs: null,
          persistence: null,
          unavailableReason: 'credential_undecryptable',
        }
      : { loggedIn: true, profile: { uin: '7', nickname: 'Q' }, updatedAtMs: 1, persistence: 'encrypted' }
    accounts.getCookie = provider => provider == 'qq_music' ? qqCookie('7') : null
    const { service } = createNeteaseService({
      accounts,
      api: {
        login_qr_key: async() => ({}),
        login_qr_create: async() => ({}),
        login_qr_check: async() => ({}),
        login_status: async() => ({}),
        logout: async() => ({}),
      },
    })

    assert.deepEqual(await service.getAccountStatus(), {
      isLoggedIn: false,
      profile: null,
      unavailableReason: 'credential_undecryptable',
    })
    assert.deepEqual(createQQMusicService({ accounts }).service.getAccountStatus(), {
      isLoggedIn: true,
      profile: { uin: '7', nickname: 'Q' },
    })
    assert.deepEqual(accounts.clears, [])
  })

  it('projects an unavailable QQ Music credential without affecting NetEase', async() => {
    const accounts = createRepository()
    accounts.getStatus = provider => provider == 'qq_music'
      ? {
          loggedIn: false,
          profile: null,
          updatedAtMs: null,
          persistence: null,
          unavailableReason: 'credential_undecryptable',
        }
      : {
          loggedIn: true,
          profile: { userId: 1, nickname: 'N', avatarUrl: '' },
          updatedAtMs: 1,
          persistence: 'encrypted',
        }
    accounts.getCookie = provider => provider == 'netease' ? 'NETEASE_COOKIE_SENTINEL' : null
    const qq = createQQMusicService({ accounts }).service
    const netease = createNeteaseService({
      accounts,
      now: () => 1,
      api: {
        login_qr_key: async() => ({}),
        login_qr_create: async() => ({}),
        login_qr_check: async() => ({}),
        login_status: async() => ({}),
        logout: async() => ({}),
      },
    }).service

    assert.deepEqual(qq.getAccountStatus(), {
      isLoggedIn: false,
      profile: null,
      unavailableReason: 'credential_undecryptable',
    })
    assert.deepEqual(await netease.getAccountStatus(), {
      isLoggedIn: true,
      profile: { userId: 1, nickname: 'N', avatarUrl: '', backgroundUrl: undefined, signature: undefined },
    })
    assert.deepEqual(accounts.clears, [])
  })

  it('waits for QQ Music refresh persistence before issuing the authenticated request', async() => {
    const accounts = createRepository()
    await saveAccount(accounts, 'qq_music', qqCookie('7', 'old'), { uin: '7', nickname: 'Q' })
    const saveGate = deferred()
    const originalSave = accounts.save
    accounts.save = async(...args) => {
      if (args[0] == 'qq_music' && args[1].cookie == qqCookie('7', 'fresh')) {
        await saveGate.promise
      }
      return await originalSave.apply(accounts, args)
    }
    let songCalls = 0
    const { service } = createQQMusicService({
      accounts,
      credentialService: {
        getRefreshDueAt: () => 0,
        refresh: async() => qqCookie('7', 'fresh'),
      },
      songService: { getGuessLikeSongs: async() => { songCalls++; return [] } },
    })

    const request = service.getGuessLikeSongs()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(songCalls, 0)
    saveGate.resolve()
    await request

    assert.equal(songCalls, 1)
    assert.equal(accounts.getCookie('qq_music'), qqCookie('7', 'fresh'))
    assert.deepEqual(accounts.saves, [{
      provider: 'qq_music',
      cookie: qqCookie('7', 'fresh'),
      profile: { uin: '7', nickname: 'Q' },
      updatedAtMs: 20,
    }])
  })

  it('does not overwrite a newer QQ Music login with a stale refresh', async() => {
    const accounts = createRepository()
    await saveAccount(accounts, 'qq_music', qqCookie('7', 'old'), { uin: '7', nickname: 'Old' })
    const refreshGate = deferred()
    const { service } = createQQMusicService({
      accounts,
      loginResult: { state: 'success', message: 'new', cookie: qqCookie('8', 'new') },
      credentialService: {
        getRefreshDueAt: () => 0,
        refresh: async() => await refreshGate.promise,
      },
    })

    const refreshing = service.getGuessLikeSongs()
    await new Promise(resolve => setImmediate(resolve))
    await service.checkLoginQr('new-request')
    refreshGate.resolve(qqCookie('7', 'refreshed'))
    await refreshing

    assert.equal(accounts.getCookie('qq_music'), qqCookie('8', 'new'))
    assert.deepEqual(accounts.getStatus('qq_music').profile, {
      uin: '8',
      nickname: 'QQ 音乐账号',
    })
  })

  it('waits for QQ Music invalid-credential clear before rejecting', async() => {
    const accounts = createRepository()
    await saveAccount(accounts, 'qq_music', qqCookie('7'), { uin: '7', nickname: 'Q' })
    const clearGate = deferred()
    const originalClear = accounts.clear
    accounts.clear = async(...args) => {
      await clearGate.promise
      return await originalClear.apply(accounts, args)
    }
    const { service } = createQQMusicService({
      accounts,
      credentialService: {
        getRefreshDueAt: () => 0,
        refresh: async() => {
          throw Object.assign(new Error('invalid'), {
            name: 'QQMusicCredentialRefreshError',
            kind: 'invalid',
          })
        },
      },
    })
    let settled = false
    const request = service.getGuessLikeSongs().catch(error => {
      settled = true
      return error
    })

    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    clearGate.resolve()
    await request
    assert.deepEqual(accounts.clears, ['qq_music'])
  })

  it('waits for QQ Music logout clear before resolving', async() => {
    const accounts = createRepository()
    await saveAccount(accounts, 'qq_music', qqCookie('7'), { uin: '7', nickname: 'Q' })
    const clearGate = deferred()
    const originalClear = accounts.clear
    accounts.clear = async(...args) => {
      await clearGate.promise
      return await originalClear.apply(accounts, args)
    }
    const { service } = createQQMusicService({ accounts })
    let settled = false
    const loggingOut = service.logout().then(() => { settled = true })

    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    clearGate.resolve()
    await loggingOut
    assert.deepEqual(accounts.clears, ['qq_music'])
  })

  it('waits for NetEase refreshed-profile persistence before returning status', async() => {
    const accounts = createRepository()
    await saveAccount(accounts, 'netease', 'old-cookie', { userId: 1, nickname: 'Old', avatarUrl: '' }, 0)
    const saveGate = deferred()
    const originalSave = accounts.save
    accounts.save = async(...args) => {
      await saveGate.promise
      return await originalSave.apply(accounts, args)
    }
    const { service } = createNeteaseService({
      accounts,
      api: {
        login_qr_key: async() => ({}),
        login_qr_create: async() => ({}),
        login_qr_check: async() => ({}),
        login_status: async() => ({ body: { profile: { userId: 1, nickname: 'Fresh', avatarUrl: '' } } }),
        logout: async() => ({}),
      },
    })
    let settled = false
    const status = service.getAccountStatus().then(value => { settled = true; return value })

    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    saveGate.resolve()
    assert.deepEqual(await status, {
      isLoggedIn: true,
      profile: { userId: 1, nickname: 'Fresh', avatarUrl: '', backgroundUrl: undefined, signature: undefined },
    })
  })

  it('waits for NetEase invalid-profile clear before returning logged out', async() => {
    const accounts = createRepository()
    await saveAccount(accounts, 'netease', 'old-cookie', { userId: 1, nickname: 'Old', avatarUrl: '' }, 0)
    const clearGate = deferred()
    const originalClear = accounts.clear
    accounts.clear = async(...args) => {
      await clearGate.promise
      return await originalClear.apply(accounts, args)
    }
    const { service } = createNeteaseService({
      accounts,
      api: {
        login_qr_key: async() => ({}),
        login_qr_create: async() => ({}),
        login_qr_check: async() => ({}),
        login_status: async() => ({ body: { profile: null } }),
        logout: async() => ({}),
      },
    })
    let settled = false
    const status = service.getAccountStatus().then(value => { settled = true; return value })

    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    clearGate.resolve()
    assert.deepEqual(await status, { isLoggedIn: false, profile: null })
  })

  it('ignores a NetEase refresh response that finishes after logout', async() => {
    const accounts = createRepository()
    await saveAccount(accounts, 'netease', 'old-cookie', { userId: 1, nickname: 'Old', avatarUrl: '' }, 0)
    const responseGate = deferred()
    const { service } = createNeteaseService({
      accounts,
      api: {
        login_qr_key: async() => ({}),
        login_qr_create: async() => ({}),
        login_qr_check: async() => ({}),
        login_status: async() => await responseGate.promise,
        logout: async() => ({}),
      },
    })

    const refreshing = service.getAccountStatus()
    await new Promise(resolve => setImmediate(resolve))
    await service.logout()
    responseGate.resolve({ body: { profile: { userId: 1, nickname: 'Old', avatarUrl: '' } } })
    await refreshing

    assert.equal(accounts.getCookie('netease'), null)
  })

  it('ignores a NetEase refresh response that finishes after a newer QR login', async() => {
    const accounts = createRepository()
    await saveAccount(accounts, 'netease', 'old-cookie', { userId: 1, nickname: 'Old', avatarUrl: '' }, 0)
    const oldResponse = deferred()
    const { service } = createNeteaseService({
      accounts,
      api: {
        login_qr_key: async() => ({}),
        login_qr_create: async() => ({}),
        login_qr_check: async() => ({ body: { code: 803, message: 'new', cookie: 'new-cookie' } }),
        login_status: async({ cookie }) => cookie == 'old-cookie'
          ? await oldResponse.promise
          : ({ body: { profile: { userId: 2, nickname: 'New', avatarUrl: '' } } }),
        logout: async() => ({}),
      },
    })

    const refreshing = service.getAccountStatus()
    await new Promise(resolve => setImmediate(resolve))
    await service.checkLoginQr('new-key')
    oldResponse.resolve({ body: { profile: null } })
    await refreshing

    assert.equal(accounts.getCookie('netease'), 'new-cookie')
    assert.deepEqual(accounts.getStatus('netease').profile, { userId: 2, nickname: 'New', avatarUrl: '' })
  })

  it('persists a later NetEase QR login after an older queued logout clear completes', async() => {
    const accounts = createRepository()
    await saveAccount(accounts, 'netease', 'old-cookie', { userId: 1, nickname: 'Old', avatarUrl: '' }, 0)
    const clearStarted = deferred()
    const clearGate = deferred()
    const qrCheckStarted = deferred()
    const qrResponse = deferred()
    const saveStarted = deferred()
    const saveGate = deferred()
    const originalClear = accounts.clear
    const originalSave = accounts.save
    accounts.clear = async(...args) => {
      clearStarted.resolve()
      await clearGate.promise
      return await originalClear.apply(accounts, args)
    }
    accounts.save = async(...args) => {
      if (args[0] == 'netease' && args[1].cookie == 'new-cookie') {
        saveStarted.resolve()
        await saveGate.promise
      }
      return await originalSave.apply(accounts, args)
    }
    const { service } = createNeteaseService({
      accounts,
      api: {
        login_qr_key: async() => ({}),
        login_qr_create: async() => ({}),
        login_qr_check: async() => {
          qrCheckStarted.resolve()
          return await qrResponse.promise
        },
        login_status: async() => ({ body: { profile: { userId: 2, nickname: 'New', avatarUrl: '' } } }),
        logout: async() => ({}),
      },
    })

    const loggingOut = service.logout()
    await clearStarted.promise
    const checking = service.checkLoginQr('new-key')
    await qrCheckStarted.promise
    clearGate.resolve()
    await loggingOut
    qrResponse.resolve({ body: { code: 803, message: 'new', cookie: 'new-cookie' } })
    const firstOutcome = await Promise.race([
      saveStarted.promise.then(() => 'save-started'),
      checking.then(result => ({ result })),
    ])
    assert.equal(firstOutcome, 'save-started')
    let settled = false
    const checkingFinished = checking.then(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    saveGate.resolve()

    assert.deepEqual(await checking, {
      code: 803,
      message: 'new',
      isLoggedIn: true,
      profile: { userId: 2, nickname: 'New', avatarUrl: '', backgroundUrl: undefined, signature: undefined },
    })
    await checkingFinished
    assert.equal(accounts.getCookie('netease'), 'new-cookie')
  })

  it('clears a QR credential saved while a later NetEase logout waits for its provider', async() => {
    const accounts = createRepository()
    await saveAccount(accounts, 'netease', 'old-cookie', { userId: 1, nickname: 'Old', avatarUrl: '' }, 0)
    const saveStarted = deferred()
    const saveGate = deferred()
    const logoutStarted = deferred()
    const logoutGate = deferred()
    const clearStarted = deferred()
    const clearGate = deferred()
    const originalSave = accounts.save
    const originalClear = accounts.clear
    accounts.save = async(...args) => {
      if (args[0] == 'netease' && args[1].cookie == 'new-cookie') {
        saveStarted.resolve()
        await saveGate.promise
      }
      return await originalSave.apply(accounts, args)
    }
    accounts.clear = async(...args) => {
      clearStarted.resolve()
      await clearGate.promise
      return await originalClear.apply(accounts, args)
    }
    let logoutCookie
    const { service } = createNeteaseService({
      accounts,
      api: {
        login_qr_key: async() => ({}),
        login_qr_create: async() => ({}),
        login_qr_check: async() => ({ body: { code: 803, message: 'new', cookie: 'new-cookie' } }),
        login_status: async() => ({ body: { profile: { userId: 2, nickname: 'New', avatarUrl: '' } } }),
        logout: async({ cookie }) => {
          logoutCookie = cookie
          logoutStarted.resolve()
          await logoutGate.promise
        },
      },
    })

    const checking = service.checkLoginQr('new-key')
    await saveStarted.promise
    const loggingOut = service.logout()
    await logoutStarted.promise
    saveGate.resolve()
    assert.deepEqual(await checking, { code: 803, message: 'new', isLoggedIn: false, profile: null })
    logoutGate.resolve()
    const firstOutcome = await Promise.race([
      clearStarted.promise.then(() => 'clear-started'),
      loggingOut.then(() => 'logout-finished'),
    ])
    assert.equal(firstOutcome, 'clear-started')
    let logoutFinished = false
    const logoutFinishedPromise = loggingOut.then(() => { logoutFinished = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(logoutFinished, false)
    clearGate.resolve()
    await logoutFinishedPromise

    assert.equal(logoutCookie, 'old-cookie')
    assert.equal(accounts.getCookie('netease'), null)
  })

  it('does not overwrite an unrelated current NetEase credential with a QR response', async() => {
    const accounts = createRepository()
    await saveAccount(accounts, 'netease', 'old-cookie', { userId: 1, nickname: 'Old', avatarUrl: '' }, 0)
    const qrResponse = deferred()
    const { service } = createNeteaseService({
      accounts,
      api: {
        login_qr_key: async() => ({}),
        login_qr_create: async() => ({}),
        login_qr_check: async() => await qrResponse.promise,
        login_status: async() => ({ body: { profile: { userId: 2, nickname: 'New', avatarUrl: '' } } }),
        logout: async() => ({}),
      },
    })

    const checking = service.checkLoginQr('new-key')
    await new Promise(resolve => setImmediate(resolve))
    await accounts.save('netease', {
      cookie: 'unrelated-cookie',
      profile: { userId: 3, nickname: 'Unrelated', avatarUrl: '' },
      updatedAtMs: 0,
    })
    qrResponse.resolve({ body: { code: 803, message: 'new', cookie: 'new-cookie' } })

    assert.deepEqual(await checking, { code: 803, message: 'new', isLoggedIn: false, profile: null })
    assert.equal(accounts.getCookie('netease'), 'unrelated-cookie')
    assert.deepEqual(accounts.saves, [{
      provider: 'netease',
      cookie: 'unrelated-cookie',
      profile: { userId: 3, nickname: 'Unrelated', avatarUrl: '' },
      updatedAtMs: 0,
    }])
  })
})
