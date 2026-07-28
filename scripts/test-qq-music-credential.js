const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const auth = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'),
)
const requestHelpers = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/request.ts'),
)
const credential = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/credential.ts'),
  {
    './auth': auth,
    './request': requestHelpers,
  },
)

const {
  createQQMusicCredentialService,
  getQQMusicCredentialRefreshDueAt,
  isQQMusicCredentialRefreshError,
} = credential

const baseCookie = [
  'uin=o123',
  'qqmusic_key=old-key',
  'qm_keyst=old-key',
  'psrf_qqopenid=openid-old',
  'psrf_qqunionid=union-old',
  'psrf_qqaccess_token=access-old',
  'psrf_qqrefresh_token=refresh-old',
  'psrf_access_token_expiresAt=12345',
  'psrf_musickey_createtime=100',
  'euin=encrypted-old',
  'refresh_key=refresh-key-old',
  'keep=value=with=equals',
].join('; ')

const response = payload => ({
  ok: true,
  status: 200,
  json: async() => payload,
})

const expectRefreshError = async(promise, kind) => {
  await assert.rejects(promise, error => {
    assert.strictEqual(isQQMusicCredentialRefreshError(error), true)
    assert.strictEqual(error.kind, kind)
    assert.doesNotMatch(String(error), /access-old|refresh-old|secret-upstream/)
    return true
  })
}

