const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const headers = ({ setCookie = [], location = null } = {}) => ({
  getSetCookie: () => setCookie,
  get: name => name.toLowerCase() == 'location' ? location : null,
})

const response = ({
  ok = true,
  status = 200,
  text = '',
  bytes = [1],
  setCookie = [],
  location = null,
} = {}) => ({
  ok,
  status,
  headers: headers({ setCookie, location }),
  text: async() => text,
  arrayBuffer: async() => Uint8Array.from(bytes).buffer,
})

const pendingUntilAbort = signal => new Promise((resolve, reject) => {
  const onAbort = () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    reject(error)
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
})

const withTestDeadline = (promise, timeoutMs = 200) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error('test deadline exceeded'))
  }, timeoutMs)
  promise.then(resolve, reject).finally(() => {
    clearTimeout(timer)
  })
})

const auth = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'),
)
const {
  createQQMusicLoginService,
  parseQQQrStatus,
} = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/login.ts'),
  { './auth': auth },
)

assert.deepStrictEqual(
  parseQQQrStatus("ptuiCB('66','0','','0','二维码未失效。','')"),
  { code: '66', redirectUrl: '' },
)
assert.deepStrictEqual(
  parseQQQrStatus("ptuiCB('67','0','','0','二维码认证中。','')"),
  { code: '67', redirectUrl: '' },
)
assert.deepStrictEqual(
  parseQQQrStatus("ptuiCB('65','0','','0','二维码已失效。','')"),
  { code: '65', redirectUrl: '' },
)

const runStatus = async(code, expectedState) => {
  const queue = [
    response({ bytes: [1, 2], setCookie: ['qrsig=qr-value; Path=/; HttpOnly'] }),
    response({ text: `ptuiCB('${code}','0','','0','status','')` }),
  ]
  const service = createQQMusicLoginService({
    fetchImpl: async() => queue.shift(),
  })
  const qr = await service.createLoginQr()
  const result = await service.checkLoginQr(qr.key)
  assert.strictEqual(result.state, expectedState)
  assert.strictEqual(Object.hasOwn(result, 'cookie'), false)
}

const assertSafeCheckFailure = error => {
  assert.strictEqual(error.message, 'QQ Music login check failed')
  assert.strictEqual(String(error).includes('evil.example'), false)
  assert.strictEqual(String(error).includes('oauth-code'), false)
  return true
}

const testRejectedCheckSigRedirect = async() => {
  const calls = []
  const queue = [
    response({ setCookie: ['qrsig=qr-evil-check-sig; Path=/'] }),
    response({
      text: "ptuiCB('0','0','https://evil.example/check_sig','0','status','')",
      setCookie: ['uin=o123; Path=/'],
    }),
  ]
  const service = createQQMusicLoginService({
    fetchImpl: async(input, init = {}) => {
      calls.push({ input, init })
      return queue.shift()
    },
  })
  const qr = await service.createLoginQr()
  await assert.rejects(service.checkLoginQr(qr.key), assertSafeCheckFailure)
  assert.strictEqual(calls.length, 2)
  assert.strictEqual(calls.some(call => String(call.input).includes('evil.example')), false)
  assert.deepStrictEqual(await service.checkLoginQr(qr.key), {
    state: 'expired',
    message: '二维码已过期',
  })
  assert.strictEqual(calls.length, 2)
}

const testRejectedOAuthCallback = async() => {
  const calls = []
  const queue = [
    response({ setCookie: ['qrsig=qr-evil-callback; Path=/'] }),
    response({
      text: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig','0','status','')",
      setCookie: ['uin=o123; Path=/'],
    }),
    response({ ok: false, status: 302, setCookie: ['p_skey=p-value; Path=/'] }),
    response({
      ok: false,
      status: 302,
      location: 'https://evil.example/callback?code=oauth-code',
    }),
  ]
  const service = createQQMusicLoginService({
    fetchImpl: async(input, init = {}) => {
      calls.push({ input, init })
      return queue.shift()
    },
  })
  const qr = await service.createLoginQr()
  await assert.rejects(service.checkLoginQr(qr.key), assertSafeCheckFailure)
  assert.strictEqual(calls.length, 4)
  assert.strictEqual(calls.some(call => String(call.input).includes('evil.example')), false)
  assert.deepStrictEqual(await service.checkLoginQr(qr.key), {
    state: 'expired',
    message: '二维码已过期',
  })
  assert.strictEqual(calls.length, 4)
}

