const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
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

const { createAccountRepository } = require('../../src/main/storage/accounts/accountRepository.ts')
const { createCredentialVault } = require('../../src/main/storage/credentials/credentialVault.ts')

after(() => {
  // eslint-disable-next-line n/no-deprecated-api
  delete require.extensions['.ts']
})

const createVault = () => {
  const entries = new Map()
  return {
    read(ref) {
      const value = entries.get(ref.kind)
      return value == null ? { status: 'missing' } : { status: 'available', value }
    },
    async write(ref, value) {
      entries.set(ref.kind, value)
      return { persistence: 'encrypted' }
    },
    async remove(ref) { entries.delete(ref.kind) },
    async verify(ref, expected) { return entries.get(ref.kind) == expected },
  }
}

const createProfiles = () => {
  const rows = new Map()
  return {
    async getAccountProfile(provider) { return rows.get(provider) ?? null },
    async upsertAccountProfile(row) { rows.set(row.provider, { ...row }) },
    async removeAccountProfile(provider) { rows.delete(provider) },
  }
}

const encryptedCipher = {
  mode: 'encrypted',
  encrypt: plaintext => Buffer.from(plaintext).reverse(),
  decrypt: ciphertext => Buffer.from(ciphertext).reverse().toString('utf8'),
}

describe('Kugou account repository', () => {
  it('stores and reloads a Kugou cookie and public profile', async() => {
    const repository = createAccountRepository({ vault: createVault(), profiles: createProfiles() })

    await repository.save('kugou', {
      cookie: 'token=secret;userid=42',
      profile: { userId: '42', nickname: 'Kugou User', avatarUrl: '' },
      updatedAtMs: 100,
    })

    assert.equal(repository.getCookie('kugou'), 'token=secret;userid=42')
    assert.deepEqual(repository.getStatus('kugou').profile, {
      userId: '42', nickname: 'Kugou User', avatarUrl: '',
    })
  })

  it('round-trips a Kugou cookie through the real credential vault', async() => {
    const profileRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-kugou-vault-'))
    try {
      const vault = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
      await vault.write({ kind: 'kugou-cookie' }, 'token=secret;userid=42')
      assert.deepEqual(vault.read({ kind: 'kugou-cookie' }), {
        status: 'available', value: 'token=secret;userid=42',
      })
      assert.equal(await vault.verify({ kind: 'kugou-cookie' }, 'token=secret;userid=42'), true)
    } finally {
      await fsp.rm(profileRoot, { recursive: true, force: true })
    }
  })
})
