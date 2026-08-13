const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const actualZlib = require('node:zlib')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')
const githubUserApi = require('../../src/common/utils/githubUserApi')

const REPOSITORY = 'Macrohard0001/lx-ikun-music-sources'
const VERSION = 'v260813'
const GROUP = 'group'
const COMMIT_SHA = 'a'.repeat(40)

const validScript = name => `/*\n * @name ${name}\n * @description Test source\n * @version 1.0.0\n */\n`

const githubItem = (fileName, script, shaCharacter = 'b') => ({
  script,
  remote: {
    provider: 'github',
    repository: REPOSITORY,
    version: VERSION,
    group: GROUP,
    path: `${VERSION}/${GROUP}/${fileName}`,
    blobSha: shaCharacter.repeat(40),
    commitSha: COMMIT_SHA,
  },
})

const oldSerializedState = () => [{
  id: 'old-source',
  name: 'Old source',
  description: 'Existing local source',
  version: '1.0.0',
  allowShowUpdateAlert: false,
  script: 'old-compressed-script',
}]

const createUtilsHarness = (options = {}) => {
  let stored = oldSerializedState()
  let storeSetCount = 0
  const store = {
    get: () => structuredClone(stored),
    set(_key, value) {
      storeSetCount++
      stored = structuredClone(value)
    },
  }
  const compressionError = options.compressionError
  const zlib = {
    ...actualZlib,
    deflate(value, callback) {
      if (compressionError) {
        queueMicrotask(() => callback(compressionError))
        return
      }
      actualZlib.deflate(value, callback)
    },
  }
  const utils = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/utils.ts'), {
    './config': { userApis: [] },
    '@common/constants': { STORE_NAMES: { USER_API: 'userApi' } },
    '@main/utils/store': () => store,
    '@common/utils/userApiSync': {
      assertUserApiSyncData() {},
      createUserApiSyncData() {},
    },
    '@common/utils': { log: { error() {} } },
    '@common/utils/githubUserApi': githubUserApi,
    'node:zlib': zlib,
  })

  return {
    utils,
    getStoreSetCount: () => storeSetCount,
    getStored: () => structuredClone(stored),
  }
}

const createReplacementHarness = items => {
  const utilsHarness = createUtilsHarness()
  const runtimeActions = []
  const runtimePool = {
    async invalidate(id, kind) { runtimeActions.push(`invalidate:${id}:${kind}`) },
    async dispose(id) { runtimeActions.push(`dispose:${id}`) },
    async ensure() {},
  }
  const originalLx = global.lx
  global.lx = {
    appSetting: {
      'common.apiSource': 'old-source',
      'common.apiFallbackSources': ['old-source'],
    },
    event_app: {
      update_config(update) { Object.assign(global.lx.appSetting, update) },
      user_api_changed() {},
    },
  }
  const module = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/index.ts'), {
    '@common/utils': { log: { error() {} } },
    '@main/modules/winMain': { sendShowUpdateAlert() {}, sendStatusChange() {} },
    './main': {},
    './queue': { runUserApiTask: task => task() },
    './rendererEvent/rendererEvent': { init() {} },
    './runtimePool': {
      getUserApiRuntimePool: () => runtimePool,
      initializeUserApiRuntimePool: () => runtimePool,
    },
    './utils': utilsHarness.utils,
  })
  const previousState = {
    apiList: structuredClone(utilsHarness.utils.getUserApiState().apiList),
    scripts: new Map(utilsHarness.utils.getUserApiState().scripts),
  }

  return {
    items,
    module,
    previousState,
    runtimeActions,
    get commitCount() { return utilsHarness.getStoreSetCount() },
    get currentState() {
      const state = utilsHarness.utils.getUserApiState()
      return {
        apiList: structuredClone(state.apiList),
        scripts: new Map(state.scripts),
      }
    },
    restore() { global.lx = originalLx },
  }
}

test('mixed GitHub batch keeps valid scripts in order and reports every invalid path', async() => {
  const { utils } = createUtilsHarness()
  const result = await utils.prepareApisFromGitHub([
    githubItem('valid-a.js', validScript('A'), 'b'),
    githubItem('invalid-b.js', 'console.log("missing metadata")', 'c'),
    githubItem('valid-c.js', validScript('C'), 'd'),
    githubItem('invalid-d.js', '', 'e'),
  ])

  assert.deepEqual(result.state.apiList.map(api => api.name), ['A', 'C'])
  assert.deepEqual(result.skipped, [
    `${VERSION}/${GROUP}/invalid-b.js`,
    `${VERSION}/${GROUP}/invalid-d.js`,
  ])
  assert.equal(result.state.scripts.size, 2)
})

test('mixed GitHub replacement commits valid scripts and returns skipped paths', async() => {
  const harness = createReplacementHarness([
    githubItem('valid-a.js', validScript('A'), 'b'),
    githubItem('invalid-b.js', 'console.log("missing metadata")', 'c'),
    githubItem('valid-c.js', validScript('C'), 'd'),
  ])
  try {
    const result = await harness.module.replaceApisFromGitHub(harness.items)

    assert.deepEqual(result.apiList.map(api => api.name), ['A', 'C'])
    assert.deepEqual(result.skipped, [`${VERSION}/${GROUP}/invalid-b.js`])
    assert.equal(harness.commitCount, 1)
    assert.deepEqual(harness.currentState.apiList.map(api => api.name), ['A', 'C'])
  } finally {
    harness.restore()
  }
})

test('all-invalid GitHub batch rejects before replacement commits', async() => {
  const harness = createReplacementHarness([
    githubItem('invalid-a.js', '', 'b'),
    githubItem('invalid-b.js', 'const value = 1', 'c'),
  ])
  try {
    await assert.rejects(
      () => harness.module.replaceApisFromGitHub(harness.items),
      error => error.code == 'GITHUB_INVALID_SCRIPT' &&
        error.detail.includes('invalid-a.js') &&
        error.detail.includes('invalid-b.js'),
    )
    assert.equal(harness.commitCount, 0)
    assert.deepEqual(harness.currentState, harness.previousState)
    assert.deepEqual(harness.runtimeActions, [])
  } finally {
    harness.restore()
  }
})

test('compression failure still aborts the whole batch', async() => {
  const compressionError = new Error('compression failed')
  const { utils } = createUtilsHarness({ compressionError })

  await assert.rejects(
    () => utils.prepareApisFromGitHub([
      githubItem('valid.js', validScript('A')),
    ]),
    error => error === compressionError,
  )
})
