const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const requestId = sequence =>
  `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`

const lifecycleId = requestId(1)
const expiredId = requestId(2)
const failedId = requestId(3)
const firstReplacementId = requestId(4)
const secondReplacementId = requestId(5)
const invalidQrId = requestId(6)

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

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const withWatchdog = async(promise, timeoutMs, message) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
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
  })

  assert.deepStrictEqual(await service.createLoginQr(lifecycleId, Date.now()), {
    key: lifecycleId,
    qrimg: 'data:image/png;base64,qr',
  })
  assert.deepStrictEqual(await service.checkLoginQr(lifecycleId), {
    state: 'waiting',
    message: '等待扫码',
  })
  assert.deepStrictEqual(await service.checkLoginQr(lifecycleId), {
    state: 'scanned',
    message: '等待手机确认',
  })
  assert.deepStrictEqual(await service.checkLoginQr(lifecycleId), {
    state: 'success',
    message: '登录成功',
    cookie: 'uin=o123; qqmusic_key=secret',
  })
  assert.strictEqual(fake.getDestroyCount(), 1)
  assert.deepStrictEqual(await service.checkLoginQr(lifecycleId), {
    state: 'expired',
    message: '二维码已失效，请重新获取',
  })
  await service.cancelLoginQr(lifecycleId)
  await service.cancelLoginQr(lifecycleId)
  assert.equal(fake.getDestroyCount(), 1)
}

const testTerminalCleanup = async() => {
  const expired = createSession([{ state: 'expired', message: '二维码已过期' }])
  const failed = createSession([new Error('secret upstream detail')])
  const sessions = [expired.session, failed.session]
  const diagnostics = []
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => sessions.shift(),
    onDiagnostic: event => diagnostics.push(event),
  })

  await service.createLoginQr(expiredId, Date.now())
  assert.deepStrictEqual(await service.checkLoginQr(expiredId), {
    state: 'expired',
    message: '二维码已过期',
  })
  assert.strictEqual(expired.getDestroyCount(), 1)

  await service.createLoginQr(failedId, Date.now())
  await assert.rejects(service.checkLoginQr(failedId), error => {
    assert.strictEqual(error.message, 'QQ Music login check failed')
    assert.doesNotMatch(error.message, /secret|upstream/i)
    return true
  })
  assert.strictEqual(failed.getDestroyCount(), 1)
  const checkFailures = diagnostics.filter(
    event => event.stage == 'browser-auth-error',
  )
  assert.equal(checkFailures.length, 1)
  assert.equal(checkFailures[0].reason, 'check-failed')
  assert.equal(typeof checkFailures[0].elapsedMs, 'number')
  assert.equal(
    diagnostics.every(event => typeof event.elapsedMs == 'number'),
    true,
  )
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret|upstream/i)
}

const testExpiryAndReplacement = async() => {
  let now = 10
  const first = createSession([{ state: 'waiting', message: '等待扫码' }])
  const second = createSession([{ state: 'waiting', message: '等待扫码' }])
  const sessions = [first.session, second.session]
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => sessions.shift(),
    now: () => now,
    ttlMs: 100,
  })

  await service.createLoginQr(firstReplacementId, now)
  await service.createLoginQr(secondReplacementId, now)
  assert.strictEqual(first.getDestroyCount(), 1)
  now = 111
  assert.deepStrictEqual(await service.checkLoginQr(secondReplacementId), {
    state: 'expired',
    message: '二维码已失效，请重新获取',
  })
  assert.strictEqual(second.getDestroyCount(), 1)
}

const testInvalidQrCleanup = async() => {
  const invalid = createSession([], 'https://evil.example/qr.png')
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => invalid.session,
    onDiagnostic: () => {},
  })
  await assert.rejects(service.createLoginQr(invalidQrId, Date.now()), error => {
    assert.strictEqual(error.message, 'QQ Music login QR creation failed')
    return true
  })
  assert.strictEqual(invalid.getDestroyCount(), 1)
}

