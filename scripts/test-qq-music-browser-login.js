const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const auth = loadTsModule(path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'))

const browserAuthModule = {
  createQQMusicBrowserAuthSession: async() => {
    throw new Error('unexpected default browser auth factory')
  },
}

const { createQQMusicLoginService } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/login.ts'),
  {
    './browserAuth': browserAuthModule,
    './auth': auth,
    '@main/utils': {
      getProxy: () => null,
    },
  },
)

const createSession = (checks, qrimg = 'data:image/png;base64,qr') => {
  let destroyCount = 0
  return {
    session: {
      qrimg,
      check: async() => {
        const next = checks.shift()
        if (next instanceof Error) throw next
        return next
      },
      destroy: async() => {
        destroyCount++
      },
    },
    getDestroyCount: () => destroyCount,
  }
}

const testLifecycle = async() => {
  const fake = createSession([
    { state: 'waiting', message: '等待扫码' },
    { state: 'scanned', message: '等待手机确认' },
    { state: 'success', message: '登录成功', cookie: 'uin=o123; qqmusic_key=secret' },
  ])
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => fake.session,
    idFactory: () => 'opaque-session-id',
  })

  assert.deepStrictEqual(await service.createLoginQr(), {
    key: 'opaque-session-id',
    qrimg: 'data:image/png;base64,qr',
  })
  assert.deepStrictEqual(await service.checkLoginQr('opaque-session-id'), {
    state: 'waiting',
    message: '等待扫码',
  })
  assert.deepStrictEqual(await service.checkLoginQr('opaque-session-id'), {
    state: 'scanned',
    message: '等待手机确认',
  })
  assert.deepStrictEqual(await service.checkLoginQr('opaque-session-id'), {
    state: 'success',
    message: '登录成功',
    cookie: 'uin=o123; qqmusic_key=secret',
  })
  assert.strictEqual(fake.getDestroyCount(), 1)
  assert.deepStrictEqual(await service.checkLoginQr('opaque-session-id'), {
    state: 'expired',
    message: '二维码已过期',
  })
}

const testTerminalCleanup = async() => {
  const expired = createSession([{ state: 'expired', message: '二维码已过期' }])
  const failed = createSession([new Error('secret upstream detail')])
  const sessions = [expired.session, failed.session]
  const diagnostics = []
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => sessions.shift(),
    idFactory: (() => {
      let id = 0
      return () => `session-${++id}`
    })(),
    onDiagnostic: event => diagnostics.push(event),
  })

  await service.createLoginQr()
  assert.deepStrictEqual(await service.checkLoginQr('session-1'), {
    state: 'expired',
    message: '二维码已过期',
  })
  assert.strictEqual(expired.getDestroyCount(), 1)

  await service.createLoginQr()
  await assert.rejects(service.checkLoginQr('session-2'), error => {
    assert.strictEqual(error.message, 'QQ Music login check failed')
    assert.doesNotMatch(error.message, /secret|upstream/i)
    return true
  })
  assert.strictEqual(failed.getDestroyCount(), 1)
  assert.deepStrictEqual(diagnostics, [{ stage: 'browser-auth-error', reason: 'check-failed' }])
}

const testExpiryAndReplacement = async() => {
  let now = 10
  const first = createSession([{ state: 'waiting', message: '等待扫码' }])
  const second = createSession([{ state: 'waiting', message: '等待扫码' }])
  const sessions = [first.session, second.session]
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => sessions.shift(),
    idFactory: (() => {
      let id = 0
      return () => `session-${++id}`
    })(),
    now: () => now,
    ttlMs: 100,
  })

  await service.createLoginQr()
  await service.createLoginQr()
  assert.strictEqual(first.getDestroyCount(), 1)
  now = 111
  assert.deepStrictEqual(await service.checkLoginQr('session-2'), {
    state: 'expired',
    message: '二维码已过期',
  })
  assert.strictEqual(second.getDestroyCount(), 1)
}

const testInvalidQrCleanup = async() => {
  const invalid = createSession([], 'https://evil.example/qr.png')
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => invalid.session,
    onDiagnostic: () => {},
  })
  await assert.rejects(service.createLoginQr(), error => {
    assert.strictEqual(error.message, 'QQ Music login QR creation failed')
    return true
  })
  assert.strictEqual(invalid.getDestroyCount(), 1)
}

const main = async() => {
  await testLifecycle()
  await testTerminalCleanup()
  await testExpiryAndReplacement()
  await testInvalidQrCleanup()
  console.log('QQ Music browser login service tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
