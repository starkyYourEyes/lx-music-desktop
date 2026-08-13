const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const api = (id, details = {}) => ({
  id,
  name: `Source ${id}`,
  description: `Description ${id}`,
  allowShowUpdateAlert: false,
  ...details,
})

const cloneState = state => ({
  apiList: state.apiList.map(item => ({ ...item })),
  scripts: new Map(state.scripts),
})

const createHarness = (options = {}) => {
  const previousState = {
    apiList: [api('a'), api('b')],
    scripts: new Map([['a', 'script-a'], ['b', 'script-b']]),
  }
  const nextState = {
    apiList: [api('a')],
    scripts: new Map([['a', 'script-a']]),
  }
  let state = cloneState(previousState)
  let commitCount = 0
  let notifications = 0
  const configUpdates = []
  const loggedErrors = []
  const invalidations = []
  const runtimeFailure = options.runtimeFailure ?? new Error('runtime lifecycle failed')
  const rollbackFailure = options.rollbackFailure ?? new Error('rollback failed')
  const originalLx = global.lx
  global.lx = {
    appSetting: {
      'common.apiSource': 'b',
      'common.apiFallbackSources': ['b', 'a'],
    },
    event_app: {
      update_config(update) {
        configUpdates.push(structuredClone(update))
        if (options.configFailure) throw options.configFailure
        Object.assign(global.lx.appSetting, update)
      },
    },
    worker: {
      dbService: {
        musicUrlInvalidateSource() {
          throw new Error('User API reconciliation must not invalidate persistent URL providers')
        },
      },
    },
  }

  const runtimePool = {
    async invalidate(...args) { invalidations.push(args) },
    async dispose() {
      if (options.failRuntime) throw runtimeFailure
    },
    async ensure() {},
  }
  const module = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/index.ts'), {
    '@common/utils': { log: { error: (...args) => { loggedErrors.push(args) } } },
    '@main/modules/winMain': { sendShowUpdateAlert() {}, sendStatusChange() {} },
    './main': {},
    './queue': { runUserApiTask: task => task() },
    './rendererEvent/rendererEvent': { init() {} },
    './runtimePool': {
      getUserApiRuntimePool: () => runtimePool,
      initializeUserApiRuntimePool: () => runtimePool,
    },
    './utils': {
      getUserApis: () => state.apiList,
      getUserApiState: () => state,
      getUserApiSyncData: async() => ({ apis: [] }),
      importApi: async() => api('imported'),
      notifyUserApiChanged: () => { notifications++ },
      prepareApisFromGitHub: async() => ({
        state: cloneState(nextState),
        skipped: [],
      }),
      prepareUserApisFromSync: async() => cloneState(nextState),
      setAllowShowUpdateAlert() {},
      commitUserApiState(next) {
        commitCount++
        if (options.failRollback && commitCount > 1) throw rollbackFailure
        state = cloneState(next)
        return state.apiList
      },
    },
  })

  return {
    configUpdates,
    loggedErrors,
    module,
    nextApiList: nextState.apiList,
    nextScripts: nextState.scripts,
    rollbackFailure,
    runtimeFailure,
    get appSetting() { return global.lx.appSetting },
    invalidations,
    get notifications() { return notifications },
    get state() { return state },
    restore() { global.lx = originalLx },
  }
}

test('User API replacement and removal are URL invalidation no-ops', async() => {
  const replacement = createHarness()
  try {
    await replacement.module.replaceApisFromGitHub([])
  } finally {
    replacement.restore()
  }

  const removal = createHarness()
  try {
    await removal.module.removeApi(['b'])
  } finally {
    removal.restore()
  }
})

test('post-commit deletion config failure exposes the retained committed state', async() => {
  const configFailure = new Error('config update failed after delete commit')
  const harness = createHarness({ configFailure })
  try {
    await assert.rejects(() => harness.module.removeApi(['b']), error => error === configFailure)
    assert.deepEqual(harness.state.apiList, harness.nextApiList)
    assert.deepEqual(harness.module.takeReplacementFailureApiList(configFailure), harness.nextApiList)
    assert.equal(harness.module.takeReplacementFailureApiList(configFailure), undefined)
    assert.equal(harness.notifications, 1)
  } finally {
    harness.restore()
  }
})

test('post-commit GitHub config failure exposes the retained committed state', async() => {
  const configFailure = new Error('config update failed after GitHub commit')
  const harness = createHarness({ configFailure })
  try {
    await assert.rejects(() => harness.module.replaceApisFromGitHub([]), error => error === configFailure)
    assert.deepEqual(harness.state.apiList, harness.nextApiList)
    assert.deepEqual(harness.module.takeReplacementFailureApiList(configFailure), harness.nextApiList)
    assert.equal(harness.module.takeReplacementFailureApiList(configFailure), undefined)
    assert.equal(harness.notifications, 1)
  } finally {
    harness.restore()
  }
})

test('retained GitHub rollback failure removes unavailable fallback sources', async() => {
  const harness = createHarness({ failRuntime: true, failRollback: true })
  try {
    await assert.rejects(
      () => harness.module.replaceApisFromGitHub([]),
      error => error === harness.runtimeFailure,
    )
    assert.deepEqual(harness.state.apiList, harness.nextApiList)
    assert.deepEqual(harness.module.takeReplacementFailureApiList(harness.runtimeFailure), harness.nextApiList)
    assert.deepEqual(harness.appSetting['common.apiFallbackSources'], ['a'])
    assert.deepEqual(harness.configUpdates, [{ 'common.apiFallbackSources': ['a'] }])
    assert.equal(harness.notifications, 1)
    assert.equal(harness.loggedErrors.some(args => args.includes(harness.rollbackFailure)), true)
  } finally {
    harness.restore()
  }
})

test('GitHub replacement invalidates equal-metadata APIs when their script bytes change', async() => {
  const harness = createHarness()
  try {
    const unchangedMetadata = {
      version: '1.0.0',
      remote: { blobSha: 'same-blob-sha' },
    }
    harness.state.apiList[0] = api('a', unchangedMetadata)
    harness.state.scripts.set('a', Buffer.from('old script bytes'))
    harness.nextApiList[0] = api('a', unchangedMetadata)
    harness.nextScripts.set('a', Buffer.from('new script bytes'))
    await harness.module.replaceApisFromGitHub([])

    assert.deepEqual(harness.invalidations, [['a', 'sourceChanged']])
  } finally {
    harness.restore()
  }
})
