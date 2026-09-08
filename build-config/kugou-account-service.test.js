/* eslint-disable n/no-deprecated-api */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const typescript = require('typescript')

const root = path.resolve(__dirname, '..')
const previousLoader = require.extensions['.ts']
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText
  mod._compile(output, filename)
}

const { createKugouAccountService } = require(path.join(root, 'src/main/modules/kugouMusic/account.ts'))
require.extensions['.ts'] = previousLoader

const createFixture = (overrides = {}) => {
  let now = 0
  const saved = []
  const cleared = []
  let account = { cookie: null, status: { loggedIn: false, profile: null } }
  const accounts = {
    getStatus: () => ({ ...account.status }),
    getCookie: () => account.cookie,
    save: async(provider, input) => {
      saved.push({ provider, ...input })
      account = { cookie: input.cookie, status: { loggedIn: true, profile: input.profile } }
      return { persistence: 'encrypted' }
    },
    clear: async provider => {
      cleared.push(provider)
      account = { cookie: null, status: { loggedIn: false, profile: null } }
    },
  }
  const api = {
    loginQrKey: async() => ({ body: { data: { qrcode: 'upstream-key' } } }),
    loginQrCreate: async() => ({ body: { data: { base64: 'data:image/png;base64,QR' } } }),
    loginQrCheck: async() => ({ body: { data: { status: 1 } } }),
    userInfo: async() => ({ body: { data: { userid: '42', nickname: 'User', avatar: 'avatar' } } }),
    ...overrides,
  }
  const service = createKugouAccountService({ accounts, api, now: () => now, idFactory: () => 'internal-id' })
  return { service, accounts, api, saved, cleared, setNow: value => { now = value } }
}

test('creates an opaque QR and reports waiting/scanned/expired states', async() => {
  const fixture = createFixture({
    loginQrCheck: async() => ({ body: { data: { status: 2, msg: 'scanned' } } }),
  })
  const qr = await fixture.service.createLoginQr('request-1')
  assert.deepEqual(qr, { requestId: 'request-1', image: 'data:image/png;base64,QR' })
  assert.equal(JSON.stringify(qr).includes('upstream-key'), false)
  assert.equal((await fixture.service.checkLoginQr('request-1')).state, 'scanned')
  fixture.setNow(5 * 60 * 1000)
  assert.equal((await fixture.service.checkLoginQr('request-1')).state, 'expired')
})

test('reports waiting status and logout clears the account', async() => {
  const fixture = createFixture()
  await fixture.accounts.save('kugou', { cookie: 'old=1', profile: { userId: 'old', nickname: 'Old' }, updatedAtMs: 0 })
  await fixture.service.createLoginQr('request-1')
  assert.equal((await fixture.service.checkLoginQr('request-1')).state, 'waiting')
  await fixture.service.logout()
  assert.deepEqual(await fixture.service.getAccountStatus(), { isLoggedIn: false, profile: null })
  assert.deepEqual(fixture.cleared, ['kugou'])
})

test('saves merged cookie and public profile after QR success', async() => {
  const fixture = createFixture({
    loginQrCheck: async() => ({ body: { data: { status: 4, token: 'token=secret', userid: '42' } }, cookie: ['mid=7'] }),
    userInfo: async params => {
      assert.equal(params.cookie, 'mid=7;token=secret;userid=42')
      return { body: { data: { userid: '42', nickname: 'User', avatar: 'avatar' } } }
    },
  })
  await fixture.service.createLoginQr('request-1')
  assert.equal((await fixture.service.checkLoginQr('request-1')).isLoggedIn, true)
  assert.deepEqual(fixture.saved[0], {
    provider: 'kugou',
    cookie: 'mid=7;token=secret;userid=42',
    profile: { userId: '42', nickname: 'User', avatarUrl: 'avatar' },
    updatedAtMs: 0,
  })
})

test('uses the QR account id when the user detail response omits userid', async() => {
  const fixture = createFixture({
    loginQrCheck: async() => ({
      status: 200,
      body: { status: 1, error_code: 0, data: { status: 4, token: 'secret', userid: '42' } },
      cookie: ['token=secret', 'userid=42'],
    }),
    userInfo: async() => ({
      status: 200,
      body: { status: 1, error_code: 0, data: { nickname: 'User', pic: 'avatar' } },
      cookie: [],
    }),
  })

  await fixture.service.createLoginQr('request-1')
  const result = await fixture.service.checkLoginQr('request-1')

  assert.deepEqual(result, {
    code: 4,
    state: 'success',
    message: undefined,
    isLoggedIn: true,
    profile: { userId: '42', nickname: 'User', avatarUrl: 'avatar' },
  })
  assert.equal(fixture.accounts.getCookie('kugou'), 'token=secret;userid=42')
})

