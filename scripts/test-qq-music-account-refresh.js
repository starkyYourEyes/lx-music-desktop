const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

class QQMusicAuthError extends Error {
  constructor(message = 'expired') {
    super(message)
    this.name = 'QQMusicAuthError'
  }
}

class QQMusicCredentialRefreshError extends Error {
  constructor(kind) {
    super(`QQ Music credential refresh ${kind}`)
    this.name = 'QQMusicCredentialRefreshError'
    this.kind = kind
  }
}

const isQQMusicAuthError = error => error?.name === 'QQMusicAuthError'
const isQQMusicCredentialRefreshError = error =>
  error?.name === 'QQMusicCredentialRefreshError'

const getQQMusicAccountUin = (cookie) => {
  const uin = cookie.match(/(?:^|;\s*)(?:uin|qqmusic_uin)=([^;]+)/)?.[1] ?? ''
  const key = cookie.match(/(?:^|;\s*)(?:qqmusic_key|qm_keyst)=([^;]+)/)?.[1] ?? ''
  return key ? uin : ''
}

const {
  createQQMusicAccountService,
} = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/index.ts'),
  {
    '@common/constants': {
      DATA_KEYS: { qqMusicAccount: 'qqMusicAccount' },
      STORE_NAMES: { DATA: 'data' },
    },
    '@main/utils/store': () => {
      throw new Error('unexpected singleton store')
    },
    './login': {
      createQQMusicLoginService: () => {
        throw new Error('unexpected singleton login service')
      },
    },
    './auth': { getQQMusicAccountUin },
    './credential': {
      createQQMusicCredentialService: () => {
        throw new Error('unexpected singleton credential service')
      },
      isQQMusicCredentialRefreshError,
    },
    './song': {
      createQQMusicSongService: () => {
        throw new Error('unexpected singleton song service')
      },
      QQMusicAuthError,
      isQQMusicAuthError,
    },
    './dailyRecommend': {
      createQQMusicDailyRecommendService: () => {
        throw new Error('unexpected singleton daily service')
      },
    },
    './homeRecommend': {
      createQQMusicHomeRecommendService: () => {
        throw new Error('unexpected singleton home service')
      },
    },
    './playlistDetail': {
      createQQMusicPlaylistDetailService: () => {
        throw new Error('unexpected singleton playlist service')
      },
    },
  },
)

const accountA = {
  cookie: 'uin=oA; qqmusic_key=old-key',
  profile: { uin: 'oA', nickname: 'QQ Music account' },
  updatedAt: 10,
}
const accountB = {
  cookie: 'uin=oB; qqmusic_key=account-b',
  profile: { uin: 'oB', nickname: 'QQ Music account' },
  updatedAt: 20,
}

const createStore = (initial) => {
  const data = new Map([['qqMusicAccount', initial]])
  return {
    data,
    store: {
      get: key => data.get(key),
      set: (key, value) => data.set(key, value),
    },
  }
}

const createServices = (request) => {
  const loginService = {
    createLoginQr: async() => ({
      key: 'fixed-qr',
      qrimg: 'data:image/png;base64,AA==',
    }),
    checkLoginQr: async() => ({
      state: 'waiting',
      message: 'waiting',
    }),
  }
  return {
    loginService,
    songService: { getGuessLikeSongs: request },
    dailyRecommendService: { getDailyRecommendSongs: request },
    homeRecommendService: { getHomeRecommendation: request },
    playlistDetailService: { getPlaylistDetail: request },
  }
}