const testCancelPendingAndDestroyLateResult = async() => {
  const pendingSession = deferred()
  const fake = createSession([])
  let receivedOptions
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async options => {
      receivedOptions = options
      return pendingSession.promise
    },
    getProxy: () => null,
    onDiagnostic: () => {},
  })
  const id = requestId(10)
  const startedAt = Date.now()

  const creation = service.createLoginQr(id, startedAt)
  await Promise.resolve()
  assert.equal(receivedOptions.startedAt, startedAt)
  await service.cancelLoginQr(id)
  await service.cancelLoginQr(id)
  assert.equal(receivedOptions.signal.aborted, true)
  pendingSession.resolve(fake.session)
  await assert.rejects(creation, /QQ Music login QR creation failed/)
  assert.equal(fake.getDestroyCount(), 1)
  assert.deepEqual(await service.checkLoginQr(id), {
    state: 'expired',
    message: '二维码已失效，请重新获取',
  })
}

const testCancelBeforeCreateUsesTombstone = async() => {
  let factoryCalls = 0
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => {
      factoryCalls++
      throw new Error('must not allocate')
    },
    onDiagnostic: () => {},
  })
  const id = requestId(11)

  await service.cancelLoginQr(id)
  await service.cancelLoginQr(id)
  await assert.rejects(
    service.createLoginQr(id, Date.now()),
    /QQ Music login QR creation failed/,
  )
  assert.equal(factoryCalls, 0)
  await service.cancelLoginQr(id)
}

const testTombstonesExpireAndStayCapped = async() => {
  let now = 1_000
  let factoryCalls = 0
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => {
      factoryCalls++
      return createSession([]).session
    },
    getProxy: () => null,
    now: () => now,
    tombstoneTtlMs: 30,
    maxTombstones: 64,
    onDiagnostic: () => {},
  })

  for (let index = 1; index <= 65; index++) {
    await service.cancelLoginQr(requestId(100 + index))
  }

  const oldest = requestId(101)
  const newest = requestId(165)
  const oldestResult = await service.createLoginQr(oldest, now)
  assert.equal(oldestResult.key, oldest)
  assert.equal(factoryCalls, 1)
  await service.cancelLoginQr(oldest)

  await assert.rejects(
    service.createLoginQr(newest, now),
    /QQ Music login QR creation failed/,
  )
  assert.equal(factoryCalls, 1)

  const expiring = requestId(166)
  await service.cancelLoginQr(expiring)
  now += 31
  const result = await service.createLoginQr(expiring, now)
  assert.equal(result.key, expiring)
  assert.equal(factoryCalls, 2)
  await service.cancelLoginQr(expiring)
}

const testReplacementDestroysPreviousBeforeNewFactory = async() => {
  const first = createSession([])
  const second = createSession([])
  const firstCleanup = deferred()
  const destroyFirst = first.session.destroy
  first.session.destroy = async() => {
    await destroyFirst()
    await firstCleanup.promise
  }
  const sessions = [first.session, second.session]
  const observations = []
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => {
      observations.push(first.getDestroyCount())
      return sessions.shift()
    },
    getProxy: () => null,
    onDiagnostic: () => {},
  })

  const startedAt = Date.now()
  await service.createLoginQr(requestId(20), startedAt)
  const replacement = service.createLoginQr(requestId(21), startedAt + 1)
  try {
    await Promise.resolve()
    assert.deepEqual(observations, [0, 1])
    assert.equal(first.getDestroyCount(), 1)
    const created = await withWatchdog(
      replacement,
      250,
      'replacement waited for old partition cleanup',
    )
    assert.equal(created.key, requestId(21))
  } finally {
    firstCleanup.resolve()
    await replacement.catch(() => {})
  }
  await service.cancelLoginQr(requestId(21))
  await service.cancelLoginQr(requestId(21))
  assert.equal(second.getDestroyCount(), 1)
}