test('keeps existing account on transport errors and clears only explicit invalid account', async() => {
  const fixture = createFixture({
    loginQrCheck: async() => { throw new Error('transport token=secret userid=42') },
  })
  await fixture.accounts.save('kugou', { cookie: 'old=1', profile: { userId: 'old', nickname: 'Old' }, updatedAtMs: 0 })
  await fixture.service.createLoginQr('request-1')
  await assert.rejects(fixture.service.checkLoginQr('request-1'))
  assert.equal(fixture.accounts.getCookie('kugou'), 'old=1')

  const invalid = createFixture({
    loginQrCheck: async() => ({ body: { data: { status: 4, token: 'new', userid: '42' } } }),
    userInfo: async() => ({ body: { code: 401, msg: 'invalid account' } }),
  })
  await invalid.service.createLoginQr('request-1')
  await invalid.service.checkLoginQr('request-1')
  assert.deepEqual(invalid.cleared, ['kugou'])

  const rejectedInvalid = createFixture({
    loginQrCheck: async() => ({ body: { data: { status: 4, token: 'new', userid: '42' } } }),
    userInfo: async() => {
      throw Object.assign(new Error('invalid account'), {
        status: 502,
        body: { error_code: 401, msg: 'invalid account' },
      })
    },
  })
  await rejectedInvalid.service.createLoginQr('request-1')
  await rejectedInvalid.service.checkLoginQr('request-1')
  assert.deepEqual(rejectedInvalid.cleared, ['kugou'])
})

test('repeated request ids invalidate late checks and cancellation', async() => {
  let resolveCheck
  const fixture = createFixture({ loginQrCheck: async() => new Promise(resolve => { resolveCheck = resolve }) })
  await fixture.service.createLoginQr('request-1')
  const late = fixture.service.checkLoginQr('request-1')
  await fixture.service.createLoginQr('request-1')
  resolveCheck({ body: { data: { status: 4, token: 'late', userid: '42' } } })
  assert.equal((await late).state, 'expired')
  await fixture.service.cancelLoginQr('request-1')
  assert.equal((await fixture.service.checkLoginQr('request-1')).state, 'expired')
})

test('late user info cannot mutate after logout and redacts sensitive messages', async() => {
  let resolveInfo
  const fixture = createFixture({
    loginQrCheck: async() => ({ body: { data: { status: 4, token: 'secret', userid: '42' } } }),
    userInfo: async() => new Promise(resolve => { resolveInfo = resolve }),
  })
  await fixture.service.createLoginQr('request-1')
  const checking = fixture.service.checkLoginQr('request-1')
  await new Promise(resolve => setImmediate(resolve))
  await fixture.service.logout()
  resolveInfo({ body: { data: { userid: '42', nickname: 'User', avatar: '' } } })
  assert.equal((await checking).state, 'expired')
  assert.equal(fixture.saved.length, 0)

  const redacted = createFixture({ loginQrCheck: async() => ({ body: { data: { status: 2, msg: 'token=secret userid=42 qrcode=key' } } }) })
  await redacted.service.createLoginQr('request-1')
  const result = await redacted.service.checkLoginQr('request-1')
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(JSON.stringify(result).includes('key'), false)
})

test('late rejected checks return expired after cancellation', async() => {
  let rejectCheck
  const fixture = createFixture({ loginQrCheck: async() => new Promise((_resolve, reject) => { rejectCheck = reject }) })
  await fixture.service.createLoginQr('request-1')
  const checking = fixture.service.checkLoginQr('request-1')
  await new Promise(resolve => setImmediate(resolve))
  await fixture.service.cancelLoginQr('request-1')
  rejectCheck(new Error('transport token=secret'))
  assert.equal((await checking).state, 'expired')
})

test('stale deferred save is rolled back after cancellation', async() => {
  let resolveSave
  const fixture = createFixture({
    loginQrCheck: async() => ({ body: { data: { status: 4, token: 'secret', userid: '42' } } }),
    userInfo: async() => ({ body: { data: { userid: '42', nickname: 'User', avatar: '' } } }),
  })
  const originalSave = fixture.accounts.save
  fixture.accounts.save = async(provider, input) => {
    await new Promise(resolve => { resolveSave = resolve })
    return originalSave(provider, input)
  }
  await fixture.service.createLoginQr('request-1')
  const checking = fixture.service.checkLoginQr('request-1')
  await new Promise(resolve => setImmediate(resolve))
  await fixture.service.cancelLoginQr('request-1')
  resolveSave()
  assert.equal((await checking).state, 'expired')
  assert.equal(fixture.accounts.getCookie('kugou'), null)
})

test('late save cannot resurrect an account after logout', async() => {
  const fixture = createFixture({
    loginQrCheck: async() => ({ body: { data: { status: 4, token: 'new', userid: '42' } } }),
    userInfo: async() => ({ body: { data: { userid: '42', nickname: 'New', avatar: '' } } }),
  })
  await fixture.accounts.save('kugou', { cookie: 'old=1', profile: { userId: 'old', nickname: 'Old' }, updatedAtMs: 0 })
  const originalSave = fixture.accounts.save
  let resolveSave
  fixture.accounts.save = async(provider, input) => {
    await new Promise(resolve => { resolveSave = resolve })
    return originalSave(provider, input)
  }
  await fixture.service.createLoginQr('request-1')
  const checking = fixture.service.checkLoginQr('request-1')
  await new Promise(resolve => setImmediate(resolve))
  await fixture.service.logout()
  resolveSave()
  assert.equal((await checking).state, 'expired')
  assert.equal(fixture.accounts.getCookie('kugou'), null)
})
