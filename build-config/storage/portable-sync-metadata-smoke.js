const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const Module = require('node:module')
const path = require('node:path')
const typescript = require('typescript')

const writeJson = async(filePath, value) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, JSON.stringify(value), 'utf8')
}

const run = async() => {
  const requestedRoot = process.argv[2]
  if (process.argv.length != 3 || requestedRoot == null) throw new Error('Exactly one explicit smoke root is required')
  const volumeRoot = path.resolve(requestedRoot)
  const rootStats = await fsp.lstat(volumeRoot)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('Smoke root must be a real directory')

  const sourceRoot = path.resolve(__dirname, '../../src')
  const originalTsExtension = require.extensions['.ts']
  const originalResolveFilename = Module._resolveFilename
  let fixture = null

  // eslint-disable-next-line n/no-deprecated-api
  require.extensions['.ts'] = (module, filename) => {
    const source = fs.readFileSync(filename, 'utf8')
    const output = typescript.transpileModule(source, {
      compilerOptions: { module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText
    module._compile(output, filename)
  }
  Module._resolveFilename = function(request, parent, isMain, options) {
    if (request.startsWith('@main/')) request = path.join(sourceRoot, 'main', request.slice('@main/'.length))
    if (request.startsWith('@common/')) request = path.join(sourceRoot, 'common', request.slice('@common/'.length))
    return originalResolveFilename.call(this, request, parent, isMain, options)
  }

  try {
    fixture = await fsp.mkdtemp(path.join(volumeRoot, 'lx-portable-sync-smoke-'))
    if (path.dirname(fixture) != volumeRoot) throw new Error('Smoke fixture escaped explicit root')

    const clientPath = path.join(fixture, 'sync', 'client', 'servers.v1.json')
    const serverPath = path.join(fixture, 'sync', 'server', 'devices.v2.json')
    await writeJson(clientPath, {
      version: 1,
      servers: {
        smoke_server: {
          clientId: 'smoke-client',
          serverName: 'Smoke Server',
          key: 'SMOKE_KEY_SENTINEL-client',
        },
      },
    })
    await writeJson(serverPath, {
      version: 2,
      userName: 'smoke-user',
      clients: {
        smoke_device: {
          clientId: 'smoke-device',
          deviceName: 'Smoke Device',
          isMobile: false,
          lastConnectDate: 1,
          key: 'SMOKE_KEY_SENTINEL-server',
        },
      },
    })

    const { migrateLegacyCredentials } = require('../../src/main/migration/credentials/credentialMigration.ts')
    const { isSyncClientServersFileV1, isSyncServerDevicesFileV2 } = require('../../src/common/storage/syncMetadata.ts')
    const entries = new Map()
    const markers = new Map()
    const entryId = ref => JSON.stringify(ref)
    const vault = {
      mode: 'encrypted',
      async write(ref, value) {
        entries.set(entryId(ref), structuredClone(value))
        return { persistence: 'encrypted' }
      },
      async verify(ref, value) {
        return JSON.stringify(entries.get(entryId(ref))) == JSON.stringify(value)
      },
      getMigrationMarker(name) {
        return markers.get(name) ?? null
      },
      async putMigrationMarker(name, sourceId, completedAtMs) {
        markers.set(name, { sourceId, completedAtMs })
      },
    }

    await migrateLegacyCredentials({
      dataRoot: fixture,
      vault,
      profiles: { migrateLegacyAccountProfiles: async() => {} },
      now: () => 1,
    })

    const clientDocument = JSON.parse(await fsp.readFile(clientPath, 'utf8'))
    const serverDocument = JSON.parse(await fsp.readFile(serverPath, 'utf8'))
    assert.equal(isSyncClientServersFileV1(clientDocument), true)
    assert.equal(isSyncServerDevicesFileV2(serverDocument), true)
    assert.equal(JSON.stringify({ clientDocument, serverDocument }).includes('SMOKE_KEY_SENTINEL'), false)
    assert.equal(entries.size, 2)
  } finally {
    try {
      if (fixture != null) {
        if (path.dirname(fixture) != volumeRoot) throw new Error('Smoke fixture escaped explicit root')
        await fsp.rm(fixture, { recursive: true, force: true })
      }
    } finally {
      Module._resolveFilename = originalResolveFilename
      // eslint-disable-next-line n/no-deprecated-api
      if (originalTsExtension == null) delete require.extensions['.ts']
      // eslint-disable-next-line n/no-deprecated-api
      else require.extensions['.ts'] = originalTsExtension
    }
  }

  process.stdout.write(`${JSON.stringify({ status: 'pass', fixtureRemoved: true })}\n`)
}

void run().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
