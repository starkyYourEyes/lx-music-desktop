const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

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

const main = async() => {
  await runStatus('66', 'waiting')
  await runStatus('67', 'scanned')
  await runStatus('65', 'expired')

  const calls = []
  const queue = [
    response({ bytes: [1, 2], setCookie: ['qrsig=qr-success; Path=/; HttpOnly'] }),
    response({
      text: "ptuiCB('0','0','https://graph.qq.com/check-sig','0','登录成功！','')",
      setCookie: ['uin=o123; Path=/'],
    }),
    response({ ok: false, status: 302, setCookie: ['p_skey=p-value; Path=/; HttpOnly'] }),
    response({
      ok: false,
      status: 302,
      location: 'https://y.qq.com/portal/wx_redirect.html?code=oauth-code',
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
    cookie: 'uin=o123; p_skey=p-value; qqmusic_key=music=value; qqmusic_uin=123',
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

  assert.strictEqual(calls[2].input, 'https://graph.qq.com/check-sig')
  assert.strictEqual(calls[2].init.redirect, 'manual')
  assert.strictEqual(calls[2].init.headers.Cookie, 'uin=o123')

  assert.strictEqual(calls[3].input, 'https://graph.qq.com/oauth2.0/authorize')
  assert.strictEqual(calls[3].init.method, 'POST')
  assert.strictEqual(calls[3].init.redirect, 'manual')
  assert.strictEqual(calls[3].init.headers.Cookie, 'uin=o123; p_skey=p-value')
  const authorizeBody = calls[3].init.body
  assert.strictEqual(authorizeBody.get('g_tk'), String(auth.getGtk('p-value')))
  assert.strictEqual(authorizeBody.get('client_id'), '100497308')
  assert.strictEqual(
    authorizeBody.get('redirect_uri'),
    'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/',
  )
  assert.strictEqual(authorizeBody.get('scope'), 'get_user_info,get_app_friends')

  assert.strictEqual(calls[4].input, 'https://u.y.qq.com/cgi-bin/musicu.fcg')
  assert.strictEqual(calls[4].init.method, 'POST')
  assert.strictEqual(calls[4].init.headers.Cookie, 'uin=o123; p_skey=p-value')
  assert.strictEqual(calls[4].init.headers['Content-Type'], 'application/x-www-form-urlencoded')
  const loginBody = JSON.parse(calls[4].init.body)
  assert.strictEqual(loginBody.req.module, 'QQConnectLogin.LoginServer')
  assert.strictEqual(loginBody.req.method, 'QQLogin')
  assert.strictEqual(loginBody.req.param.code, 'oauth-code')

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
