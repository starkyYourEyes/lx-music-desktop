const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const root = path.resolve(__dirname, '..')
const { configureSessionProxy } = loadTsModule(
  path.join(root, 'src/main/utils/sessionProxy.ts'),
)

const createDeferred = () => {
  let release
  const promise = new Promise(resolve => {
    release = resolve
  })
  return { promise, resolve: release }
}

const run = async() => {
  const calls = []
  const fakeSession = {
    async setProxy(config) {
      calls.push(config)
    },
  }

  await configureSessionProxy(fakeSession, { host: '127.0.0.1', port: 7890 })
  await configureSessionProxy(fakeSession, null)

  assert.deepEqual(calls, [
    {
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:7890',
    },
    {
      mode: 'direct',
    },
  ])

  const setProxyGate = createDeferred()
  let proxyConfigured = false
  const pendingProxyConfig = configureSessionProxy({
    setProxy: () => setProxyGate.promise,
  }, null).then(() => {
    proxyConfigured = true
  })

  await Promise.resolve()
  assert.equal(proxyConfigured, false)
  setProxyGate.resolve()
  await pendingProxyConfig
  assert.equal(proxyConfigured, true)

  const setProxyError = new Error('setProxy failed')
  await assert.rejects(
    configureSessionProxy({
      setProxy: () => Promise.reject(setProxyError),
    }, null),
    error => error === setProxyError,
  )

  const mainWindowSource = fs.readFileSync(
    path.join(root, 'src/main/modules/winMain/main.ts'),
    'utf8',
  )
  assert.match(mainWindowSource, /configureSessionProxy/)
  assert.match(mainWindowSource, /configureMainSessionProxy\(ses\)/)
  assert.match(
    mainWindowSource,
    /export const setProxy = \(\) => \{\s*if \(!browserWindow\) return\s*configureMainSessionProxy\(browserWindow\.webContents\.session\)\s*\}/,
  )
  assert.doesNotMatch(mainWindowSource, /\bsetSesProxy\s*\(/)
}

run().then(() => {
  console.log('Electron session proxy tests passed')
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