const testRejectedIncompleteCredential = async() => {
  const queue = [
    response({ setCookie: ['qrsig=qr-incomplete; Path=/'] }),
    response({
      text: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig','0','status','')",
    }),
    response({ ok: false, status: 302, setCookie: ['p_skey=p-value; Path=/'] }),
    response({
      ok: false,
      status: 302,
      location: 'https://y.qq.com/portal/wx_redirect.html?code=oauth-code',
    }),
    response({ setCookie: ['qqmusic_key=key-without-uin; Path=/'] }),
  ]
  const service = createQQMusicLoginService({
    fetchImpl: async() => queue.shift(),
  })
  const qr = await service.createLoginQr()
  await assert.rejects(service.checkLoginQr(qr.key), assertSafeCheckFailure)
  assert.deepStrictEqual(await service.checkLoginQr(qr.key), {
    state: 'expired',
    message: '二维码已过期',
  })
}

const testPollingBodyTimeout = async() => {
  const queue = [
    async() => response({ setCookie: ['qrsig=qr-stalled-status; Path=/'] }),
    async(input, init) => ({
      ...response(),
      text: () => pendingUntilAbort(init.signal),
    }),
    async() => response({ text: "ptuiCB('66','0','','0','status','')" }),
  ]
  const service = createQQMusicLoginService({
    requestTimeoutMs: 10,
    fetchImpl: async(input, init = {}) => queue.shift()(input, init),
  })
  const qr = await service.createLoginQr()
  await assert.rejects(withTestDeadline(service.checkLoginQr(qr.key)), error => {
    assert.strictEqual(error.message, 'QQ Music login check failed')
    return true
  })
  assert.deepStrictEqual(await service.checkLoginQr(qr.key), {
    state: 'waiting',
    message: '等待扫码',
  })
}

const testQrBodyTimeout = async() => {
  const sessions = auth.createQrSessionStore({
    idFactory: () => 'stalled-qr-session',
  })
  const service = createQQMusicLoginService({
    sessions,
    requestTimeoutMs: 10,
    fetchImpl: async(input, init = {}) => ({
      ...response({ setCookie: ['qrsig=qr-stalled-image; Path=/'] }),
      arrayBuffer: () => pendingUntilAbort(init.signal),
    }),
  })
  await assert.rejects(withTestDeadline(service.createLoginQr()), error => {
    assert.strictEqual(error.message, 'QQ Music login QR creation failed')
    return true
  })
  assert.strictEqual(sessions.size(), 0)
}

