const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')
const { deferred } = require('../test-utils/playback-fallback-harness')

const api = (id, label, script) => ({
  id,
  name: label,
  description: `${label} description`,
  author: `${label} author`,
  homepage: `https://example.test/${id}`,
  version: '1.0.0',
  allowShowUpdateAlert: false,
  script: `gz_${Buffer.from(script).toString('base64')}`,
})

const createHarness = () => {
  const firstInflateStarted = deferred()
  const releaseFirstInflate = deferred()
  let firstInflate = true
  let stored = [
    api('a', 'Old A', 'old-script-a'),
    api('b', 'Old B', 'old-script-b'),
  ]
  const store = {
    get: () => structuredClone(stored),
    set: (_key, value) => { stored = structuredClone(value) },
  }
  const zlib = {
    inflate(buffer, callback) {
      const finish = () => callback(null, Buffer.from(buffer.toString()))
      if (!firstInflate) {
        queueMicrotask(finish)
        return
      }
      firstInflate = false
      firstInflateStarted.resolve()
      void releaseFirstInflate.promise.then(finish)
    },
    deflate(buffer, callback) { queueMicrotask(() => callback(null, buffer)) },
  }
  const utils = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/utils.ts'), {
    './config': { userApis: [] },
    '@common/constants': { STORE_NAMES: { USER_API: 'userApi' } },
    '@main/utils/store': () => store,
    '@common/utils/userApiSync': require('../../src/common/utils/userApiSync.js'),
    '@common/utils': { log: { error() {} } },
    '@common/utils/githubUserApi': {
      createGitHubUserApiError: error => error,
      GITHUB_USER_API_LIMITS: { maxFiles: 100, maxScriptBytes: 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024 },
    },
    'node:zlib': zlib,
  })
  const nextState = {
    apiList: [
      { ...api('a', 'New A', 'unused'), script: undefined },
      { ...api('b', 'New B', 'unused'), script: undefined },
    ].map(({ script, ...info }) => info),
    scripts: new Map([
      ['a', `gz_${Buffer.from('new-script-a').toString('base64')}`],
      ['b', `gz_${Buffer.from('new-script-b').toString('base64')}`],
    ]),
  }
  const runtimePool = {
    async invalidate() {},
    async dispose() {},
    async ensure() {},
  }
  const queue = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/queue.ts'))
  const originalLx = global.lx
  global.lx = {
    appSetting: { 'common.apiFallbackSources': [] },
    event_app: { update_config() {}, user_api_changed() {} },
  }
  const module = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/index.ts'), {
    '@common/utils': { log: { error() {} } },
    '@main/modules/winMain': { sendShowUpdateAlert() {}, sendStatusChange() {} },
    './main': {},
    './queue': queue,
    './rendererEvent/rendererEvent': { init() {} },
    './runtimePool': {
      getUserApiRuntimePool: () => runtimePool,
      initializeUserApiRuntimePool: () => runtimePool,
    },
    './utils': {
      ...utils,
      prepareApisFromGitHub: async() => ({ state: nextState, skipped: [] }),
    },
  })

  return {
    firstInflateStarted: firstInflateStarted.promise,
    releaseFirstInflate: () => releaseFirstInflate.resolve(),
    module,
    restore() { global.lx = originalLx },
  }
}

const snapshotRows = snapshot => snapshot.apis.map(item => [item.id, item.name, item.script])

test('sync export cannot mix old metadata with replacement scripts', async() => {
  const harness = createHarness()
  try {
    const reading = harness.module.getUserApiSyncData()
    await harness.firstInflateStarted
    const replacing = harness.module.replaceApisFromGitHub([])
    await new Promise(resolve => setImmediate(resolve))
    harness.releaseFirstInflate()

    assert.deepEqual(snapshotRows(await reading), [
      ['a', 'Old A', 'old-script-a'],
      ['b', 'Old B', 'old-script-b'],
    ])
    await replacing
    assert.deepEqual((await harness.module.getApiList()).map(item => [item.id, item.name]), [
      ['a', 'New A'],
      ['b', 'New B'],
    ])
  } finally {
    harness.restore()
  }
})

test('sync export cannot pair removed metadata with an empty script', async() => {
  const harness = createHarness()
  try {
    const reading = harness.module.getUserApiSyncData()
    await harness.firstInflateStarted
    const removing = harness.module.removeApi(['b'])
    await new Promise(resolve => setImmediate(resolve))
    harness.releaseFirstInflate()

    assert.deepEqual(snapshotRows(await reading), [
      ['a', 'Old A', 'old-script-a'],
      ['b', 'Old B', 'old-script-b'],
    ])
    await removing
    assert.deepEqual((await harness.module.getApiList()).map(item => item.id), ['a'])
  } finally {
    harness.restore()
  }
})