const testInvalidIdCannotReplaceCurrentAttempt = async() => {
  const fake = createSession([
    { state: 'waiting', message: '等待扫码' },
  ])
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => fake.session,
    getProxy: () => null,
    onDiagnostic: () => {},
  })
  const validId = requestId(22)
  await service.createLoginQr(validId, Date.now())

  await assert.rejects(
    service.createLoginQr('not-a-uuid', Date.now()),
    /QQ Music login QR creation failed/,
  )
  await assert.rejects(
    service.cancelLoginQr('NOT-A-UUID'),
    /QQ Music login QR creation failed/,
  )
  await assert.rejects(
    service.createLoginQr([validId], Date.now()),
    /QQ Music login QR creation failed/,
  )
  await assert.rejects(
    service.cancelLoginQr({ requestId: validId }),
    /QQ Music login QR creation failed/,
  )
  await assert.rejects(
    service.createLoginQr(
      'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      Date.now(),
    ),
    /QQ Music login QR creation failed/,
  )
  assert.equal(fake.getDestroyCount(), 0)
  assert.equal((await service.checkLoginQr(validId)).state, 'waiting')
  await service.cancelLoginQr(validId)
}

const testReplacementTeardownConsumesSharedDeadline = async() => {
  let now = 100
  let factoryCalls = 0
  const first = createSession([])
  const destroyFirst = first.session.destroy
  first.session.destroy = async() => {
    now = 116
    await destroyFirst()
  }
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => {
      factoryCalls++
      if (factoryCalls == 1) return first.session
      throw new Error('replacement must not allocate after deadline')
    },
    getProxy: () => null,
    now: () => now,
    createDeadlineMs: 15,
    onDiagnostic: () => {},
  })

  await service.createLoginQr(requestId(23), 100)
  await assert.rejects(
    service.createLoginQr(requestId(24), 100),
    /QQ Music login QR creation timed out/,
  )
  assert.equal(first.getDestroyCount(), 1)
  assert.equal(factoryCalls, 1)
}

const testDeadlineCrossedBeforeFactoryMicrotaskAllocatesNothing = async() => {
  let now = 100
  let factoryCalls = 0
  let nextTimerId = 1
  const timers = new Map()
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => {
      factoryCalls++
      return createSession([]).session
    },
    getProxy: () => null,
    now: () => now,
    setTimer: (callback, delay) => {
      const id = nextTimerId++
      timers.set(id, { callback, delay })
      return id
    },
    clearTimer: id => timers.delete(id),
    createDeadlineMs: 15,
    onDiagnostic: () => {},
  })
  const id = requestId(25)

  const creation = service.createLoginQr(id, 100)
  now = 116
  await assert.rejects(
    creation,
    /QQ Music login QR creation timed out/,
  )
  assert.equal(factoryCalls, 0)
  assert.equal(timers.size, 0)
  assert.equal((await service.checkLoginQr(id)).state, 'expired')
}

const testLateFactoryResultCannotBeatDelayedDeadlineTimer = async() => {
  let now = 100
  let nextTimerId = 1
  const timers = new Map()
  const authGate = deferred()
  const late = createSession([])
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => authGate.promise,
    getProxy: () => null,
    now: () => now,
    setTimer: (callback, delay) => {
      const id = nextTimerId++
      timers.set(id, { callback, delay })
      return id
    },
    clearTimer: id => timers.delete(id),
    createDeadlineMs: 15,
    onDiagnostic: () => {},
  })

  const creation = service.createLoginQr(requestId(26), 100)
  await Promise.resolve()
  now = 116
  authGate.resolve(late.session)
  await assert.rejects(
    creation,
    /QQ Music login QR creation timed out/,
  )
  assert.equal(late.getDestroyCount(), 1)
  assert.equal(timers.size, 0)
  assert.deepEqual(await service.checkLoginQr(requestId(26)), {
    state: 'expired',
    message: '二维码已失效，请重新获取',
  })
}

const main = async() => {
  await testLifecycle()
  await testTerminalCleanup()
  await testExpiryAndReplacement()
  await testInvalidQrCleanup()
  await testCancelPendingAndDestroyLateResult()
  await testCancelBeforeCreateUsesTombstone()
  await testTombstonesExpireAndStayCapped()
  await testReplacementDestroysPreviousBeforeNewFactory()
  await testInvalidIdCannotReplaceCurrentAttempt()
  await testReplacementTeardownConsumesSharedDeadline()
  await testDeadlineCrossedBeforeFactoryMicrotaskAllocatesNothing()
  await testLateFactoryResultCannotBeatDelayedDeadlineTimer()
  console.log('QQ Music browser login service tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
