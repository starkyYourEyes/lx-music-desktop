const assert = require('node:assert/strict')
const fs = require('node:fs')
const { after, describe, it } = require('node:test')
const typescript = require('typescript')

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(output, filename)
}

const {
  createAccountRepository,
} = require('../../src/main/storage/accounts/accountRepository.ts')

after(() => {
  // eslint-disable-next-line n/no-deprecated-api
  delete require.extensions['.ts']
})

const credentialRefKey = ref => ref.kind

const createVault = (initial = {}) => {
  const entries = new Map(Object.entries(initial))
  return {
    read(ref) {
      const entry = entries.get(credentialRefKey(ref))
      return entry == null ? { status: 'missing' } : { ...entry }
    },
    async write(ref, value) {
      entries.set(credentialRefKey(ref), { status: 'available', value })
      return { persistence: 'encrypted' }
    },
    async remove(ref) {
      entries.delete(credentialRefKey(ref))
    },
    async verify(ref, expected) {
      return this.read(ref).value == expected
    },
  }
}

const createProfiles = (initial = {}) => {
  const rows = new Map(Object.entries(initial).map(([provider, row]) => [provider, { ...row }]))
  return {
    async getAccountProfile(provider) {
      const row = rows.get(provider)
      return row == null ? null : { ...row }
    },
    async upsertAccountProfile(row) {
      rows.set(row.provider, { ...row })
    },
    async removeAccountProfile(provider) {
      rows.delete(provider)
    },
  }
}