const main = async() => {
  let captured
  const service = createQQMusicCredentialService({
    fetchImpl: async(url, options) => {
      captured = { url: String(url), options }
      return response({
        code: 0,
        req_0: {
          code: 0,
          data: {
            openid: 'openid-new',
            unionid: 'union-new',
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            musickey: 'music=new=value',
            musickeyCreateTime: 200,
            expired_at: 54321,
            encryptUin: 'encrypted-new',
            refresh_key: 'refresh-key-new',
            login_type: 1,
            loginType: 2,
            musicid: 123,
          },
        },
      })
    },
  })

  const refreshed = await service.refresh(baseCookie)
  assert.strictEqual(captured.url, 'https://u.y.qq.com/cgi-bin/musicu.fcg')
  assert.strictEqual(captured.options.method, 'POST')
  assert.strictEqual(captured.options.headers.Cookie, baseCookie)
  assert.strictEqual(captured.options.headers.Origin, 'https://y.qq.com')
  assert.strictEqual(captured.options.headers.Referer, 'https://y.qq.com/')

  const body = JSON.parse(captured.options.body)
  assert.strictEqual(body.req_0.module, 'music.login.LoginServer')
  assert.strictEqual(body.req_0.method, 'Login')
  assert.strictEqual(body.req_0.param.appid, 100497308)
  assert.strictEqual(body.req_0.param.musicid, 123)
  assert.strictEqual(body.req_0.param.str_musicid, '123')
  assert.strictEqual(body.req_0.param.musickey, 'old-key')
  assert.strictEqual(body.req_0.param.access_token, 'access-old')
  assert.strictEqual(body.req_0.param.refresh_token, 'refresh-old')
  assert.strictEqual(body.req_0.param.openid, 'openid-old')
  assert.strictEqual(body.req_0.param.refresh_key, 'refresh-key-old')
  assert.strictEqual(body.req_0.param.forceRefreshToken, 0)
  assert.strictEqual(body.req_0.param.musickeyCreateTime, 100)
  assert.strictEqual(body.req_0.param.encryptUin, 'encrypted-old')
  assert.strictEqual(body.comm.psrf_qqaccess_token, 'access-old')
  assert.strictEqual(body.comm.psrf_qqopenid, 'openid-old')
  assert.strictEqual(body.comm.psrf_qqunionid, 'union-old')

  assert.strictEqual(auth.getCookieValue(refreshed, 'qqmusic_key'), 'music=new=value')
  assert.strictEqual(auth.getCookieValue(refreshed, 'qm_keyst'), 'music=new=value')
  assert.strictEqual(auth.getCookieValue(refreshed, 'psrf_qqopenid'), 'openid-new')
  assert.strictEqual(auth.getCookieValue(refreshed, 'psrf_qqunionid'), 'union-new')
  assert.strictEqual(auth.getCookieValue(refreshed, 'psrf_qqaccess_token'), 'access-new')
  assert.strictEqual(auth.getCookieValue(refreshed, 'psrf_qqrefresh_token'), 'refresh-new')
  assert.strictEqual(auth.getCookieValue(refreshed, 'psrf_musickey_createtime'), '200')
  assert.strictEqual(auth.getCookieValue(refreshed, 'psrf_access_token_expiresAt'), '54321')
  assert.strictEqual(auth.getCookieValue(refreshed, 'euin'), 'encrypted-new')
  assert.strictEqual(auth.getCookieValue(refreshed, 'refresh_key'), 'refresh-key-new')
  assert.strictEqual(auth.getCookieValue(refreshed, 'login_type'), '1')
  assert.strictEqual(auth.getCookieValue(refreshed, 'tmeLoginType'), '2')
  assert.strictEqual(auth.getCookieValue(refreshed, 'uin'), 'o123')
  assert.strictEqual(auth.getCookieValue(refreshed, 'keep'), 'value=with=equals')

  const fallbackExpiryService = createQQMusicCredentialService({
    fetchImpl: async() => response({
      code: 0,
      req_0: {
        code: 0,
        data: {
          musickey: 'new-key',
          musicid: 123,
          expired_at: 0,
          expired_in: 67890,
        },
      },
    }),
  })
  const refreshedWithFallbackExpiry = await fallbackExpiryService.refresh(baseCookie)
  assert.strictEqual(
    auth.getCookieValue(refreshedWithFallbackExpiry, 'psrf_access_token_expiresAt'),
    '67890',
  )

  const cookieWithOptionalRotations = [
    baseCookie,
    'login_type=old-login',
    'tmeLoginType=old-tme',
  ].join('; ')
  const malformedRotationsService = createQQMusicCredentialService({
    fetchImpl: async() => response({
      code: 0,
      req_0: {
        code: 0,
        data: {
          openid: { value: 'bad-openid' },
          unionid: ['bad-unionid'],
          access_token: { value: 'bad-access' },
          refresh_token: ['bad-refresh'],
          musickey: 'new-key',
          musickeyCreateTime: { value: 999 },
          expired_at: { value: 999 },
          expired_in: ['999'],
          encryptUin: { value: 'bad-euin' },
          refresh_key: ['bad-refresh-key'],
          login_type: { value: 9 },
          loginType: [9],
          musicid: 123,
        },
      },
    }),
  })
  const preservedRotations = await malformedRotationsService.refresh(
    cookieWithOptionalRotations,
  )
  assert.strictEqual(auth.getCookieValue(preservedRotations, 'qqmusic_key'), 'new-key')
  for (const [name, expected] of [
    ['psrf_qqopenid', 'openid-old'],
    ['psrf_qqunionid', 'union-old'],
    ['psrf_qqaccess_token', 'access-old'],
    ['psrf_qqrefresh_token', 'refresh-old'],
    ['psrf_musickey_createtime', '100'],
    ['psrf_access_token_expiresAt', '12345'],
    ['euin', 'encrypted-old'],
    ['refresh_key', 'refresh-key-old'],
    ['login_type', 'old-login'],
    ['tmeLoginType', 'old-tme'],
  ]) {
    assert.strictEqual(auth.getCookieValue(preservedRotations, name), expected)
  }

  assert.strictEqual(
    getQQMusicCredentialRefreshDueAt(baseCookie),
    100 * 1000 + 20 * 60 * 60 * 1000,
  )
  assert.strictEqual(getQQMusicCredentialRefreshDueAt(''), null)
  assert.strictEqual(
    getQQMusicCredentialRefreshDueAt('psrf_musickey_createtime=invalid'),
    null,
  )
  assert.strictEqual(
    getQQMusicCredentialRefreshDueAt(
      'uin=o123; qqmusic_key=old; psrf_musickey_createtime=100',
    ),
    null,
  )

  let missingFieldCalls = 0
  const missingFieldService = createQQMusicCredentialService({
    fetchImpl: async() => {
      missingFieldCalls++
      return response({})
    },
  })
  await expectRefreshError(
    missingFieldService.refresh('uin=o123; qqmusic_key=secret-upstream'),
    'unavailable',
  )
  await expectRefreshError(
    missingFieldService.refresh(baseCookie.replace('uin=o123', 'uin=invalid')),
    'unavailable',
  )
  for (const noncanonicalUin of ['1e3', '+123', '0x7b', '123.0', '0123']) {
    await expectRefreshError(
      missingFieldService.refresh(
        baseCookie.replace('uin=o123', `uin=${noncanonicalUin}`),
      ),
      'unavailable',
    )
  }
  assert.strictEqual(missingFieldCalls, 0)

  for (const code of [1000, 104400, 104401]) {
    const invalidService = createQQMusicCredentialService({
      fetchImpl: async() => response({
        code: 0,
        req_0: { code, data: { message: 'secret-upstream' } },
      }),
    })
    await expectRefreshError(invalidService.refresh(baseCookie), 'invalid')
  }

  const topLevelAmbiguousService = createQQMusicCredentialService({
    fetchImpl: async() => response({
      code: 1000,
      req_0: { code: 0, data: { message: 'secret-upstream' } },
    }),
  })
  await expectRefreshError(
    topLevelAmbiguousService.refresh(baseCookie),
    'transient',
  )

  for (const payload of [
    {
      code: false,
      req_0: { code: 0, data: { musickey: 'new-key', musicid: 123 } },
    },
    {
      code: '',
      req_0: { code: 0, data: { musickey: 'new-key', musicid: 123 } },
    },
    {
      code: '0',
      req_0: { code: 0, data: { musickey: 'new-key', musicid: 123 } },
    },
    {
      code: 0,
      req_0: { code: false, data: { musickey: 'new-key', musicid: 123 } },
    },
    {
      code: 0,
      req_0: { code: '', data: { musickey: 'new-key', musicid: 123 } },
    },
    {
      code: 0,
      req_0: { code: '0', data: { musickey: 'new-key', musicid: 123 } },
    },
    {
      code: 0,
      req_0: { code: '1000', data: { musickey: 'new-key', musicid: 123 } },
    },
  ]) {
    const malformedCodeService = createQQMusicCredentialService({
      fetchImpl: async() => response(payload),
    })
    await expectRefreshError(
      malformedCodeService.refresh(baseCookie),
      'transient',
    )
  }

  for (const musickey of [
    {},
    ['bad-key'],
    0,
    123,
    '0',
  ]) {
    const malformedKeyService = createQQMusicCredentialService({
      fetchImpl: async() => response({
        code: 0,
        req_0: {
          code: 0,
          data: { musickey, musicid: 123 },
        },
      }),
    })
    await expectRefreshError(
      malformedKeyService.refresh(baseCookie),
      'transient',
    )
  }

  for (const payload of [
    { code: 104604, req_0: { code: 104604 } },
    { code: 0, req_0: { code: 20279 } },
    { code: 0, req_0: { code: 0, data: {} } },
    { code: 0, req_0: { code: 0, data: { musickey: '   ', musicid: 123 } } },
    {
      code: 0,
      req_0: {
        code: 0,
        data: { musickey: 'new-key', musicid: 999 },
      },
    },
    {
      code: 0,
      req_0: {
        code: 0,
        data: { musickey: 'new-key', str_musicid: '', musicid: 999 },
      },
    },
  ]) {
    const transientService = createQQMusicCredentialService({
      fetchImpl: async() => response(payload),
    })
    await expectRefreshError(transientService.refresh(baseCookie), 'transient')
  }

  const httpService = createQQMusicCredentialService({
    fetchImpl: async() => ({ ok: false, status: 429 }),
  })
  await expectRefreshError(httpService.refresh(baseCookie), 'transient')

  const malformedService = createQQMusicCredentialService({
    fetchImpl: async() => ({
      ok: true,
      status: 200,
      json: async() => {
        throw new Error('secret-upstream')
      },
    }),
  })
  await expectRefreshError(malformedService.refresh(baseCookie), 'transient')

  const networkService = createQQMusicCredentialService({
    fetchImpl: async() => {
      throw new Error('secret-upstream')
    },
  })
  await expectRefreshError(networkService.refresh(baseCookie), 'transient')

  let bodyAbortCalls = 0
  const bodyStallService = createQQMusicCredentialService({
    timeoutMs: 0,
    fetchImpl: async(_url, options) => ({
      ok: true,
      status: 200,
      json: async() => {
        return new Promise((_resolve, reject) => {
          const watchdog = setTimeout(() => {
            reject(new Error('body response did not time out'))
          }, 25)
          options.signal.addEventListener('abort', () => {
            bodyAbortCalls++
            clearTimeout(watchdog)
            reject(new Error('secret-upstream'))
          }, { once: true })
        })
      },
    }),
  })
  await expectRefreshError(bodyStallService.refresh(baseCookie), 'transient')
  assert.strictEqual(bodyAbortCalls, 1)

  let fetchAbortCalls = 0
  const timeoutService = createQQMusicCredentialService({
    timeoutMs: 0,
    fetchImpl: async(_url, options) => {
      return new Promise((_resolve, reject) => {
        const watchdog = setTimeout(() => {
          reject(new Error('fetch request did not time out'))
        }, 25)
        options.signal.addEventListener('abort', () => {
          fetchAbortCalls++
          clearTimeout(watchdog)
          reject(new Error('secret-upstream'))
        }, { once: true })
      })
    },
  })
  await expectRefreshError(timeoutService.refresh(baseCookie), 'transient')
  assert.strictEqual(fetchAbortCalls, 1)

  console.log('QQ Music credential refresh tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
