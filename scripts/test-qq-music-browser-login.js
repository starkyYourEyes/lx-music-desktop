const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const requestId = sequence =>
  `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`

const lifecycleId = requestId(1)
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

const createTimers = () => {
  const timers = new Map()
  let nextId = 1
  return {
    setTimer(callback, delay) {
      const id = nextId++
      timers.set(id, { callback, delay })
      return id
    },
    clearTimer(id) {
      timers.delete(id)
    },
    runByDelay(delay) {
      const match = [...timers.entries()]
        .find(([, timer]) => timer.delay == delay)
      assert.ok(match, `expected a ${delay} ms timer`)
      timers.delete(match[0])
      match[1].callback()
    },
    count() {
      return timers.size
    },
  }
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
  const expired = createSession([
    { state: 'expired', message: '二维码已过期' },
  ])
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => expired.session,
    getProxy: () => null,
    onDiagnostic: () => {},
  })
  const expiredId = requestId(2)

  await service.createLoginQr(expiredId, Date.now())
  assert.deepEqual(await service.checkLoginQr(expiredId), {
    state: 'expired',
    message: '二维码已过期',
  })
  assert.equal(expired.getDestroyCount(), 1)
  assert.deepEqual(await service.checkLoginQr(expiredId), {
    state: 'expired',
    message: '二维码已失效，请重新获取',
  })
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

const testExpiryTimerDisposesWithoutPolling = async() => {
  const timers = createTimers()
  const fake = createSession([])
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => fake.session,
    getProxy: () => null,
    ttlMs: 100,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onDiagnostic: () => {},
  })
  const id = requestId(30)

  await service.createLoginQr(id, Date.now())
  timers.runByDelay(100)
  assert.equal(fake.getDestroyCount(), 1)
  assert.deepEqual(await service.checkLoginQr(id), {
    state: 'expired',
    message: '二维码已失效，请重新获取',
  })
}

const testTransientFailuresExpireOnThirdConsecutiveError = async() => {
  const fake = createSession([
    new Error('temporary-1'),
    new Error('temporary-2'),
    new Error('temporary-3'),
  ])
  const diagnostics = []
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => fake.session,
    getProxy: () => null,
    onDiagnostic: event => diagnostics.push(event),
  })
  const id = requestId(31)

  await service.createLoginQr(id, Date.now())
  await assert.rejects(service.checkLoginQr(id), /QQ Music login check failed/)
  await assert.rejects(service.checkLoginQr(id), /QQ Music login check failed/)
  assert.equal(fake.getDestroyCount(), 0)
  assert.deepEqual(await service.checkLoginQr(id), {
    state: 'expired',
    message: '二维码已失效，请重新获取',
  })
  assert.equal(fake.getDestroyCount(), 1)
  assert.doesNotMatch(JSON.stringify(diagnostics), /temporary-/)
}

const testSuccessfulCheckResetsFailureCount = async() => {
  const fake = createSession([
    new Error('temporary-1'),
    { state: 'waiting', message: '等待扫码' },
    new Error('temporary-2'),
    new Error('temporary-3'),
    { state: 'scanned', message: '等待手机确认' },
  ])
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => fake.session,
    getProxy: () => null,
    onDiagnostic: () => {},
  })
  const id = requestId(32)

  await service.createLoginQr(id, Date.now())
  await assert.rejects(service.checkLoginQr(id), /QQ Music login check failed/)
  assert.equal((await service.checkLoginQr(id)).state, 'waiting')
  await assert.rejects(service.checkLoginQr(id), /QQ Music login check failed/)
  await assert.rejects(service.checkLoginQr(id), /QQ Music login check failed/)
  assert.equal((await service.checkLoginQr(id)).state, 'scanned')
  assert.equal(fake.getDestroyCount(), 0)
  await service.cancelLoginQr(id)
}

const testDisposeAllCleansEveryStateOnce = async() => {
  const first = createSession([])
  const second = createSession([])
  const sessions = [first.session, second.session]
  const timers = createTimers()
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => sessions.shift(),
    getProxy: () => null,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onDiagnostic: () => {},
  })
  const activeId = requestId(33)
  const tombstoneId = requestId(34)
  await service.createLoginQr(activeId, Date.now())
  await service.cancelLoginQr(tombstoneId)
  await service.disposeAll()
  await service.disposeAll()
  assert.equal(first.getDestroyCount(), 1)
  assert.equal(timers.count(), 0)
  assert.deepEqual(await service.checkLoginQr(activeId), {
    state: 'expired',
    message: '二维码已失效，请重新获取',
  })

  assert.equal((await service.createLoginQr(tombstoneId, Date.now())).key, tombstoneId)
  await service.cancelLoginQr(tombstoneId)
  assert.equal(second.getDestroyCount(), 1)
  assert.equal(timers.count(), 0)
}