const createDeferred = () => {
  let resolveDeferred
  let rejectDeferred
  const promise = new Promise((resolve, reject) => {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return {
    promise,
    resolve: resolveDeferred,
    reject: rejectDeferred,
  }
}

const waitForTurn = () => new Promise(resolve => setImmediate(resolve))

const createFacade = ({
  initial = accountA,
  request,
  refresh,
  now = () => 30,
  onRefreshDiagnostic = () => {},
}) => {
  const { data, store } = createStore(initial)
  const services = createServices(request)
  const credentialService = {
    refresh,
    getRefreshDueAt: () => null,
  }
  const service = createQQMusicAccountService({
    store,
    ...services,
    credentialService,
    onRefreshDiagnostic,
    now,
  })
  return { data, store, services, service }
}

const main = async() => {
  {
    let requestCalls = 0
    let refreshCalls = 0
    let data
    const facade = createFacade({
      request: async() => {
        requestCalls++
        if (requestCalls == 1) throw new QQMusicAuthError()
        assert.strictEqual(
          data.get('qqMusicAccount').cookie,
          'uin=oA; qqmusic_key=new-key',
        )
        return ['retried']
      },
      refresh: async() => {
        refreshCalls++
        return 'uin=oA; qqmusic_key=new-key'
      },
    })
    data = facade.data
    assert.deepStrictEqual(await facade.service.getGuessLikeSongs(), ['retried'])
    assert.strictEqual(requestCalls, 2)
    assert.strictEqual(refreshCalls, 1)
    assert.deepStrictEqual(data.get('qqMusicAccount'), {
      cookie: 'uin=oA; qqmusic_key=new-key',
      profile: accountA.profile,
      updatedAt: 30,
    })
  }

  {
    let requestCalls = 0
    let refreshCalls = 0
    const authError = new QQMusicAuthError()
    const { data, service } = createFacade({
      request: async() => {
        requestCalls++
        throw authError
      },
      refresh: async() => {
        refreshCalls++
        return 'uin=oA; qqmusic_key=new-key'
      },
    })
    await assert.rejects(service.getGuessLikeSongs(), error => error === authError)
    assert.strictEqual(requestCalls, 2)
    assert.strictEqual(refreshCalls, 1)
    assert.strictEqual(service.getAccountStatus().isLoggedIn, true)
    assert.strictEqual(
      data.get('qqMusicAccount').cookie,
      'uin=oA; qqmusic_key=new-key',
    )
  }

  for (const refreshedCookie of [
    'not-a-cookie',
    'uin=oB; qqmusic_key=wrong-account',
  ]) {
    const diagnostics = []
    const authError = new QQMusicAuthError()
    let requestCalls = 0
    const { data, service } = createFacade({
      request: async() => {
        requestCalls++
        throw authError
      },
      refresh: async() => refreshedCookie,
      onRefreshDiagnostic: event => diagnostics.push(event),
    })
    await assert.rejects(service.getGuessLikeSongs(), error => error === authError)
    assert.strictEqual(requestCalls, 1)
    assert.deepStrictEqual(data.get('qqMusicAccount'), accountA)
    assert.deepStrictEqual(diagnostics, [{
      trigger: 'auth-error',
      outcome: 'transient',
    }])
  }

  {
    let requestCalls = 0
    let refreshCalls = 0
    const refreshDeferred = createDeferred()
    const { service } = createFacade({
      request: async() => {
        requestCalls++
        if (requestCalls <= 2) throw new QQMusicAuthError()
        return ['ok']
      },
      refresh: async() => {
        refreshCalls++
        return refreshDeferred.promise
      },
    })
    const songRequest = service.getGuessLikeSongs()
    const dailyRequest = service.getDailyRecommendSongs()
    await waitForTurn()
    assert.strictEqual(refreshCalls, 1)
    refreshDeferred.resolve('uin=oA; qqmusic_key=shared-new-key')
    assert.deepStrictEqual(await songRequest, ['ok'])
    assert.deepStrictEqual(await dailyRequest, ['ok'])
    assert.strictEqual(refreshCalls, 1)
    assert.strictEqual(requestCalls, 4)
  }

  {
    const songDeferred = createDeferred()
    const dailyDeferred = createDeferred()
    const calls = { song: 0, daily: 0 }
    let services
    const request = function() {
      const kind = this === services.songService ? 'song' : 'daily'
      calls[kind]++
      if (calls[kind] == 1) {
        return kind == 'song' ? songDeferred.promise : dailyDeferred.promise
      }
      return Promise.resolve(['ok'])
    }
    let refreshCalls = 0
    const facade = createFacade({
      request,
      refresh: async() => {
        refreshCalls++
        return 'uin=oA; qqmusic_key=late-new-key'
      },
    })
    services = facade.services
    const songRequest = facade.service.getGuessLikeSongs()
    const dailyRequest = facade.service.getDailyRecommendSongs()
    songDeferred.reject(new QQMusicAuthError())
    assert.deepStrictEqual(await songRequest, ['ok'])
    dailyDeferred.reject(new QQMusicAuthError())
    assert.deepStrictEqual(await dailyRequest, ['ok'])
    assert.deepStrictEqual(calls, { song: 2, daily: 2 })
    assert.strictEqual(refreshCalls, 1)
  }

  for (const kind of ['invalid', 'unavailable', 'transient']) {
    const diagnostics = []
    const authError = new QQMusicAuthError()
    const { data, service } = createFacade({
      request: async() => {
        throw authError
      },
      refresh: async() => {
        throw new QQMusicCredentialRefreshError(kind)
      },
      onRefreshDiagnostic: event => diagnostics.push(event),
    })
    await assert.rejects(service.getGuessLikeSongs(), error => error === authError)
    assert.strictEqual(service.getAccountStatus().isLoggedIn, kind != 'invalid')
    assert.strictEqual(
      data.get('qqMusicAccount').cookie,
      kind == 'invalid' ? '' : accountA.cookie,
    )
    assert.deepStrictEqual(diagnostics, [{
      trigger: 'auth-error',
      outcome: kind,
    }])
  }

  {
    const refreshDeferred = createDeferred()
    const authError = new QQMusicAuthError()
    const { data, service } = createFacade({
      request: async() => {
        throw authError
      },
      refresh: async() => refreshDeferred.promise,
    })
    const pending = service.getGuessLikeSongs()
    await waitForTurn()
    data.set('qqMusicAccount', accountB)
    refreshDeferred.resolve('uin=oA; qqmusic_key=stale-key')
    await assert.rejects(pending, error => error === authError)
    assert.deepStrictEqual(data.get('qqMusicAccount'), accountB)
  }

  {
    const diagnostics = []
    const refreshDeferred = createDeferred()
    const authError = new QQMusicAuthError()
    const { data, service } = createFacade({
      request: async() => {
        throw authError
      },
      refresh: async() => refreshDeferred.promise,
      onRefreshDiagnostic: event => diagnostics.push(event),
    })
    const pending = service.getGuessLikeSongs()
    await waitForTurn()
    data.set('qqMusicAccount', accountB)
    refreshDeferred.reject(new QQMusicCredentialRefreshError('invalid'))
    await assert.rejects(pending, error => error === authError)
    assert.deepStrictEqual(data.get('qqMusicAccount'), accountB)
    assert.deepStrictEqual(diagnostics, [{
      trigger: 'auth-error',
      outcome: 'stale',
    }])
  }

  {
    const refreshDeferred = createDeferred()
    const authError = new QQMusicAuthError()
    const { data, service } = createFacade({
      request: async() => {
        throw authError
      },
      refresh: async() => refreshDeferred.promise,
    })
    const pending = service.getGuessLikeSongs()
    await waitForTurn()
    await service.logout()
    refreshDeferred.resolve('uin=oA; qqmusic_key=logout-lost-key')
    await assert.rejects(pending, error => error === authError)
    assert.strictEqual(data.get('qqMusicAccount').cookie, '')
    assert.strictEqual(service.getAccountStatus().isLoggedIn, false)
  }

  {
    const refreshDeferred = createDeferred()
    const authError = new QQMusicAuthError()
    const { data, services, service } = createFacade({
      request: async() => {
        throw authError
      },
      refresh: async() => refreshDeferred.promise,
    })
    const pending = service.getGuessLikeSongs()
    await waitForTurn()
    services.loginService.checkLoginQr = async() => ({
      state: 'success',
      message: 'login success',
      cookie: accountB.cookie,
    })
    await service.checkLoginQr('new-login')
    refreshDeferred.resolve('uin=oA; qqmusic_key=login-lost-key')
    await assert.rejects(pending, error => error === authError)
    assert.strictEqual(data.get('qqMusicAccount').cookie, accountB.cookie)
    assert.strictEqual(data.get('qqMusicAccount').profile.uin, 'oB')
  }

  {
    const diagnostics = []
    const refreshDeferred = createDeferred()
    const authError = new QQMusicAuthError()
    const { data, services, service } = createFacade({
      request: async() => {
        throw authError
      },
      refresh: async() => refreshDeferred.promise,
      now: () => 10,
      onRefreshDiagnostic: event => diagnostics.push(event),
    })
    const pending = service.getGuessLikeSongs()
    await waitForTurn()
    services.loginService.checkLoginQr = async() => ({
      state: 'success',
      message: 'login success',
      cookie: accountA.cookie,
    })
    await service.checkLoginQr('same-account-login')
    const qrAccount = data.get('qqMusicAccount')
    refreshDeferred.resolve('uin=oA; qqmusic_key=stale-after-login')
    await assert.rejects(pending, error => error === authError)
    assert.deepStrictEqual(data.get('qqMusicAccount'), qrAccount)
    assert.strictEqual(qrAccount.updatedAt, 11)
    assert.deepStrictEqual(diagnostics, [{
      trigger: 'auth-error',
      outcome: 'stale',
    }])
  }
}

main().then(() => {
  console.log('QQ Music account refresh tests passed')
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
