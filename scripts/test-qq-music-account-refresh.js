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

const createScheduler = () => {
  const timers = []
  return {
    timers,
    schedule: (callback, delay) => {
      const timer = {
        callback,
        delay,
        cancelled: false,
        unrefed: false,
        unref() {
          this.unrefed = true
        },
      }
      timers.push(timer)
      return timer
    },
    cancel: timer => {
      timer.cancelled = true
    },
  }
}

const waitForTurn = () => new Promise(resolve => setImmediate(resolve))

const createFacade = ({
  initial = accountA,
  request,
  refresh,
  getRefreshDueAt = () => null,
  now = () => 30,
  schedule,
  cancelSchedule,
  retryDelayMs,
  onRefreshDiagnostic = () => {},
}) => {
  const { data, store } = createStore(initial)
  const services = createServices(request)
  const credentialService = {
    refresh,
    getRefreshDueAt,
  }
  const service = createQQMusicAccountService({
    store,
    ...services,
    credentialService,
    onRefreshDiagnostic,
    now,
    schedule,
    cancelSchedule,
    retryDelayMs,
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

  {
    let requestCalls = 0
    let refreshCalls = 0
    let data
    const authError = new QQMusicAuthError()
    const facade = createFacade({
      request: async() => {
        requestCalls++
        assert.strictEqual(
          data.get('qqMusicAccount').cookie,
          'uin=oA; qqmusic_key=preflight-new-key',
        )
        throw authError
      },
      refresh: async() => {
        refreshCalls++
        return 'uin=oA; qqmusic_key=preflight-new-key'
      },
      getRefreshDueAt: () => 40,
      now: () => 40,
      schedule: () => undefined,
      cancelSchedule: () => {},
    })
    data = facade.data
    await assert.rejects(
      facade.service.getGuessLikeSongs(),
      error => error === authError,
    )
    assert.strictEqual(refreshCalls, 1)
    assert.strictEqual(requestCalls, 1)
  }

  {
    let requestCalls = 0
    let refreshCalls = 0
    const refreshDeferred = createDeferred()
    const scheduler = createScheduler()
    let data
    const facade = createFacade({
      request: async() => {
        requestCalls++
        assert.strictEqual(
          data.get('qqMusicAccount').cookie,
          `${accountB.cookie}; psrf_musickey_createtime=300`,
        )
        return ['account-b-result']
      },
      refresh: async() => {
        refreshCalls++
        return refreshDeferred.promise
      },
      getRefreshDueAt: cookie => cookie == accountA.cookie ? 40 : 900,
      now: () => 40,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    data = facade.data
    const pending = facade.service.getGuessLikeSongs()
    await waitForTurn()
    facade.services.loginService.checkLoginQr = async() => ({
      state: 'success',
      message: 'login success',
      cookie: [
        accountB.cookie,
        'psrf_musickey_createtime=300',
      ].join('; '),
    })
    await facade.service.checkLoginQr('new-login')
    refreshDeferred.reject(new QQMusicCredentialRefreshError('invalid'))
    assert.deepStrictEqual(await pending, ['account-b-result'])
    assert.strictEqual(refreshCalls, 1)
    assert.strictEqual(requestCalls, 1)
    assert.strictEqual(
      data.get('qqMusicAccount').cookie,
      `${accountB.cookie}; psrf_musickey_createtime=300`,
    )
  }

  {
    const scheduler = createScheduler()
    createFacade({
      request: async() => [],
      refresh: async() => accountA.cookie,
      getRefreshDueAt: () => 80,
      now: () => 50,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    assert.strictEqual(scheduler.timers.length, 1)
    assert.strictEqual(scheduler.timers[0].delay, 30)
    assert.strictEqual(scheduler.timers[0].unrefed, true)
  }

  {
    const scheduler = createScheduler()
    const { data, service } = createFacade({
      request: async() => [],
      refresh: async() => {
        throw new QQMusicCredentialRefreshError('transient')
      },
      getRefreshDueAt: () => 50,
      now: () => 50,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    assert.strictEqual(scheduler.timers[0].delay, 0)
    scheduler.timers[0].callback()
    await waitForTurn()
    assert.strictEqual(service.getAccountStatus().isLoggedIn, true)
    assert.deepStrictEqual(data.get('qqMusicAccount'), accountA)
    assert.strictEqual(
      scheduler.timers.at(-1).delay,
      60 * 60 * 1000,
    )
    assert.strictEqual(scheduler.timers.at(-1).unrefed, true)
    assert.strictEqual(scheduler.timers.length, 2)
  }

  {
    const scheduler = createScheduler()
    const { data, service } = createFacade({
      request: async() => [],
      refresh: async() => [
        'uin=oA',
        'qqmusic_key=scheduled-new-key',
        'psrf_musickey_createtime=200',
      ].join('; '),
      getRefreshDueAt: cookie =>
        cookie.includes('scheduled-new-key') ? 500 : 100,
      now: () => 100,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    assert.strictEqual(scheduler.timers[0].delay, 0)
    scheduler.timers[0].callback()
    await waitForTurn()
    assert.strictEqual(scheduler.timers.at(-1).delay, 400)
    assert.strictEqual(scheduler.timers.at(-1).unrefed, true)
    assert.strictEqual(service.getAccountStatus().isLoggedIn, true)
    assert.strictEqual(
      data.get('qqMusicAccount').cookie,
      [
        'uin=oA',
        'qqmusic_key=scheduled-new-key',
        'psrf_musickey_createtime=200',
      ].join('; '),
    )
  }

  {
    const scheduler = createScheduler()
    const initial = {
      ...accountA,
      cookie: `${accountA.cookie}; psrf_musickey_createtime=10`,
    }
    const { data, service } = createFacade({
      initial,
      request: async() => [],
      refresh: async() => [
        'uin=oA',
        'qqmusic_key=same-creation-time-key',
        'psrf_musickey_createtime=10',
      ].join('; '),
      getRefreshDueAt: () => 50,
      now: () => 50,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    scheduler.timers[0].callback()
    await waitForTurn()
    assert.strictEqual(
      scheduler.timers.at(-1).delay,
      60 * 60 * 1000,
    )
    assert.strictEqual(scheduler.timers.at(-1).unrefed, true)
    assert.strictEqual(scheduler.timers.length, 2)
    assert.strictEqual(service.getAccountStatus().isLoggedIn, true)
    assert.strictEqual(
      data.get('qqMusicAccount').cookie,
      [
        'uin=oA',
        'qqmusic_key=same-creation-time-key',
        'psrf_musickey_createtime=10',
      ].join('; '),
    )
  }

  {
    const scheduler = createScheduler()
    const { service } = createFacade({
      request: async() => [],
      refresh: async() => accountA.cookie,
      getRefreshDueAt: () => 100,
      now: () => 50,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    const initialTimer = scheduler.timers[0]
    await service.logout()
    assert.strictEqual(initialTimer.cancelled, true)
    assert.strictEqual(service.getAccountStatus().isLoggedIn, false)
  }

  {
    const scheduler = createScheduler()
    const { services, service } = createFacade({
      initial: {
        cookie: '',
        profile: null,
        updatedAt: 0,
      },
      request: async() => [],
      refresh: async() => {
        throw new Error('unexpected refresh')
      },
      getRefreshDueAt: cookie =>
        cookie.includes('psrf_musickey_createtime=300') ? 900 : null,
      now: () => 400,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    assert.strictEqual(scheduler.timers.length, 0)
    services.loginService.checkLoginQr = async() => ({
      state: 'success',
      message: 'login success',
      cookie: [
        'uin=oC',
        'qqmusic_key=login-key',
        'psrf_musickey_createtime=300',
      ].join('; '),
    })
    await service.checkLoginQr('new-login')
    assert.strictEqual(scheduler.timers.length, 1)
    assert.strictEqual(scheduler.timers[0].delay, 500)
    assert.strictEqual(scheduler.timers[0].unrefed, true)
  }

  {
    const scheduler = createScheduler()
    const refreshDeferred = createDeferred()
    const authError = new QQMusicAuthError()
    let data
    const facade = createFacade({
      request: async() => {
        throw authError
      },
      refresh: async() => refreshDeferred.promise,
      getRefreshDueAt: cookie => {
        return cookie.includes('uin=oB') ? 900 : 800
      },
      now: () => 400,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    data = facade.data
    const pending = facade.service.getGuessLikeSongs()
    await waitForTurn()
    facade.services.loginService.checkLoginQr = async() => ({
      state: 'success',
      message: 'login success',
      cookie: [
        accountB.cookie,
        'psrf_musickey_createtime=300',
      ].join('; '),
    })
    await facade.service.checkLoginQr('new-login')
    assert.strictEqual(scheduler.timers.length, 2)
    assert.strictEqual(scheduler.timers[0].cancelled, true)
    assert.strictEqual(scheduler.timers[1].cancelled, false)
    assert.strictEqual(scheduler.timers[1].delay, 500)
    refreshDeferred.resolve('uin=oA; qqmusic_key=stale-key')
    await assert.rejects(pending, error => error === authError)
    assert.strictEqual(scheduler.timers.length, 2)
    assert.strictEqual(scheduler.timers[0].cancelled, true)
    assert.strictEqual(scheduler.timers[1].cancelled, false)
    assert.strictEqual(
      data.get('qqMusicAccount').cookie,
      `${accountB.cookie}; psrf_musickey_createtime=300`,
    )
  }

  {
    const scheduler = createScheduler()
    let data
    let services
    let service
    let loginPromise
    const refreshedCookie = [
      'uin=oA',
      'qqmusic_key=scheduled-race-key',
      'psrf_musickey_createtime=200',
    ].join('; ')
    const facade = createFacade({
      request: async() => [],
      refresh: async() => refreshedCookie,
      getRefreshDueAt: cookie => {
        if (cookie.includes('uin=oB')) return 900
        if (cookie.includes('scheduled-race-key')) return 500
        return 400
      },
      now: () => 400,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
      onRefreshDiagnostic: event => {
        if (event.outcome != 'success') return
        assert.strictEqual(
          data.get('qqMusicAccount').cookie,
          refreshedCookie,
        )
        services.loginService.checkLoginQr = async() => ({
          state: 'success',
          message: 'login success',
          cookie: [
            accountB.cookie,
            'psrf_musickey_createtime=300',
          ].join('; '),
        })
        loginPromise = service.checkLoginQr('post-refresh-login')
      },
    })
    ;({ data, services, service } = facade)
    scheduler.timers[0].callback()
    await waitForTurn()
    await loginPromise
    await waitForTurn()
    assert.strictEqual(
      data.get('qqMusicAccount').cookie,
      `${accountB.cookie}; psrf_musickey_createtime=300`,
    )
    assert.strictEqual(scheduler.timers[1].cancelled, false)
    assert.strictEqual(scheduler.timers[1].delay, 500)
    assert.strictEqual(scheduler.timers.length, 2)
  }

  {
    const scheduler = createScheduler()
    let requestCalls = 0
    let refreshCalls = 0
    const { service } = createFacade({
      request: async() => {
        requestCalls++
        return ['business-result']
      },
      refresh: async() => {
        refreshCalls++
        throw new QQMusicCredentialRefreshError('transient')
      },
      getRefreshDueAt: () => 50,
      now: () => 50,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    assert.deepStrictEqual(
      await service.getGuessLikeSongs(),
      ['business-result'],
    )
    assert.deepStrictEqual(
      await service.getGuessLikeSongs(),
      ['business-result'],
    )
    assert.strictEqual(refreshCalls, 1)
    assert.strictEqual(requestCalls, 2)
  }

  {
    const scheduler = createScheduler()
    let requestCalls = 0
    let refreshCalls = 0
    const refreshedCookie = [
      'uin=oA',
      'qqmusic_key=non-advancing-key',
      'psrf_musickey_createtime=10',
    ].join('; ')
    const initial = {
      ...accountA,
      cookie: `${accountA.cookie}; psrf_musickey_createtime=10`,
    }
    const { service } = createFacade({
      initial,
      request: async() => {
        requestCalls++
        return ['business-result']
      },
      refresh: async() => {
        refreshCalls++
        return refreshedCookie
      },
      getRefreshDueAt: () => 50,
      now: () => 50,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    assert.deepStrictEqual(
      await service.getGuessLikeSongs(),
      ['business-result'],
    )
    assert.deepStrictEqual(
      await service.getGuessLikeSongs(),
      ['business-result'],
    )
    assert.strictEqual(refreshCalls, 1)
    assert.strictEqual(requestCalls, 2)
  }

  {
    const scheduler = createScheduler()
    let requestCalls = 0
    let refreshCalls = 0
    const authError = new QQMusicAuthError()
    const { service } = createFacade({
      request: async() => {
        requestCalls++
        throw authError
      },
      refresh: async() => {
        refreshCalls++
        throw new QQMusicCredentialRefreshError('transient')
      },
      getRefreshDueAt: () => null,
      now: () => 50,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    await assert.rejects(
      service.getGuessLikeSongs(),
      error => error === authError,
    )
    await assert.rejects(
      service.getGuessLikeSongs(),
      error => error === authError,
    )
    assert.strictEqual(refreshCalls, 1)
    assert.strictEqual(requestCalls, 2)
    assert.strictEqual(scheduler.timers.length, 1)
    assert.strictEqual(scheduler.timers[0].delay, 60 * 60 * 1000)
  }

  {
    const scheduler = createScheduler()
    const { services, service } = createFacade({
      request: async() => [],
      refresh: async() => {
        throw new Error('unexpected refresh')
      },
      getRefreshDueAt: cookie => cookie.includes('uin=oB') ? 900 : 800,
      now: () => 400,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    const accountATimer = scheduler.timers[0]
    services.loginService.checkLoginQr = async() => ({
      state: 'success',
      message: 'login success',
      cookie: [
        accountB.cookie,
        'psrf_musickey_createtime=300',
      ].join('; '),
    })
    await service.checkLoginQr('replacement-login')
    const accountBTimer = scheduler.timers[1]
    assert.strictEqual(accountATimer.cancelled, true)
    assert.strictEqual(accountBTimer.cancelled, false)
    accountATimer.callback()
    await waitForTurn()
    assert.strictEqual(scheduler.timers.length, 2)
    await service.logout()
    assert.strictEqual(accountBTimer.cancelled, true)
  }

  {
    let requestCalls = 0
    const { data, service } = createFacade({
      request: async() => {
        requestCalls++
        if (requestCalls == 1) throw new QQMusicAuthError()
        return ['diagnostic-safe-result']
      },
      refresh: async() => 'uin=oA; qqmusic_key=diagnostic-safe-key',
      onRefreshDiagnostic: () => {
        throw new Error('diagnostic failure')
      },
    })
    let result
    await assert.doesNotReject(async() => {
      result = await service.getGuessLikeSongs()
    })
    assert.deepStrictEqual(result, ['diagnostic-safe-result'])
    assert.strictEqual(requestCalls, 2)
    assert.strictEqual(
      data.get('qqMusicAccount').cookie,
      'uin=oA; qqmusic_key=diagnostic-safe-key',
    )
  }

  {
    const scheduler = createScheduler()
    let unhandledRejection
    const scheduledError = new Error('scheduled continuation failure')
    const { data } = createFacade({
      request: async() => [],
      refresh: async() => 'uin=oA; qqmusic_key=scheduled-contained-key',
      getRefreshDueAt: cookie => {
        if (cookie.includes('scheduled-contained-key')) {
          throw scheduledError
        }
        return 50
      },
      now: () => 50,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    const onUnhandledRejection = error => {
      unhandledRejection = error
    }
    process.once('unhandledRejection', onUnhandledRejection)
    try {
      scheduler.timers[0].callback()
      await waitForTurn()
      await waitForTurn()
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection)
    }
    assert.strictEqual(unhandledRejection, undefined)
    assert.strictEqual(
      data.get('qqMusicAccount').cookie,
      'uin=oA; qqmusic_key=scheduled-contained-key',
    )
  }

  {
    const scheduler = createScheduler()
    const maxScheduleDelayMs = 2_147_483_647
    let currentNow = 100
    const setCurrentNow = value => {
      currentNow = value
    }
    let refreshCalls = 0
    const dueAt = currentNow + maxScheduleDelayMs + 500
    createFacade({
      request: async() => [],
      refresh: async() => {
        refreshCalls++
        return 'uin=oA; qqmusic_key=far-future-new-key'
      },
      getRefreshDueAt: () => dueAt,
      now: () => currentNow,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    assert.strictEqual(scheduler.timers[0].delay, maxScheduleDelayMs)
    setCurrentNow(100 + maxScheduleDelayMs)
    scheduler.timers[0].callback()
    await waitForTurn()
    assert.strictEqual(refreshCalls, 0)
    assert.strictEqual(scheduler.timers.length, 2)
    assert.strictEqual(scheduler.timers[1].delay, 500)
    setCurrentNow(50)
    scheduler.timers[1].callback()
    await waitForTurn()
    assert.strictEqual(refreshCalls, 0)
    assert.strictEqual(scheduler.timers.length, 3)
    assert.strictEqual(scheduler.timers[2].delay, maxScheduleDelayMs)
    setCurrentNow(dueAt)
    scheduler.timers[2].callback()
    await waitForTurn()
    assert.strictEqual(refreshCalls, 1)
  }

  {
    const scheduler = createScheduler()
    let currentNow = 50
    let refreshCalls = 0
    const { service } = createFacade({
      request: async() => ['business-result'],
      refresh: async() => {
        refreshCalls++
        throw new QQMusicCredentialRefreshError('transient')
      },
      getRefreshDueAt: () => 50,
      now: () => currentNow,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    })
    assert.deepStrictEqual(
      await service.getGuessLikeSongs(),
      ['business-result'],
    )
    assert.strictEqual(refreshCalls, 1)
    const retryTimer = scheduler.timers.at(-1)
    assert.strictEqual(retryTimer.delay, 60 * 60 * 1000)
    currentNow = 0
    retryTimer.callback()
    await waitForTurn()
    assert.strictEqual(refreshCalls, 1)
    assert.strictEqual(
      scheduler.timers.at(-1).delay,
      60 * 60 * 1000 + 50,
    )
  }
}

main().then(() => {
  console.log('QQ Music account refresh tests passed')
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
