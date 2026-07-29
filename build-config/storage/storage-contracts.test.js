const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  module._compile(output, filename)
}

const contractsPath = '../../src/common/storage/contracts.ts'
const validatorPath = '../../src/main/storage/validateStorageRequest.ts'
const handlerPath = '../../src/main/modules/winMain/rendererEvent/storage.ts'

const clearStorageContractModules = () => {
  for (const modulePath of [contractsPath, validatorPath, handlerPath]) {
    try { delete require.cache[require.resolve(modulePath)] } catch {}
  }
}

afterEach(clearStorageContractModules)

describe('storage request contract', () => {
  it('accepts only the versioned capabilities request', () => {
    const { parseStorageRequest } = require(validatorPath)

    assert.deepEqual(parseStorageRequest({ version: 1, type: 'capabilities.get' }), {
      version: 1,
      type: 'capabilities.get',
    })
    assert.throws(() => parseStorageRequest({ version: 1, type: 'file.read', path: 'data.json' }))
    assert.throws(() => parseStorageRequest({ version: 2, type: 'capabilities.get' }))
  })

  it('rejects non-plain requests, missing fields, and extra fields without echoing values', () => {
    const { parseStorageRequest } = require(validatorPath)
    const rejectedValue = 'secret-path.json'

    for (const request of [null, [], Object.create(null), { version: 1 }, { version: 1, type: 'capabilities.get', path: rejectedValue }]) {
      assert.throws(() => parseStorageRequest(request), error => {
        assert.equal(error instanceof Error, true)
        assert.equal(error.message.includes(rejectedValue), false)
        return true
      })
    }
  })
})

describe('storage capabilities handler', () => {
  it('builds a recovery capability response from supplied storage state', async() => {
    const { createStorageCapabilitiesProvider } = require(handlerPath)
    const getCapabilities = createStorageCapabilitiesProvider({
      getStorageState: () => ({ schemaVersion: 3, recoveryMode: true }),
      safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' },
      platform: 'linux',
    })

    assert.deepEqual(await getCapabilities(), {
      version: 1,
      schemaVersion: 3,
      securePersistence: 'memory-only',
      recoveryMode: true,
    })
  })

  it('returns supplied ready storage capabilities only for the exact request', async() => {
    const { createStorageCapabilitiesHandler } = require(handlerPath)
    const handle = createStorageCapabilitiesHandler({
      getCapabilities: async() => ({
        version: 1,
        schemaVersion: 3,
        securePersistence: 'available',
        recoveryMode: false,
      }),
    })

    assert.deepEqual(await handle({ version: 1, type: 'capabilities.get' }), {
      version: 1,
      schemaVersion: 3,
      securePersistence: 'available',
      recoveryMode: false,
    })
    await assert.rejects(handle({ version: 1, type: 'capabilities.get', table: 'settings' }))
  })

  it('preserves recovery state supplied by the capability provider', async() => {
    const { createStorageCapabilitiesHandler } = require(handlerPath)
    const handle = createStorageCapabilitiesHandler({
      getCapabilities: async() => ({
        version: 1,
        schemaVersion: 3,
        securePersistence: 'memory-only',
        recoveryMode: true,
      }),
    })

    assert.equal((await handle({ version: 1, type: 'capabilities.get' })).recoveryMode, true)
  })

  it('classifies unavailable and Linux basic-text safe storage as memory-only', () => {
    const { getSecurePersistenceCapability } = require(handlerPath)

    assert.equal(getSecurePersistenceCapability({ isEncryptionAvailable: () => false }, 'win32'), 'memory-only')
    assert.equal(getSecurePersistenceCapability({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }, 'linux'), 'memory-only')
    assert.equal(getSecurePersistenceCapability({ isEncryptionAvailable: () => true }, 'darwin'), 'available')
  })
})