describe('account repository', () => {
  it('returns a secret-free account record after hydration', async() => {
    const vault = createVault({
      'netease-cookie': { status: 'available', value: 'COOKIE_SENTINEL' },
    })
    const profiles = createProfiles({
      netease: {
        provider: 'netease',
        profileJson: '{"avatarUrl":"https://example.test/a","nickname":"N","userId":1}',
        updatedAtMs: 10,
      },
    })
    const repository = createAccountRepository({ vault, profiles })

    await repository.hydrate()

    const status = repository.getStatus('netease')
    assert.deepEqual(status, {
      loggedIn: true,
      profile: { avatarUrl: 'https://example.test/a', nickname: 'N', userId: 1 },
      updatedAtMs: 10,
      persistence: 'encrypted',
    })
    assert.equal(Object.hasOwn(status, 'cookie'), false)
    assert.doesNotMatch(JSON.stringify(status), /COOKIE_SENTINEL/)
    assert.equal(repository.getCookie('netease'), 'COOKIE_SENTINEL')
  })

  it('logs out a hydrated provider whose allowed public profile field contains its cookie', async() => {
    const repository = createAccountRepository({
      vault: createVault({
        'netease-cookie': { status: 'available', value: 'COOKIE_SENTINEL' },
      }),
      profiles: createProfiles({
        netease: {
          provider: 'netease',
          profileJson: '{"avatarUrl":"","nickname":"prefix-COOKIE_SENTINEL-suffix","userId":1}',
          updatedAtMs: 10,
        },
      }),
    })

    await repository.hydrate()

    assert.equal(repository.getCookie('netease'), null)
    const status = repository.getStatus('netease')
    assert.deepEqual(status, {
      loggedIn: false,
      profile: null,
      updatedAtMs: null,
      persistence: null,
    })
    assert.doesNotMatch(JSON.stringify(status), /COOKIE_SENTINEL/)
  })

  it('rejects the cookie value in an allowed public profile field before writing either destination', async() => {
    let vaultWrites = 0
    let profileWrites = 0
    const vault = createVault()
    const originalWrite = vault.write
    vault.write = async(...args) => {
      vaultWrites++
      return await originalWrite.apply(vault, args)
    }
    const profiles = createProfiles()
    const originalUpsert = profiles.upsertAccountProfile
    profiles.upsertAccountProfile = async(...args) => {
      profileWrites++
      return await originalUpsert.apply(profiles, args)
    }
    const repository = createAccountRepository({ vault, profiles })

    await assert.rejects(
      repository.save('qq_music', {
        cookie: 'COOKIE_SENTINEL',
        profile: { uin: '7', nickname: 'prefix-COOKIE_SENTINEL-suffix' },
        updatedAtMs: 1,
      }),
      /public account profile/i,
    )

    assert.equal(vaultWrites, 0)
    assert.equal(profileWrites, 0)
    assert.deepEqual(repository.getStatus('qq_music'), {
      loggedIn: false,
      profile: null,
      updatedAtMs: null,
      persistence: null,
    })
  })

  it('publishes saved state only after vault verification and both readbacks succeed', async() => {
    const vault = createVault()
    const profiles = createProfiles()
    const repository = createAccountRepository({ vault, profiles })
    let releaseReadback
    const readbackGate = new Promise(resolve => { releaseReadback = resolve })
    const originalGet = profiles.getAccountProfile
    profiles.getAccountProfile = async provider => {
      await readbackGate
      return await originalGet(provider)
    }

    const saving = repository.save('qq_music', {
      cookie: 'uin=7; skey=value',
      profile: { nickname: 'Q', uin: '7' },
      updatedAtMs: 20,
    })
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(repository.getCookie('qq_music'), null)
    assert.equal(repository.getStatus('qq_music').loggedIn, false)

    releaseReadback()
    assert.deepEqual(await saving, { persistence: 'encrypted' })
    assert.equal(repository.getCookie('qq_music'), 'uin=7; skey=value')
    assert.deepEqual(repository.getStatus('qq_music'), {
      loggedIn: true,
      profile: { nickname: 'Q', uin: '7' },
      updatedAtMs: 20,
      persistence: 'encrypted',
    })
  })

  it('keeps hydrated state unchanged when save verification fails', async() => {
    const vault = createVault({
      'netease-cookie': { status: 'memory-only', value: 'old-cookie' },
    })
    vault.verify = async() => false
    const profiles = createProfiles({
      netease: {
        provider: 'netease',
        profileJson: '{"avatarUrl":"","nickname":"Old","userId":1}',
        updatedAtMs: 1,
      },
    })
    const repository = createAccountRepository({ vault, profiles })
    await repository.hydrate()

    await assert.rejects(repository.save('netease', {
      cookie: 'new-cookie',
      profile: { userId: 1, nickname: 'New', avatarUrl: '' },
      updatedAtMs: 2,
    }), /verification/i)

    assert.equal(repository.getCookie('netease'), 'old-cookie')
    assert.deepEqual(repository.getStatus('netease'), {
      loggedIn: true,
      profile: { avatarUrl: '', nickname: 'Old', userId: 1 },
      updatedAtMs: 1,
      persistence: 'memory-only',
    })
  })

  it('attempts both clear destinations and logs out only after both attempts settle', async() => {
    const vault = createVault({
      'netease-cookie': { status: 'available', value: 'old-cookie' },
    })
    const profiles = createProfiles({
      netease: {
        provider: 'netease',
        profileJson: '{"avatarUrl":"","nickname":"Old","userId":1}',
        updatedAtMs: 1,
      },
    })
    let releaseProfileRemoval
    let profileRemovalAttempted = false
    vault.remove = () => { throw new Error('vault remove failed') }
    profiles.removeAccountProfile = async() => {
      profileRemovalAttempted = true
      await new Promise(resolve => { releaseProfileRemoval = resolve })
    }
    const repository = createAccountRepository({ vault, profiles })
    await repository.hydrate()

    const clearing = repository.clear('netease')
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(profileRemovalAttempted, true)
    assert.equal(repository.getStatus('netease').loggedIn, true)
    releaseProfileRemoval()
    await assert.rejects(clearing, /vault remove failed/)
    assert.equal(repository.getCookie('netease'), null)
    assert.deepEqual(repository.getStatus('netease'), {
      loggedIn: false,
      profile: null,
      updatedAtMs: null,
      persistence: null,
    })
  })
})