const testDisposeAllCancelsPendingAndDestroysLateAuth = async() => {
  const timers = createTimers()
  const authGate = deferred()
  const late = createSession([])
  let receivedOptions
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async options => {
      receivedOptions = options
      return authGate.promise
    },
    getProxy: () => null,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onDiagnostic: () => {},
  })
  const id = requestId(36)
  const creation = service.createLoginQr(id, Date.now())
  const rejected = assert.rejects(
    creation,
    /QQ Music login QR creation failed/,
  )
  await Promise.resolve()
  assert.ok(receivedOptions)

  await service.disposeAll()
  await rejected
  assert.equal(receivedOptions.signal.aborted, true)
  assert.equal(timers.count(), 0)

  authGate.resolve(late.session)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(late.getDestroyCount(), 1)
  assert.deepEqual(await service.checkLoginQr(id), {
    state: 'expired',
    message: '二维码已失效，请重新获取',
  })
  assert.equal(late.getDestroyCount(), 1)
  assert.equal(timers.count(), 0)
}

const testCancelledCheckCannotReturnSuccess = async() => {
  const checkResult = deferred()
  const fake = createSession([checkResult.promise])
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => fake.session,
    getProxy: () => null,
    onDiagnostic: () => {},
  })
  const id = requestId(35)
  await service.createLoginQr(id, Date.now())

  const checking = service.checkLoginQr(id)
  await service.cancelLoginQr(id)
  checkResult.resolve({
    state: 'success',
    message: '登录成功',
    cookie: 'uin=o123; qqmusic_key=must-not-escape',
  })
  const result = await checking

  assert.deepEqual(result, {
    state: 'expired',
    message: '二维码已失效，请重新获取',
  })
  assert.doesNotMatch(JSON.stringify(result), /cookie|must-not-escape/)
  assert.equal(fake.getDestroyCount(), 1)
}

const testLateFactoryRejectionIsOwnedAfterDisposeAll = async() => {
  const authGate = deferred()
  const unhandledRejections = []
  const handleUnhandledRejection = reason => {
    unhandledRejections.push(reason)
  }
  process.on('unhandledRejection', handleUnhandledRejection)

  try {
    const service = createQQMusicLoginService({
      createBrowserAuthSession: async() => authGate.promise,
      getProxy: () => null,
      onDiagnostic: () => {},
    })
    const creation = service.createLoginQr(requestId(37), Date.now())
    const rejected = assert.rejects(
      creation,
      /QQ Music login QR creation failed/,
    )
    await Promise.resolve()

    await service.disposeAll()
    await rejected
    authGate.reject(new Error('late factory rejection'))
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    assert.deepEqual(unhandledRejections, [])
  } finally {
    process.removeListener('unhandledRejection', handleUnhandledRejection)
  }
}

const testSyncCleanupAndDiagnosticErrorsAreContained = async() => {
  const timers = createTimers()
  let destroyCount = 0
  const service = createQQMusicLoginService({
    createBrowserAuthSession: async() => ({
      qrimg: 'data:image/png;base64,qr',
      check: async() => ({ state: 'waiting', message: '等待扫码' }),
      destroy: () => {
        destroyCount++
        throw new Error('synchronous cleanup detail')
      },
    }),
    getProxy: () => null,
    ttlMs: 100,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onDiagnostic: () => {
      throw new Error('synchronous diagnostic detail')
    },
  })
  const id = requestId(38)

  await service.createLoginQr(id, Date.now())
  timers.runByDelay(100)
  await service.disposeAll()

  assert.equal(destroyCount, 1)
  assert.equal(timers.count(), 0)
  assert.equal((await service.checkLoginQr(id)).state, 'expired')
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
  await testExpiryTimerDisposesWithoutPolling()
  await testTransientFailuresExpireOnThirdConsecutiveError()
  await testSuccessfulCheckResetsFailureCount()
  await testDisposeAllCleansEveryStateOnce()
  await testDisposeAllCancelsPendingAndDestroysLateAuth()
  await testCancelledCheckCannotReturnSuccess()
  await testLateFactoryRejectionIsOwnedAfterDisposeAll()
  await testSyncCleanupAndDiagnosticErrorsAreContained()
  console.log('QQ Music browser login service tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