const main = async() => {
  await runStatus('66', 'waiting')
  await runStatus('67', 'scanned')
  await runStatus('65', 'expired')
  await testRejectedCheckSigRedirect()
  await testRejectedOAuthCallback()
  await testRejectedIncompleteCredential()
  await testQrBodyTimeout()
  await testPollingBodyTimeout()

  const calls = []
  const queue = [
    response({ bytes: [1, 2], setCookie: ['qrsig=qr-success; Path=/; HttpOnly'] }),
    response({
      text: "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig','0','登录成功！','')",
      setCookie: ['uin=o123; Path=/'],
    }),
    response({ ok: false, status: 302, setCookie: ['p_skey=p-value; Path=/; HttpOnly'] }),
    response({
      ok: false,
      status: 302,
      location: 'https://y.qq.com/portal/wx_redirect.html?code=oauth-code',
      setCookie: ['graph_session=authorize-value; Path=/'],
    }),
    response({
      setCookie: [
        'qqmusic_key=music=value; Path=/; HttpOnly',
        'qqmusic_uin=123; Path=/',
      ],
    }),
  ]
  const service = createQQMusicLoginService({
    fetchImpl: async(input, init = {}) => {
      calls.push({ input, init })
      return queue.shift()
    },
  })

  const qr = await service.createLoginQr()
  assert.deepStrictEqual(Object.keys(qr).sort(), ['key', 'qrimg'])
  assert.strictEqual(qr.qrimg, 'data:image/png;base64,AQI=')

  const result = await service.checkLoginQr(qr.key)
  assert.deepStrictEqual(result, {
    state: 'success',
    message: '登录成功',
    cookie: 'uin=o123; p_skey=p-value; graph_session=authorize-value; qqmusic_key=music=value; qqmusic_uin=123',
  })
  assert.strictEqual(calls.length, 5)

  const qrUrl = new URL(calls[0].input)
  assert.strictEqual(qrUrl.origin + qrUrl.pathname, 'https://ssl.ptlogin2.qq.com/ptqrshow')
  assert.strictEqual(qrUrl.searchParams.get('appid'), '716027609')
  assert.strictEqual(qrUrl.searchParams.get('pt_3rd_aid'), '100497308')
  assert.strictEqual(qrUrl.searchParams.get('u1'), 'https://graph.qq.com/oauth2.0/login_jump')

  const statusUrl = new URL(calls[1].input)
  assert.strictEqual(statusUrl.origin + statusUrl.pathname, 'https://ssl.ptlogin2.qq.com/ptqrlogin')
  assert.strictEqual(statusUrl.searchParams.get('ptqrtoken'), String(auth.hash33('qr-success')))
  assert.strictEqual(statusUrl.searchParams.get('aid'), '716027609')
  assert.strictEqual(statusUrl.searchParams.get('daid'), '383')
  assert.strictEqual(statusUrl.searchParams.get('pt_3rd_aid'), '100497308')
  assert.deepStrictEqual(calls[1].init.headers, { Cookie: 'qrsig=qr-success' })

  assert.strictEqual(calls[2].input, 'https://ssl.ptlogin2.graph.qq.com/check_sig')
  assert.strictEqual(calls[2].init.redirect, 'manual')
  assert.strictEqual(calls[2].init.headers.Cookie, 'uin=o123')

  assert.strictEqual(calls[3].input, 'https://graph.qq.com/oauth2.0/authorize')
  assert.strictEqual(calls[3].init.method, 'POST')
  assert.strictEqual(calls[3].init.redirect, 'manual')
  assert.strictEqual(calls[3].init.headers.Cookie, 'uin=o123; p_skey=p-value')
  const authorizeBody = calls[3].init.body
  assert.strictEqual(authorizeBody.get('response_type'), 'code')
  assert.strictEqual(authorizeBody.get('client_id'), '100497308')
  assert.strictEqual(
    authorizeBody.get('redirect_uri'),
    'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/',
  )
  assert.strictEqual(authorizeBody.get('scope'), 'get_user_info,get_app_friends')
  assert.strictEqual(authorizeBody.get('state'), 'state')
  assert.strictEqual(authorizeBody.get('switch'), '')
  assert.strictEqual(authorizeBody.get('from_ptlogin'), '1')
  assert.strictEqual(authorizeBody.get('src'), '1')
  assert.strictEqual(authorizeBody.get('update_auth'), '1')
  assert.strictEqual(authorizeBody.get('openapi'), '1010_1030')
  assert.strictEqual(authorizeBody.get('g_tk'), String(auth.getGtk('p-value')))
  const authTime = authorizeBody.get('auth_time')
  assert.strictEqual(typeof authTime, 'string')
  assert.ok(authTime.length > 0)
  assert.strictEqual(Number.isNaN(Date.parse(authTime)), false)
  assert.match(authorizeBody.get('ui'), /^[0-9A-F]{8}-[0-9A-F]{4}-[1-5][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/)

  assert.strictEqual(calls[4].input, 'https://u.y.qq.com/cgi-bin/musicu.fcg')
  assert.strictEqual(calls[4].init.method, 'POST')
  assert.strictEqual(
    calls[4].init.headers.Cookie,
    'uin=o123; p_skey=p-value; graph_session=authorize-value',
  )
  assert.strictEqual(calls[4].init.headers['Content-Type'], 'application/x-www-form-urlencoded')
  const loginBody = JSON.parse(calls[4].init.body)
  assert.deepStrictEqual(loginBody, {
    comm: { g_tk: auth.getGtk('p-value'), platform: 'yqq', ct: 24, cv: 0 },
    req: {
      module: 'QQConnectLogin.LoginServer',
      method: 'QQLogin',
      param: { code: 'oauth-code' },
    },
  })

  const callCount = calls.length
  assert.deepStrictEqual(await service.checkLoginQr(qr.key), {
    state: 'expired',
    message: '二维码已过期',
  })
  assert.strictEqual(calls.length, callCount)
}

main().then(() => {
  console.log('QQ Music login tests passed')
}).catch(err => {
  console.error(err)
  process.exitCode = 1
})
