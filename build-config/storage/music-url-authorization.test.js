const assert = require('node:assert/strict')
const path = require('node:path')
const { describe, it } = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const root = path.resolve(__dirname, '../..')

const deferred = () => {
  let resolveDeferred
  let rejectDeferred
  const promise = new Promise((resolve, reject) => {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return { promise, resolve: resolveDeferred, reject: rejectDeferred }
}

const loadAuthorizationModule = () => {
  const cacheValidation = loadTsModule(path.join(root, 'src/common/storage/cacheValidation.ts'))
  return loadTsModule(path.join(root, 'src/main/services/musicUrlAuthorization.ts'), {
    '@common/storage/cacheValidation': cacheValidation,
  })
}

const profiles = {
  wy: { userId: 7, nickname: 'N', avatarUrl: '' },
  tx: { uin: '8', nickname: 'Q' },
}

const accountProvider = provider => provider == 'wy' ? 'netease' : 'qq_music'

const createAuthorizationFixture = () => {
  const { createMusicUrlAuthorizationService } = loadAuthorizationModule()
  const events = []
  const storedProviders = []
  const accountsByProvider = new Map([
    ['netease', { cookie: 'netease-cookie', profile: profiles.wy }],
    ['qq_music', { cookie: 'qq-cookie', profile: profiles.tx }],
  ])
  const accounts = {
    getCookie(provider) {
      return accountsByProvider.get(provider)?.cookie ?? null
    },
    getStatus(provider) {
      const account = accountsByProvider.get(provider)
      return account == null
        ? { loggedIn: false, profile: null, updatedAtMs: null, persistence: null }
        : { loggedIn: true, profile: account.profile, updatedAtMs: 1, persistence: 'encrypted' }
    },
    async save(provider, account) {
      events.push('account.save')
      accountsByProvider.set(provider, { cookie: account.cookie, profile: account.profile })
    },
    async clear(provider) {
      events.push('account.clear')
      accountsByProvider.delete(provider)
    },
  }
  const invalidationResults = []
  const putStarted = deferred()
  const releasePut = deferred()
  let blockNextPut = false
  let workerPutCalls = 0
  const worker = {
    async musicUrlGet(input) {
      events.push({ get: structuredClone(input) })
      return { status: 'miss' }
    },
    async musicUrlPut(input) {
      workerPutCalls++
      events.push('put')
      if (blockNextPut) {
        blockNextPut = false
        putStarted.resolve()
        await releasePut.promise
      }
      storedProviders.push(input.provider)
      return { status: 'stored' }
    },
    async musicUrlInvalidateAccount(input) {
      events.push('invalidate')
      return invalidationResults.shift() ?? { status: 'completed', deletedRows: 1 }
    },
  }
  const service = createMusicUrlAuthorizationService({ accounts, worker })
  const put = (authorization, extra = {}) => ({
    authorization,
    sourceTrackId: 'track',
    quality: '320k',
    url: 'https://media.invalid/audio',
    nowMs: 1,
    ...extra,
  })
  const replaceSameAccount = async() => {
    const provider = accountProvider('tx')
    const current = accountsByProvider.get(provider)
    await accounts.save(provider, { ...current, updatedAtMs: 2 })
    return { status: 'changed', value: undefined }
  }
  return {
    accounts,
    accountsByProvider,
    events,
    invalidationResults,
    put,
    putStarted,
    releasePut,
    replaceSameAccount,
    service,
    storedProviders,
    worker,
    get workerPutCalls() { return workerPutCalls },
    blockNextPut() { blockNextPut = true },
  }
}

describe('music URL authorization wire contracts', () => {
  it('accepts only exact nested authorization DTOs and rejects the legacy flat shape', () => {
    const validation = loadTsModule(path.join(root, 'src/common/storage/cacheValidation.ts'))
    const authorization = {
      version: 1,
      provider: 'wy',
      accountScope: 'profile-v1:user-id:7',
      generation: 1,
    }
    assert.deepEqual(validation.parseMusicUrlAuthorizationRequest({ provider: 'wy' }), { provider: 'wy' })
    assert.deepEqual(validation.parseAuthorizedMusicUrlGetInput({
      authorization,
      sourceTrackId: 'track',
      quality: '320k',
      nowMs: 1,
    }), {
      authorization,
      sourceTrackId: 'track',
      quality: '320k',
      nowMs: 1,
    })
    assert.throws(() => validation.parseAuthorizedMusicUrlGetInput({
      provider: 'wy',
      accountScope: 'profile-v1:user-id:7',
      sourceTrackId: 'track',
      quality: '320k',
      nowMs: 1,
    }), error => error?.code == 'music_url_input_invalid')
  })

  it('rejects unsafe generations, noncanonical scopes and extra authorization fields', () => {
    const validation = loadTsModule(path.join(root, 'src/common/storage/cacheValidation.ts'))
    for (const authorization of [
      { version: 1, provider: 'wy', accountScope: 'profile-v1:user-id:7', generation: 0 },
      { version: 1, provider: 'wy', accountScope: 'profile-v1:user-id:07', generation: 1 },
      { version: 1, provider: 'tx', accountScope: 'profile-v1:uin:8', generation: Number.MAX_SAFE_INTEGER + 1 },
      { version: 1, provider: 'tx', accountScope: 'profile-v1:uin:8', generation: 1, cookie: 'secret' },
    ]) {
      assert.throws(() => validation.parseMusicUrlAuthorization(authorization), error => error?.code == 'music_url_input_invalid')
    }
  })
})

describe('main-owned music URL account generations', () => {
  it('removes a write committed before a transition through awaited invalidation', async() => {
    const fixture = createAuthorizationFixture()
    const authorization = await fixture.service.authorize('wy')
    fixture.blockNextPut()
    const writing = fixture.service.write(fixture.put(authorization))
    await fixture.putStarted.promise
    const transition = fixture.service.transition('wy', async() => {
      await fixture.accounts.clear('netease')
      return { status: 'changed', value: undefined }
    })
    fixture.releasePut.resolve()
    await Promise.all([writing, transition])
    assert.deepEqual(fixture.events, ['put', 'account.clear', 'invalidate'])
  })

  it('rejects a queued write after a transition advances the generation', async() => {
    const fixture = createAuthorizationFixture()
    const authorization = await fixture.service.authorize('tx')
    await fixture.service.transition('tx', fixture.replaceSameAccount)
    await assert.rejects(
      fixture.service.write(fixture.put(authorization)),
      error => error.code == 'music_url_authorization_stale',
    )
    assert.equal(fixture.workerPutCalls, 0)
  })

  it('persists current-generation writes without coupling the provider FIFOs', async() => {
    const fixture = createAuthorizationFixture()
    const wy = await fixture.service.authorize('wy')
    const tx = await fixture.service.authorize('tx')
    fixture.blockNextPut()
    const writingWy = fixture.service.write(fixture.put(wy))
    await fixture.putStarted.promise
    let txStored = false
    const writingTx = fixture.service.write(fixture.put(tx)).then(() => { txStored = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(txStored, true)
    fixture.releasePut.resolve()
    await Promise.all([writingWy, writingTx])
    assert.deepEqual(fixture.storedProviders.sort(), ['tx', 'wy'])
  })

  it('advances on logout, same-account relogin and replacement but not a rejected stale result', async() => {
    const fixture = createAuthorizationFixture()
    const first = await fixture.service.authorize('wy')
    await fixture.service.transition('wy', async() => {
      const current = fixture.accountsByProvider.get('netease')
      await fixture.accounts.save('netease', { ...current, updatedAtMs: 2 })
      return { status: 'changed', value: undefined }
    })
    const sameAccount = await fixture.service.authorize('wy')
    assert.equal(sameAccount.generation, first.generation + 1)
    await fixture.service.transition('wy', async() => {
      await fixture.accounts.save('netease', {
        cookie: 'replacement-cookie',
        profile: { userId: 9, nickname: 'R', avatarUrl: '' },
        updatedAtMs: 3,
      })
      return { status: 'changed', value: undefined }
    })
    const replacement = await fixture.service.authorize('wy')
    assert.equal(replacement.generation, sameAccount.generation + 1)
    assert.equal(replacement.accountScope, 'profile-v1:user-id:9')
    const staleValue = await fixture.service.transition('wy', async() => ({ status: 'unchanged', value: 'stale' }))
    assert.equal(staleValue, 'stale')
    assert.deepEqual(await fixture.service.authorize('wy'), replacement)
    await fixture.service.transition('wy', async() => {
      await fixture.accounts.clear('netease')
      return { status: 'changed', value: undefined }
    })
    assert.equal(await fixture.service.authorize('wy'), null)
    assert.equal(fixture.events.filter(event => event == 'invalidate').length, 3)
  })

  it('blocks authorization while an invalidation is unavailable and retries pending scopes', async() => {
    const fixture = createAuthorizationFixture()
    fixture.invalidationResults.push(
      { status: 'unavailable', code: 'cache_operation_failed' },
      { status: 'unavailable', code: 'cache_operation_failed' },
      { status: 'completed', deletedRows: 1 },
    )
    await fixture.service.transition('tx', fixture.replaceSameAccount)
    assert.equal(await fixture.service.authorize('tx'), null)
    const authorization = await fixture.service.authorize('tx')
    assert.equal(authorization.generation, 2)
    assert.equal(fixture.events.filter(event => event == 'invalidate').length, 3)
  })

  it('keeps pending invalidations across flush and waits for in-flight provider work', async() => {
    const fixture = createAuthorizationFixture()
    const authorization = await fixture.service.authorize('wy')
    fixture.blockNextPut()
    const writing = fixture.service.write(fixture.put(authorization))
    await fixture.putStarted.promise
    let flushed = false
    const flushing = fixture.service.flush().then(() => { flushed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(flushed, false)
    fixture.releasePut.resolve()
    await Promise.all([writing, flushing])

    fixture.invalidationResults.push(
      { status: 'unavailable', code: 'cache_operation_failed' },
      { status: 'completed', deletedRows: 1 },
    )
    await fixture.service.transition('wy', async() => {
      await fixture.accounts.clear('netease')
      return { status: 'changed', value: undefined }
    })
    await fixture.service.flush()
    assert.equal(await fixture.service.authorize('wy'), null)
    assert.equal(fixture.events.filter(event => event == 'invalidate').length, 2)
  })

  it('requires both a cookie and normalized profile before authorizing', async() => {
    const fixture = createAuthorizationFixture()
    fixture.accountsByProvider.set('netease', { cookie: '', profile: profiles.wy })
    assert.equal(await fixture.service.authorize('wy'), null)
    fixture.accountsByProvider.set('netease', { cookie: 'cookie', profile: { userId: 0, nickname: 'N', avatarUrl: '' } })
    assert.equal(await fixture.service.authorize('wy'), null)
    fixture.accountsByProvider.set('qq_music', { cookie: 'cookie', profile: { uin: '', nickname: 'Q' } })
    assert.equal(await fixture.service.authorize('tx'), null)
  })

  it('throws stale errors with fixed code and message and no request secrets', async() => {
    const fixture = createAuthorizationFixture()
    const authorization = await fixture.service.authorize('wy')
    await fixture.service.transition('wy', async() => ({ status: 'changed', value: undefined }))
    const secret = 'COOKIE_URL_PROFILE_PATH_SENTINEL'
    await assert.rejects(fixture.service.write(fixture.put(authorization, {
      sourceTrackId: secret,
      url: `https://media.invalid/${secret}`,
    })), error => {
      assert.equal(error.code, 'music_url_authorization_stale')
      assert.equal(error.message, 'music_url_authorization_stale')
      assert.equal(String(error).includes(secret), false)
      return true
    })
  })
})
