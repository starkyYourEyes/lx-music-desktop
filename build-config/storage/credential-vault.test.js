const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(output, filename)
}

const vaultPath = '../../src/main/storage/credentials/credentialVault.ts'
const tempDirs = []

afterEach(async() => {
  await Promise.all(tempDirs.splice(0).map(directory => fsp.rm(directory, { recursive: true, force: true })))
})

const makeProfileRoot = async() => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-credential-vault-'))
  tempDirs.push(directory)
  return directory
}

const encryptedCipher = {
  mode: 'encrypted',
  encrypt: plaintext => Buffer.concat([Buffer.from('vault-test:'), Buffer.from(plaintext).reverse()]),
  decrypt: ciphertext => {
    if (!ciphertext.subarray(0, 11).equals(Buffer.from('vault-test:'))) throw new Error('invalid ciphertext')
    return Buffer.from(ciphertext.subarray(11)).reverse().toString('utf8')
  },
}

const memoryOnlyCipher = {
  mode: 'memory-only',
  encrypt: () => { throw new Error('must not encrypt') },
  decrypt: () => { throw new Error('must not decrypt') },
}

describe('credential vault', () => {
  it('stores no plaintext secret and round-trips each entry independently', async() => {
    const { createCredentialVault } = require(vaultPath)
    const profileRoot = await makeProfileRoot()
    const filePath = path.join(profileRoot, 'credentials.v1.json')
    const vault = await createCredentialVault({ profileRoot, cipher: encryptedCipher, now: () => 1234 })

    await vault.write({ kind: 'netease-cookie' }, { version: 1, cookie: 'COOKIE_SENTINEL' })
    await vault.write({ kind: 'webdav-basic' }, { version: 1, username: 'u', password: 'PASS_SENTINEL' })
    await vault.flush()

    assert.doesNotMatch(await fsp.readFile(filePath, 'utf8'), /COOKIE_SENTINEL|PASS_SENTINEL/)
    assert.deepEqual(vault.read({ kind: 'netease-cookie' }), {
      status: 'available',
      value: { version: 1, cookie: 'COOKIE_SENTINEL' },
    })
    assert.deepEqual(vault.read({ kind: 'webdav-basic' }), {
      status: 'available',
      value: { version: 1, username: 'u', password: 'PASS_SENTINEL' },
    })
  })

  it('preserves an undecryptable entry without affecting another entry', async() => {
    const { createCredentialVault } = require(vaultPath)
    const profileRoot = await makeProfileRoot()
    const filePath = path.join(profileRoot, 'credentials.v1.json')
    const firstVault = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
    await firstVault.write({ kind: 'netease-cookie' }, { version: 1, cookie: 'bad-later' })
    await firstVault.write({ kind: 'qq-music-cookie' }, { version: 1, cookie: 'still-good' })

    const envelope = JSON.parse(await fsp.readFile(filePath, 'utf8'))
    const corruptedCiphertext = Buffer.from('corrupt-entry').toString('base64')
    envelope.entries['netease-cookie'].ciphertext = corruptedCiphertext
    await fsp.writeFile(filePath, JSON.stringify(envelope))

    const vault = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
    assert.deepEqual(vault.read({ kind: 'netease-cookie' }), { status: 'undecryptable' })
    assert.deepEqual(vault.read({ kind: 'qq-music-cookie' }), {
      status: 'available',
      value: { version: 1, cookie: 'still-good' },
    })

    await vault.write({ kind: 'qq-music-cookie' }, { version: 1, cookie: 'updated-good' })
    const preserved = JSON.parse(await fsp.readFile(filePath, 'utf8'))
    assert.equal(preserved.entries['netease-cookie'].ciphertext, corruptedCiphertext)
  })

  it('rejects decrypted payloads that belong to another credential kind', async() => {
    const { createCredentialVault } = require(vaultPath)
    const profileRoot = await makeProfileRoot()
    const filePath = path.join(profileRoot, 'credentials.v1.json')
    const vault = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
    await vault.write({ kind: 'webdav-basic' }, { version: 1, username: 'u', password: 'p' })

    const envelope = JSON.parse(await fsp.readFile(filePath, 'utf8'))
    envelope.entries['netease-cookie'] = envelope.entries['webdav-basic']
    await fsp.writeFile(filePath, JSON.stringify(envelope))

    const reloaded = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
    assert.deepEqual(reloaded.read({ kind: 'netease-cookie' }), { status: 'undecryptable' })
  })

  it('binds ciphertext to the exact credential reference across same-schema entries', async() => {
    const { createCredentialVault } = require(vaultPath)
    const { toCredentialEntryId } = require('../../src/main/storage/credentials/types.ts')
    const substitutions = [
      {
        source: { kind: 'netease-cookie' },
        target: { kind: 'qq-music-cookie' },
        payload: { version: 1, cookie: 'cookie=value' },
      },
      {
        source: { kind: 'sync-client', serverId: 'server-a' },
        target: { kind: 'sync-client', serverId: 'server-b' },
        payload: { version: 1, key: 'client-key' },
      },
      {
        source: { kind: 'sync-client', serverId: 'server-a' },
        target: { kind: 'sync-server-device', userName: 'alice', clientId: 'desktop' },
        payload: { version: 1, key: 'shared-schema-key' },
      },
      {
        source: { kind: 'legacy-quarantine', sourceSha256: 'a'.repeat(64) },
        target: { kind: 'legacy-quarantine', sourceSha256: 'b'.repeat(64) },
        payload: { version: 1, secret: 'quarantined' },
      },
    ]
    const statuses = []

    for (const substitution of substitutions) {
      const profileRoot = await makeProfileRoot()
      const filePath = path.join(profileRoot, 'credentials.v1.json')
      const vault = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
      await vault.write(substitution.source, substitution.payload)
      const envelope = JSON.parse(await fsp.readFile(filePath, 'utf8'))
      const sourceId = toCredentialEntryId(substitution.source)
      const targetId = toCredentialEntryId(substitution.target)
      envelope.entries[targetId] = envelope.entries[sourceId]
      delete envelope.entries[sourceId]
      await fsp.writeFile(filePath, JSON.stringify(envelope))

      const reloaded = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
      statuses.push(reloaded.read(substitution.target).status)
    }

    assert.deepEqual(statuses, substitutions.map(() => 'undecryptable'))
  })

  it('rejects plaintext-capable extra fields at every envelope level', async() => {
    const { createCredentialVault } = require(vaultPath)
    const validEntry = {
      version: 1,
      ciphertext: Buffer.from('ciphertext').toString('base64'),
      updatedAtMs: 1,
    }
    const validMarker = {
      sourceSha256: 'a'.repeat(64),
      completedAtMs: 1,
    }
    const fixtures = [
      { version: 1, entries: {}, migrationMarkers: {}, plaintext: 'TOP_SECRET' },
      { version: 1, entries: { entry: { ...validEntry, plaintext: 'ENTRY_SECRET' } }, migrationMarkers: {} },
      { version: 1, entries: {}, migrationMarkers: { marker: { ...validMarker, plaintext: 'MARKER_SECRET' } } },
    ]
    const rejected = []

    for (const fixture of fixtures) {
      const profileRoot = await makeProfileRoot()
      await fsp.writeFile(path.join(profileRoot, 'credentials.v1.json'), JSON.stringify(fixture))
      try {
        await createCredentialVault({ profileRoot, cipher: encryptedCipher })
        rejected.push(false)
      } catch {
        rejected.push(true)
      }
    }

    assert.deepEqual(rejected, [true, true, true])
  })

  it('isolates structural corruption and persists only base64 ciphertext', async() => {
    const { createCredentialVault } = require(vaultPath)
    const corruptions = [
      { mutate: () => ({}), preserve: false },
      { mutate: entry => ({ ...entry, ciphertext: '' }), preserve: false },
      { mutate: entry => ({ ...entry, ciphertext: 'abc' }), preserve: false },
      { mutate: entry => ({ ...entry, ciphertext: '!!!!' }), preserve: false },
      { mutate: entry => ({ ...entry, ciphertext: null }), preserve: false },
      { mutate: entry => ({ ...entry, version: 2, updatedAtMs: -1 }), preserve: true },
    ]

    for (const corruption of corruptions) {
      const profileRoot = await makeProfileRoot()
      const filePath = path.join(profileRoot, 'credentials.v1.json')
      const firstVault = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
      await firstVault.write({ kind: 'netease-cookie' }, { version: 1, cookie: 'bad-entry' })
      await firstVault.write({ kind: 'qq-music-cookie' }, { version: 1, cookie: 'healthy-entry' })
      const envelope = JSON.parse(await fsp.readFile(filePath, 'utf8'))
      const corruptedEntry = corruption.mutate(envelope.entries['netease-cookie'])
      envelope.entries['netease-cookie'] = corruptedEntry
      await fsp.writeFile(filePath, JSON.stringify(envelope))

      const vault = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
      assert.deepEqual(vault.read({ kind: 'netease-cookie' }), { status: 'undecryptable' })
      assert.deepEqual(vault.read({ kind: 'qq-music-cookie' }), {
        status: 'available',
        value: { version: 1, cookie: 'healthy-entry' },
      })
      await vault.write({ kind: 'qq-music-cookie' }, { version: 1, cookie: 'updated-healthy-entry' })
      const persisted = JSON.parse(await fsp.readFile(filePath, 'utf8'))
      if (corruption.preserve) assert.deepEqual(persisted.entries['netease-cookie'], corruptedEntry)
      else assert.equal(Object.hasOwn(persisted.entries, 'netease-cookie'), false)
      assert.deepEqual(vault.read({ kind: 'netease-cookie' }), { status: 'undecryptable' })
    }
  })

  it('does not rewrite a plaintext ciphertext sentinel during an unrelated write', async() => {
    const { createCredentialVault } = require(vaultPath)
    const profileRoot = await makeProfileRoot()
    const filePath = path.join(profileRoot, 'credentials.v1.json')
    const firstVault = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
    await firstVault.write({ kind: 'netease-cookie' }, { version: 1, cookie: 'bad-entry' })
    await firstVault.write({ kind: 'qq-music-cookie' }, { version: 1, cookie: 'healthy-entry' })
    const envelope = JSON.parse(await fsp.readFile(filePath, 'utf8'))
    envelope.entries['netease-cookie'].ciphertext = 'PLAINTEXT_CIPHERTEXT_SENTINEL'
    await fsp.writeFile(filePath, JSON.stringify(envelope))

    const vault = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
    assert.deepEqual(vault.read({ kind: 'netease-cookie' }), { status: 'undecryptable' })
    assert.equal(vault.read({ kind: 'qq-music-cookie' }).status, 'available')
    await vault.write({ kind: 'qq-music-cookie' }, { version: 1, cookie: 'updated-healthy-entry' })

    const durableBytes = await fsp.readFile(filePath, 'utf8')
    const durableEnvelope = JSON.parse(durableBytes)
    assert.doesNotMatch(durableBytes, /PLAINTEXT_CIPHERTEXT_SENTINEL/)
    assert.equal(fs.existsSync(`${filePath}.previous`), false)
    const vaultArtifacts = (await fsp.readdir(profileRoot)).filter(name => name.startsWith('credentials.v1.json'))
    for (const artifact of vaultArtifacts) {
      assert.doesNotMatch(await fsp.readFile(path.join(profileRoot, artifact), 'utf8'), /PLAINTEXT_CIPHERTEXT_SENTINEL/)
    }
    assert.equal(Object.hasOwn(durableEnvelope.entries, 'netease-cookie'), false)
    assert.deepEqual(vault.read({ kind: 'netease-cookie' }), { status: 'undecryptable' })
    assert.deepEqual(vault.read({ kind: 'qq-music-cookie' }), {
      status: 'available',
      value: { version: 1, cookie: 'updated-healthy-entry' },
    })
  })

  it('removes only the requested entry', async() => {
    const { createCredentialVault } = require(vaultPath)
    const profileRoot = await makeProfileRoot()
    const vault = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
    await vault.write({ kind: 'netease-cookie' }, 'netease-cookie=value')
    await vault.write({ kind: 'qq-music-cookie' }, 'qq-cookie=value')

    await vault.remove({ kind: 'netease-cookie' })

    assert.deepEqual(vault.read({ kind: 'netease-cookie' }), { status: 'missing' })
    assert.deepEqual(vault.read({ kind: 'qq-music-cookie' }), {
      status: 'available',
      value: 'qq-cookie=value',
    })
  })

  it('persists migration markers atomically with the envelope', async() => {
    const { createCredentialVault } = require(vaultPath)
    const profileRoot = await makeProfileRoot()
    const vault = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
    const sourceSha256 = 'a'.repeat(64)

    await vault.putMigrationMarker('legacy-data:netease', sourceSha256, 9876)

    const reloaded = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
    assert.deepEqual(reloaded.getMigrationMarker('legacy-data:netease'), {
      sourceSha256,
      completedAtMs: 9876,
    })
  })

  it('verifies values by canonical JSON rather than object key order', async() => {
    const { createCredentialVault } = require(vaultPath)
    const profileRoot = await makeProfileRoot()
    const vault = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
    await vault.write({ kind: 'webdav-basic' }, { version: 1, username: 'u', password: 'p' })

    assert.equal(await vault.verify(
      { kind: 'webdav-basic' },
      { password: 'p', username: 'u', version: 1 },
    ), true)
    assert.equal(await vault.verify(
      { kind: 'webdav-basic' },
      { version: 1, username: 'u', password: 'different' },
    ), false)
  })

  it('keeps memory-only values off disk', async() => {
    const { createCredentialVault } = require(vaultPath)
    const profileRoot = await makeProfileRoot()
    const filePath = path.join(profileRoot, 'credentials.v1.json')
    const vault = await createCredentialVault({ profileRoot, cipher: memoryOnlyCipher })

    const result = await vault.write({ kind: 'qq-music-cookie' }, { version: 1, cookie: 'SECRET' })

    assert.deepEqual(result, { persistence: 'memory-only' })
    assert.deepEqual(vault.read({ kind: 'qq-music-cookie' }), {
      status: 'memory-only',
      value: { version: 1, cookie: 'SECRET' },
    })
    assert.equal(fs.existsSync(filePath), false)
  })

  it('removes persisted ciphertext even when secure storage is memory-only', async() => {
    const { createCredentialVault } = require(vaultPath)
    const profileRoot = await makeProfileRoot()
    const encryptedVault = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
    await encryptedVault.write({ kind: 'qq-music-cookie' }, { version: 1, cookie: 'old-persisted-cookie' })

    const memoryVault = await createCredentialVault({ profileRoot, cipher: memoryOnlyCipher })
    await memoryVault.remove({ kind: 'qq-music-cookie' })

    const reloaded = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
    assert.deepEqual(reloaded.read({ kind: 'qq-music-cookie' }), { status: 'missing' })
  })

  it('keeps an unrelated malformed ciphertext diagnostic during memory-only target cleanup and marker persistence', async() => {
    const { createCredentialVault } = require(vaultPath)
    const profileRoot = await makeProfileRoot()
    const filePath = path.join(profileRoot, 'credentials.v1.json')
    const encryptedVault = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
    await encryptedVault.write({ kind: 'qq-music-cookie' }, { version: 1, cookie: 'stale-target-cookie' })
    await encryptedVault.write({ kind: 'netease-cookie' }, { version: 1, cookie: 'unrelated-cookie' })
    const seeded = JSON.parse(await fsp.readFile(filePath, 'utf8'))
    const malformedEntry = { ...seeded.entries['netease-cookie'], ciphertext: 'malformed-ciphertext' }
    seeded.entries['netease-cookie'] = malformedEntry
    await fsp.writeFile(filePath, JSON.stringify(seeded))

    const memoryVault = await createCredentialVault({ profileRoot, cipher: memoryOnlyCipher })
    await memoryVault.write({ kind: 'qq-music-cookie' }, { version: 1, cookie: 'process-only-cookie' })
    await memoryVault.putMigrationMarker('legacy-data:memory-only', 'a'.repeat(64), 100)

    const persisted = JSON.parse(await fsp.readFile(filePath, 'utf8'))
    assert.deepEqual(persisted.entries['netease-cookie'], malformedEntry)
    assert.equal(Object.hasOwn(persisted.entries, 'qq-music-cookie'), false)
    assert.doesNotMatch(await fsp.readFile(filePath, 'utf8'), /process-only-cookie/)

    const reloaded = await createCredentialVault({ profileRoot, cipher: encryptedCipher })
    assert.deepEqual(reloaded.read({ kind: 'netease-cookie' }), { status: 'undecryptable' })
    assert.deepEqual(reloaded.read({ kind: 'qq-music-cookie' }), { status: 'missing' })
  })
})
