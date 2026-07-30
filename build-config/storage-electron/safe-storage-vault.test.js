const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const typescript = require('typescript')

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(output, filename)
}

const childMarker = 'LX_VAULT_RESULT:'

const runElectronChild = async() => {
  const { app } = require('electron')
  const profileRoot = process.argv[process.argv.indexOf('--safe-storage-vault-child') + 1]
  global.lxDataPath = profileRoot
  global.lx = {}

  try {
    const { initializeCredentialVault } = require('../../src/main/storage/credentials/index.ts')
    const vault = await initializeCredentialVault()
    const persistence = await vault.write({ kind: 'netease-cookie' }, { version: 1, cookie: 'ELECTRON_SECRET' })
    await vault.flush()
    const filePath = path.join(profileRoot, 'credentials.v1.json')
    const fileExists = fs.existsSync(filePath)
    const containsPlaintext = fileExists && fs.readFileSync(filePath, 'utf8').includes('ELECTRON_SECRET')
    const status = vault.read({ kind: 'netease-cookie' }).status
    console.log(`${childMarker}${JSON.stringify({ persistence: persistence.persistence, fileExists, containsPlaintext, status })}`)
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
}

if (process.argv.includes('--safe-storage-vault-child')) {
  void runElectronChild()
} else {
  const { test } = require('node:test')

  test('round-trips with real Electron safeStorage or remains memory-only', async() => {
    const profileRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-electron-vault-'))
    try {
      const environment = { ...process.env }
      delete environment.ELECTRON_RUN_AS_NODE
      const { stdout } = await promisify(execFile)(process.execPath, [__filename, '--safe-storage-vault-child', profileRoot], {
        env: environment,
        timeout: 30_000,
        windowsHide: true,
      })
      const resultLine = stdout.split(/\r?\n/).find(line => line.startsWith(childMarker))
      assert.ok(resultLine, `Electron child did not report a result: ${stdout}`)
      const result = JSON.parse(resultLine.slice(childMarker.length))

      assert.equal(result.containsPlaintext, false)
      if (result.persistence == 'encrypted') {
        assert.deepEqual(result, {
          persistence: 'encrypted',
          fileExists: true,
          containsPlaintext: false,
          status: 'available',
        })
      } else {
        assert.deepEqual(result, {
          persistence: 'memory-only',
          fileExists: false,
          containsPlaintext: false,
          status: 'memory-only',
        })
      }
    } finally {
      await fsp.rm(profileRoot, { recursive: true, force: true })
    }
  })
}
