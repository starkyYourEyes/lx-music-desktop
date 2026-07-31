const assert = require('node:assert')
const { createHash } = require('node:crypto')
const path = require('node:path')
const actualZlib = require('node:zlib')
const loadTsModule = require('./test-utils/load-ts-module')
const githubUserApi = require('../src/common/utils/githubUserApi')

const REPOSITORY = 'Macrohard0001/lx-ikun-music-sources'
const VERSION = 'v260724'
const RECOMMENDED_GROUP = 'V260720-\u63a8\u8350'
const COMMIT_SHA = 'b'.repeat(40)

const validScript = name => `/*\n * @name ${name}\n * @description Test source\n * @version 1.0.0\n */\n`

const makeRemote = (overrides = {}) => ({
  provider: 'github',
  repository: REPOSITORY,
  version: VERSION,
  group: RECOMMENDED_GROUP,
  path: `${VERSION}/${RECOMMENDED_GROUP}/a.js`,
  blobSha: 'a'.repeat(40),
  commitSha: COMMIT_SHA,
  ...overrides,
})

const makeInput = () => [
  {
    script: validScript('Source A'),
    remote: makeRemote(),
  },
  {
    script: validScript('Source B'),
    remote: makeRemote({
      group: 'online',
      path: `${VERSION}/online/b.js`,
      blobSha: 'c'.repeat(40),
    }),
  },
]

const createDeferred = () => {
  let resolveDeferred
  let rejectDeferred
  const promise = new Promise((resolve, reject) => {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return { promise, resolve: resolveDeferred, reject: rejectDeferred }
}

const waitForAsyncTurn = () => new Promise(resolve => setImmediate(resolve))

const createRuntimeHarness = (options = {}) => {
  const actions = []
  const logErrors = []
  const committedApiIds = []
  const configUpdates = []
  let storeCommits = 0
  let changeEvents = 0
  let replacementCall = 0
  let stateReads = 0
  let syncCall = 0
  let commitCall = 0
  const stableApi = {
    id: 'stable-id',
  }
  const replacementSteps = options.replacementSteps ?? [[stableApi]]
  const syncSteps = options.syncSteps ?? []
  const commitSteps = options.commitSteps ?? []
  let currentState = {
    apiList: options.initialApis ?? [stableApi],
    scripts: new Map((options.initialApis ?? [stableApi]).map(api => [
      api.id,
      options.initialScripts?.[api.id] ?? `script:${api.id}:old`,
    ])),
  }
  let taskQueue = Promise.resolve()

  const runStep = async(step) => {
    if (step instanceof Error) throw step
    return typeof step === 'function' ? step() : step
  }
  const runUserApiTask = async(task) => {
    const result = taskQueue.then(task)
    taskQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const commitState = (state) => {
    const step = commitSteps[commitCall++]
    if (step instanceof Error) throw step
    if (typeof step === 'function') step()
    currentState = state
    storeCommits++
    committedApiIds.push(currentState.apiList.map(api => api.id))
    return currentState.apiList
  }
  const prepareReplacement = async() => {
    actions.push('replace')
    const step = replacementSteps[replacementCall++]
    const apiList = await runStep(step)
    const scriptOverrides = options.replacementScripts?.[replacementCall - 1] ?? {}
    return {
      apiList,
      scripts: new Map(apiList.map(api => [
        api.id,
        scriptOverrides[api.id] ?? currentState.scripts.get(api.id) ?? `script:${api.id}:new`,
      ])),
    }
  }

  const runtimePool = {
    async invalidate(id, kind) {
      actions.push(`invalidate:${id}:${kind}`)
      await runStep(options.invalidateSteps?.shift())
    },
    async dispose(id, disposeOptions) {
      actions.push(`dispose:${id}:${disposeOptions.clearSession}`)
      await runStep(options.disposeSteps?.shift())
    },
  }

  global.lx = {
    appSetting: {
      'common.apiFallbackSources': options.fallbackSources ?? [],
      'common.apiSource': '',
    },
    event_app: {
      update_config(update) {
        configUpdates.push(update)
      },
      user_api_changed() {},
    },
  }

  const runtime = loadTsModule(
    path.join(__dirname, '../src/main/modules/userApi/index.ts'),
    {
      './main': {},
      './queue': { runUserApiTask },
      './utils': {
        getUserApis: () => currentState.apiList,
        getUserApiState: () => {
          stateReads++
          return currentState
        },
        async importApi() {},
        removeApi(ids) {
          actions.push('remove:' + ids.join(','))
          for (let index = currentState.apiList.length - 1; index >= 0; index--) {
            if (!ids.includes(currentState.apiList[index].id)) continue
            currentState.scripts.delete(currentState.apiList[index].id)
            currentState.apiList.splice(index, 1)
          }
        },
        setAllowShowUpdateAlert() {},
        prepareApisFromGitHub: prepareReplacement,
        commitUserApiState: commitState,
        notifyUserApiChanged() {
          changeEvents++
        },
        async prepareUserApisFromSync(data) {
          actions.push('sync')
          const step = syncSteps[syncCall++] ?? data.apis
          const apiList = await runStep(step)
          return {
            apiList,
            scripts: new Map(apiList.map(api => [
              api.id,
              currentState.scripts.get(api.id) ?? `script:${api.id}:sync`,
            ])),
          }
        },
        async getUserApiSyncData() {},
        async replaceApisFromGitHub() {
          const state = await prepareReplacement()
          const apiList = commitState(state)
          changeEvents++
          return apiList
        },
      },
      './rendererEvent/rendererEvent': {
        setAllowShowUpdateAlert() {},
        init() {},
      },
      './runtimePool': {
        getUserApiRuntimePool: () => runtimePool,
        initializeUserApiRuntimePool: () => runtimePool,
      },
      '@main/modules/winMain': {},
      '@common/utils': {
        log: {
          error(...args) {
            logErrors.push(args)
          },
        },
      },
    },
  )

  return {
    runtime,
    actions,
    logErrors,
    getStoreCommits: () => storeCommits,
    getChangeEvents: () => changeEvents,
    getCommittedApiIds: () => committedApiIds,
    getConfigUpdates: () => configUpdates,
    getStateReads: () => stateReads,
    getCurrentApiList: () => currentState.apiList,
    getCurrentState: () => currentState,
  }
}

const oldSerialized = () => [{
  id: 'user_api_old',
  name: 'Old source',
  description: 'Existing local source',
  version: '1.0.0',
  allowShowUpdateAlert: false,
  script: 'old-compressed-script',
}]

const createHarness = (options = {}) => {
  const {
    failStore = false,
    failCompression = false,
    defaultUserApis = [],
    createHashImpl = createHash,
    eventError,
    onDeflate,
  } = options
  const initialStored = Object.prototype.hasOwnProperty.call(options, 'initialStored')
    ? options.initialStored
    : []
  let stored = structuredClone(initialStored)
  const storeSets = []
  let changeEvents = 0
  let deflateCalls = 0
  const logErrors = []
  const store = {
    get(key) {
      assert.strictEqual(key, 'userApis')
      return stored
    },
    set(key, value) {
      assert.strictEqual(key, 'userApis')
      storeSets.push(value)
      if (failStore) throw new Error('simulated store failure')
      stored = value
    },
  }
  const zlib = {
    ...actualZlib,
    deflate(value, callback) {
      deflateCalls++
      if (onDeflate) onDeflate(deflateCalls)
      if (failCompression) {
        callback(new Error('simulated compression failure'))
        return
      }
      actualZlib.deflate(value, callback)
    },
  }

  global.lx = {
    event_app: {
      user_api_changed() {
        changeEvents++
        if (eventError) throw eventError
      },
    },
  }

  const rawUserApiUtils = loadTsModule(
    path.join(__dirname, '../src/main/modules/userApi/utils.ts'),
    {
      './config': { userApis: defaultUserApis },
      '@common/constants': { STORE_NAMES: { USER_API: 'userApi' } },
      '@main/utils/store': () => store,
      '@common/utils/userApiSync': {
        assertUserApiSyncData() {},
        createUserApiSyncData() {},
      },
      '@common/utils': { log: { error: (...args) => logErrors.push(args) } },
      '@common/utils/githubUserApi': githubUserApi,
      'node:zlib': zlib,
      'node:crypto': { createHash: createHashImpl },
    },
  )
  const userApiUtils = {
    ...rawUserApiUtils,
    async replaceApisFromGitHub(items) {
      if (!rawUserApiUtils.prepareApisFromGitHub) {
        return rawUserApiUtils.replaceApisFromGitHub(items)
      }
      const state = await rawUserApiUtils.prepareApisFromGitHub(items)
      const apiList = rawUserApiUtils.commitUserApiState(state)
      rawUserApiUtils.notifyUserApiChanged()
      return apiList
    },
  }


  return {
    userApiUtils,
    storeSets,
    getStored: () => stored,
    getChangeEvents: () => changeEvents,
    getDeflateCalls: () => deflateCalls,
    logErrors,
  }
}

const assertAtomicFailure = async(label, mutate, options = {}) => {
  const harness = createHarness({
    initialStored: oldSerialized(),
    failStore: options.failStore,
    failCompression: options.failCompression,
  })
  const beforeApis = structuredClone(harness.userApiUtils.getUserApis())
  const beforeStored = structuredClone(harness.getStored())
  const input = makeInput()
  mutate(input)

  await assert.rejects(
    () => harness.userApiUtils.replaceApisFromGitHub(input),
    options.expectedError,
    label,
  )
  assert.deepStrictEqual(harness.userApiUtils.getUserApis(), beforeApis, `${label}: memory changed`)
  assert.deepStrictEqual(harness.getStored(), beforeStored, `${label}: store changed`)
  assert.strictEqual(harness.getChangeEvents(), 0, `${label}: change event emitted`)
  assert.strictEqual(
    harness.storeSets.length,
    options.expectedStoreAttempts ?? 0,
    `${label}: unexpected store writes`,
  )
  if (options.expectedDeflateCalls != null) {
    assert.strictEqual(
      harness.getDeflateCalls(),
      options.expectedDeflateCalls,
      `${label}: unexpected compression calls`,
    )
  }
}

const originalLx = global.lx

;(async() => {
  try {
    const harness = createHarness()
    const input = makeInput()
    const next = await harness.userApiUtils.replaceApisFromGitHub(input)

    assert.strictEqual(next.length, 2)
    assert.match(next[0].id, /^user_api_github_[0-9a-f]{16}$/)
    assert.strictEqual(
      next[0].id,
      'user_api_github_' + createHash('sha256')
        .update(input[0].remote.path)
        .digest('hex')
        .substring(0, 16),
    )
    assert.strictEqual(harness.storeSets.length, 1)
    assert.strictEqual(harness.getChangeEvents(), 1)
    assert.deepStrictEqual(next[0].remote, input[0].remote)
    assert.notStrictEqual(next[0].remote, input[0].remote)

    const firstId = next[0].id
    const repeated = await harness.userApiUtils.replaceApisFromGitHub(makeInput())
    assert.strictEqual(repeated[0].id, firstId)
    assert.strictEqual(harness.storeSets.length, 2)
    assert.strictEqual(harness.getChangeEvents(), 2)

    const aliasHarness = createHarness()
    const aliasResult = await aliasHarness.userApiUtils.replaceApisFromGitHub(makeInput())
    const persistedBeforeMutation = structuredClone(aliasHarness.getStored())
    aliasResult[0].remote.group = 'mutated-in-memory'
    assert.deepStrictEqual(
      aliasHarness.getStored(),
      persistedBeforeMutation,
    )
    assert.strictEqual(aliasHarness.storeSets.length, 1)

    const persistedRemoteApis = oldSerialized()
    persistedRemoteApis[0].remote = makeRemote()
    const coldLoadAliasHarness = createHarness({ initialStored: persistedRemoteApis })
    const coldStoredBeforeMutation = structuredClone(coldLoadAliasHarness.getStored())
    const coldLoadedApis = coldLoadAliasHarness.userApiUtils.getUserApis()
    coldLoadedApis[0].remote.group = 'mutated-after-cold-load'
    assert.deepStrictEqual(
      coldLoadAliasHarness.getStored(),
      coldStoredBeforeMutation,
    )
    assert.strictEqual(coldLoadAliasHarness.storeSets.length, 0)
    assert.strictEqual(coldLoadAliasHarness.getChangeEvents(), 0)

    const invalidScriptPath = `${VERSION}/online/b.js`
    await assertAtomicFailure('invalid script', inputItems => {
      inputItems[1].script = 'console.log("missing metadata header")'
    }, {
      expectedDeflateCalls: 1,
      expectedError: err => {
        assert.strictEqual(err.code, 'GITHUB_INVALID_SCRIPT')
        assert.strictEqual(err.detail, invalidScriptPath)
        assert.strictEqual(err.message, `GITHUB_INVALID_SCRIPT: ${invalidScriptPath}`)
        return true
      },
    })
    await assertAtomicFailure('duplicate path', inputItems => {
      inputItems[1].remote.path = inputItems[0].remote.path
    }, { expectedDeflateCalls: 0 })

    const legacyStored = oldSerialized()
    delete legacyStored[0].version
    legacyStored[0].script = validScript('Legacy source')
    const coldLegacyHarness = createHarness({ initialStored: legacyStored })
    const invalidLegacyInput = makeInput()
    invalidLegacyInput[0].remote.repository = 'someone/another-repository'
    await assert.rejects(
      () => coldLegacyHarness.userApiUtils.replaceApisFromGitHub(invalidLegacyInput),
      undefined,
      'cold legacy invalid batch',
    )
    assert.strictEqual(coldLegacyHarness.storeSets.length, 0)
    assert.deepStrictEqual(coldLegacyHarness.getStored(), legacyStored)
    assert.strictEqual(coldLegacyHarness.getChangeEvents(), 0)

    const defaults = oldSerialized()
    const coldDefaultHarness = createHarness({
      initialStored: undefined,
      defaultUserApis: defaults,
    })
    const invalidDefaultInput = makeInput()
    invalidDefaultInput[1].remote.path = invalidDefaultInput[0].remote.path
    await assert.rejects(
      () => coldDefaultHarness.userApiUtils.replaceApisFromGitHub(invalidDefaultInput),
      undefined,
      'cold default invalid batch',
    )
    assert.strictEqual(coldDefaultHarness.storeSets.length, 0)
    assert.strictEqual(coldDefaultHarness.getStored(), undefined)
    assert.strictEqual(coldDefaultHarness.getChangeEvents(), 0)
    await assertAtomicFailure('wrong repository', inputItems => {
      inputItems[0].remote.repository = 'someone/another-repository'
    }, { expectedDeflateCalls: 0 })
    await assertAtomicFailure('oversized script', inputItems => {
      inputItems[0].script = 'x'.repeat(githubUserApi.GITHUB_USER_API_LIMITS.maxScriptBytes + 1)
    }, { expectedDeflateCalls: 0 })
    await assertAtomicFailure('inconsistent version', inputItems => {
      inputItems[1].remote.version = 'v260725'
      inputItems[1].remote.path = 'v260725/online/b.js'
    }, { expectedDeflateCalls: 0 })
    await assertAtomicFailure('inconsistent commit', inputItems => {
      inputItems[1].remote.commitSha = 'd'.repeat(40)
    }, { expectedDeflateCalls: 0 })
    await assertAtomicFailure('invalid path', inputItems => {
      inputItems[0].remote.path = `${VERSION}/${RECOMMENDED_GROUP}/not-javascript.txt`
    }, { expectedDeflateCalls: 0 })
    await assertAtomicFailure('invalid group', inputItems => {
      inputItems[0].remote.group = 'online'
    }, { expectedDeflateCalls: 0 })
    await assertAtomicFailure('malformed Unicode path and group', inputItems => {
      const malformedGroup = 'group-\ud800'
      inputItems[0].remote.group = malformedGroup
      inputItems[0].remote.path = `${VERSION}/${malformedGroup}/a.js`
    }, { expectedDeflateCalls: 0 })

    const astralGroup = 'music-\ud83c\udfb5'
    const astralHarness = createHarness()
    const astralInput = [{
      script: validScript('Astral source'),
      remote: makeRemote({
        group: astralGroup,
        path: `${VERSION}/${astralGroup}/astral.js`,
      }),
    }]
    const astralResult = await astralHarness.userApiUtils.replaceApisFromGitHub(astralInput)
    assert.strictEqual(astralResult.length, 1)
    assert.strictEqual(astralHarness.storeSets.length, 1)
    assert.strictEqual(astralHarness.getChangeEvents(), 1)
    const collisionHarness = createHarness({
      createHashImpl() {
        return {
          update() {
            return this
          },
          digest() {
            return '0'.repeat(64)
          },
        }
      },
    })
    await assert.rejects(
      () => collisionHarness.userApiUtils.replaceApisFromGitHub(makeInput()),
      /duplicate GitHub user API ID/,
    )
    assert.strictEqual(collisionHarness.storeSets.length, 0)
    assert.strictEqual(collisionHarness.getChangeEvents(), 0)
    assert.strictEqual(collisionHarness.getDeflateCalls(), 0)


    const notificationError = new Error('simulated notification failure')
    const eventFailureHarness = createHarness({ eventError: notificationError })
    const eventFailureResult = await eventFailureHarness.userApiUtils
      .replaceApisFromGitHub(makeInput())
    assert.strictEqual(eventFailureResult.length, 2)
    assert.deepStrictEqual(
      eventFailureHarness.userApiUtils.getUserApis(),
      eventFailureResult,
    )
    assert.strictEqual(eventFailureHarness.getStored().length, 2)
    assert.strictEqual(eventFailureHarness.storeSets.length, 1)
    assert.strictEqual(eventFailureHarness.getChangeEvents(), 1)
    assert.strictEqual(eventFailureHarness.logErrors.length, 1)

    await assertAtomicFailure('inherited item fields', inputItems => {
      inputItems[0] = Object.create(inputItems[0])
    }, { expectedDeflateCalls: 0 })
    await assertAtomicFailure('inherited remote fields', inputItems => {
      inputItems[0].remote = Object.create(inputItems[0].remote)
    }, { expectedDeflateCalls: 0 })

    let getterReads = 0
    await assertAtomicFailure('getter-backed remote field', inputItems => {
      const remote = { ...inputItems[0].remote }
      Object.defineProperty(remote, 'path', {
        enumerable: true,
        get() {
          getterReads++
          return `${VERSION}/${RECOMMENDED_GROUP}/a.js`
        },
      })
      inputItems[0].remote = remote
    }, { expectedDeflateCalls: 0 })
    assert.strictEqual(getterReads, 0)
    let symbolGetterReads = 0
    await assertAtomicFailure('symbol accessor item', inputItems => {
      Object.defineProperty(inputItems[0], Symbol('item'), {
        enumerable: true,
        get() {
          symbolGetterReads++
          return 'hidden'
        },
      })
    }, { expectedDeflateCalls: 0 })
    await assertAtomicFailure('symbol accessor remote', inputItems => {
      Object.defineProperty(inputItems[0].remote, Symbol('remote'), {
        enumerable: true,
        get() {
          symbolGetterReads++
          return 'hidden'
        },
      })
    }, { expectedDeflateCalls: 0 })
    assert.strictEqual(symbolGetterReads, 0)

    let mutableInput
    const snapshotHarness = createHarness({
      onDeflate(call) {
        if (call != 1) return
        mutableInput[1].script = 'invalid after validation'
        mutableInput[1].remote.group = 'mutated'
        mutableInput[1].remote.path = `${VERSION}/mutated/b.js`
      },
    })
    mutableInput = makeInput()
    const originalSecondItem = structuredClone(mutableInput[1])
    const snapshotResult = await snapshotHarness.userApiUtils
      .replaceApisFromGitHub(mutableInput)
    assert.strictEqual(snapshotResult.length, 2)
    assert.strictEqual(snapshotResult[1].name, 'Source B')
    assert.deepStrictEqual(snapshotResult[1].remote, originalSecondItem.remote)
    assert.deepStrictEqual(
      snapshotHarness.getStored()[1].remote,
      originalSecondItem.remote,
    )
    assert.strictEqual(snapshotHarness.storeSets.length, 1)
    assert.strictEqual(snapshotHarness.getChangeEvents(), 1)

    await assertAtomicFailure('invalid SHA', inputItems => {
      inputItems[0].remote.blobSha = 'not-a-sha'
    }, { expectedDeflateCalls: 0 })
    await assertAtomicFailure('compression failure', () => {}, {
      failCompression: true,
      expectedDeflateCalls: 1,
    })
    await assertAtomicFailure('store failure', () => {}, {
      failStore: true,
      expectedStoreAttempts: 1,
      expectedDeflateCalls: 2,
    })
    const retainedRuntime = createRuntimeHarness()
    const retainedList = await retainedRuntime.runtime.replaceApisFromGitHub(makeInput())
    assert.deepStrictEqual(retainedList, [{ id: 'stable-id' }])
    assert.deepStrictEqual(retainedRuntime.actions, ['replace'])

    const changedRuntime = createRuntimeHarness({
      replacementScripts: [{ 'stable-id': 'script:stable-id:changed' }],
    })
    await changedRuntime.runtime.replaceApisFromGitHub(makeInput())
    assert.deepStrictEqual(changedRuntime.actions, [
      'replace',
      'invalidate:stable-id:sourceChanged',
    ])

    const removedRuntime = createRuntimeHarness({ replacementSteps: [[]] })
    const removedList = await removedRuntime.runtime.replaceApisFromGitHub(makeInput())
    assert.deepStrictEqual(removedList, [])
    assert.deepStrictEqual(removedRuntime.actions, [
      'replace',
      'dispose:stable-id:true',
    ])

    const commitError = new Error('simulated commit failure')
    const failedRuntime = createRuntimeHarness({
      replacementScripts: [{ 'stable-id': 'script:stable-id:changed' }],
      commitSteps: [commitError],
    })
    await assert.rejects(
      () => failedRuntime.runtime.replaceApisFromGitHub(makeInput()),
      commitError,
    )
    assert.deepStrictEqual(failedRuntime.actions, ['replace'])
    assert.deepStrictEqual(await failedRuntime.runtime.getApiList(), [{ id: 'stable-id' }])

    const githubLifecycleError = new Error('simulated GitHub invalidation failure')
    const githubPreviousApis = [
      { id: 'changed-id', name: 'Changed before failure' },
      { id: 'untouched-id', name: 'Untouched before failure' },
    ]
    const githubRollbackRuntime = createRuntimeHarness({
      initialApis: githubPreviousApis,
      initialScripts: {
        'changed-id': 'script:changed-id:old',
        'untouched-id': 'script:untouched-id:old',
      },
      replacementSteps: [[
        { id: 'changed-id', name: 'Changed after commit' },
        { id: 'untouched-id', name: 'Untouched after commit' },
      ]],
      replacementScripts: [{
        'changed-id': 'script:changed-id:new',
        'untouched-id': 'script:untouched-id:old',
      }],
      invalidateSteps: [githubLifecycleError],
    })
    await assert.rejects(
      () => githubRollbackRuntime.runtime.replaceApisFromGitHub(makeInput()),
      error => {
        assert.strictEqual(error, githubLifecycleError)
        return true
      },
    )
    assert.deepStrictEqual(githubRollbackRuntime.getCurrentState(), {
      apiList: githubPreviousApis,
      scripts: new Map([
        ['changed-id', 'script:changed-id:old'],
        ['untouched-id', 'script:untouched-id:old'],
      ]),
    })
    assert.deepStrictEqual(githubRollbackRuntime.actions, [
      'replace',
      'invalidate:changed-id:sourceChanged',
    ])
    assert.deepStrictEqual(githubRollbackRuntime.getCommittedApiIds(), [
      ['changed-id', 'untouched-id'],
      ['changed-id', 'untouched-id'],
    ])
    assert.strictEqual(githubRollbackRuntime.getChangeEvents(), 0)
    assert.deepStrictEqual(githubRollbackRuntime.getConfigUpdates(), [])

    const syncLifecycleError = new Error('simulated sync disposal failure')
    const syncPreviousApis = [
      { id: 'removed-id', name: 'Removed before failure' },
      { id: 'untouched-id', name: 'Untouched before failure' },
    ]
    const syncRollbackRuntime = createRuntimeHarness({
      initialApis: syncPreviousApis,
      initialScripts: {
        'removed-id': 'script:removed-id:old',
        'untouched-id': 'script:untouched-id:old',
      },
      fallbackSources: ['removed-id', 'untouched-id'],
      syncSteps: [[{ id: 'untouched-id', name: 'Untouched after commit' }]],
      disposeSteps: [syncLifecycleError],
    })
    await assert.rejects(
      () => syncRollbackRuntime.runtime.overwriteUserApisFromSync({ apis: [] }),
      error => {
        assert.strictEqual(error, syncLifecycleError)
        return true
      },
    )
    assert.deepStrictEqual(syncRollbackRuntime.getCurrentState(), {
      apiList: syncPreviousApis,
      scripts: new Map([
        ['removed-id', 'script:removed-id:old'],
        ['untouched-id', 'script:untouched-id:old'],
      ]),
    })
    assert.deepStrictEqual(syncRollbackRuntime.actions, [
      'sync',
      'dispose:removed-id:true',
    ])
    assert.strictEqual(syncRollbackRuntime.getChangeEvents(), 0)
    assert.deepStrictEqual(syncRollbackRuntime.getConfigUpdates(), [])

    const deleteLifecycleError = new Error('simulated direct deletion disposal failure')
    const deletePreviousApis = [
      { id: 'removed-id', name: 'Removed before failure' },
      { id: 'untouched-id', name: 'Untouched before failure' },
    ]
    const deleteRollbackRuntime = createRuntimeHarness({
      initialApis: deletePreviousApis,
      initialScripts: {
        'removed-id': 'script:removed-id:old',
        'untouched-id': 'script:untouched-id:old',
      },
      fallbackSources: ['removed-id', 'untouched-id'],
      disposeSteps: [deleteLifecycleError],
    })
    await assert.rejects(
      () => deleteRollbackRuntime.runtime.removeApi(['removed-id']),
      error => {
        assert.strictEqual(error, deleteLifecycleError)
        return true
      },
    )
    assert.deepStrictEqual(deleteRollbackRuntime.getCurrentState(), {
      apiList: deletePreviousApis,
      scripts: new Map([
        ['removed-id', 'script:removed-id:old'],
        ['untouched-id', 'script:untouched-id:old'],
      ]),
    })
    assert.deepStrictEqual(deleteRollbackRuntime.actions, [
      'dispose:removed-id:true',
    ])
    assert.strictEqual(deleteRollbackRuntime.getChangeEvents(), 0)
    assert.deepStrictEqual(deleteRollbackRuntime.getConfigUpdates(), [])

    const lifecycleGate = createDeferred()
    const serializedLifecycleError = new Error('simulated deferred lifecycle failure')
    const lifecycleSerializedRuntime = createRuntimeHarness({
      replacementSteps: [[{ id: 'stable-id' }]],
      replacementScripts: [{ 'stable-id': 'script:stable-id:new' }],
      invalidateSteps: [() => lifecycleGate.promise],
      syncSteps: [[{ id: 'sync-id' }]],
    })
    const lifecycleFirstWrite = lifecycleSerializedRuntime.runtime
      .replaceApisFromGitHub(makeInput())
    const lifecycleFirstRejected = assert.rejects(lifecycleFirstWrite, error => {
      assert.strictEqual(error, serializedLifecycleError)
      return true
    })
    await waitForAsyncTurn()
    const lifecycleSecondWrite = lifecycleSerializedRuntime.runtime
      .overwriteUserApisFromSync({ apis: [] })
    await waitForAsyncTurn()
    assert.deepStrictEqual(lifecycleSerializedRuntime.actions, [
      'replace',
      'invalidate:stable-id:sourceChanged',
    ])
    assert.deepStrictEqual(lifecycleSerializedRuntime.getCommittedApiIds(), [['stable-id']])
    lifecycleGate.reject(serializedLifecycleError)
    await Promise.all([lifecycleFirstRejected, lifecycleSecondWrite])
    assert.deepStrictEqual(lifecycleSerializedRuntime.getCommittedApiIds(), [
      ['stable-id'],
      ['stable-id'],
      ['sync-id'],
    ])
    assert.deepStrictEqual(await lifecycleSerializedRuntime.runtime.getApiList(), [{ id: 'sync-id' }])

    const secondLifecycleGate = createDeferred()
    const firstParallelLifecycleError = new Error('simulated first parallel lifecycle failure')
    const parallelLifecycleRuntime = createRuntimeHarness({
      initialApis: [{ id: 'first-id' }, { id: 'second-id' }, { id: 'untouched-id' }],
      replacementSteps: [[
        { id: 'first-id' },
        { id: 'second-id' },
        { id: 'untouched-id' },
      ]],
      replacementScripts: [{
        'first-id': 'script:first-id:new',
        'second-id': 'script:second-id:new',
        'untouched-id': 'script:untouched-id:old',
      }],
      invalidateSteps: [firstParallelLifecycleError, () => secondLifecycleGate.promise],
      syncSteps: [[{ id: 'sync-after-settlement' }]],
    })
    const parallelFirstWrite = parallelLifecycleRuntime.runtime
      .replaceApisFromGitHub(makeInput())
    const parallelFirstRejected = assert.rejects(parallelFirstWrite, error => {
      assert.strictEqual(error, firstParallelLifecycleError)
      return true
    })
    await waitForAsyncTurn()
    const parallelSecondWrite = parallelLifecycleRuntime.runtime
      .overwriteUserApisFromSync({ apis: [] })
    await waitForAsyncTurn()
    assert.deepStrictEqual(parallelLifecycleRuntime.actions, [
      'replace',
      'invalidate:first-id:sourceChanged',
      'invalidate:second-id:sourceChanged',
    ])
    assert.deepStrictEqual(parallelLifecycleRuntime.getCommittedApiIds(), [
      ['first-id', 'second-id', 'untouched-id'],
    ])
    secondLifecycleGate.resolve()
    await Promise.all([parallelFirstRejected, parallelSecondWrite])
    assert.deepStrictEqual(parallelLifecycleRuntime.getCommittedApiIds(), [
      ['first-id', 'second-id', 'untouched-id'],
      ['first-id', 'second-id', 'untouched-id'],
      ['sync-after-settlement'],
    ])

    const compensationError = new Error('simulated lifecycle compensation commit failure')
    const compensationLifecycleError = new Error('simulated lifecycle failure before compensation')
    const forwardApiList = [{ id: 'stable-id', name: 'Forward committed source' }]
    const compensationFailureRuntime = createRuntimeHarness({
      replacementSteps: [forwardApiList],
      replacementScripts: [{ 'stable-id': 'script:stable-id:new' }],
      invalidateSteps: [compensationLifecycleError],
      commitSteps: [undefined, compensationError],
    })
    await assert.rejects(
      () => compensationFailureRuntime.runtime.replaceApisFromGitHub(makeInput()),
      error => {
        assert.strictEqual(error, compensationLifecycleError)
        return true
      },
    )
    assert.deepStrictEqual(compensationFailureRuntime.getCurrentState(), {
      apiList: forwardApiList,
      scripts: new Map([['stable-id', 'script:stable-id:new']]),
    })
    assert.deepStrictEqual(
      compensationFailureRuntime.runtime
        .takeReplacementFailureApiList(compensationLifecycleError),
      forwardApiList,
    )
    assert.strictEqual(
      compensationFailureRuntime.runtime
        .takeReplacementFailureApiList(compensationLifecycleError),
      undefined,
    )
    assert.strictEqual(compensationFailureRuntime.getChangeEvents(), 1)
    assert.strictEqual(compensationFailureRuntime.logErrors.length, 1)

    const directRemoveRuntime = createRuntimeHarness()
    const removedAfterDirectDelete = await directRemoveRuntime.runtime.removeApi(['stable-id'])
    assert.deepStrictEqual(removedAfterDirectDelete, [])
    assert.deepStrictEqual(directRemoveRuntime.actions, [
      'dispose:stable-id:true',
    ])
    assert.strictEqual(directRemoveRuntime.getChangeEvents(), 1)

    const noOpRemoveRuntime = createRuntimeHarness()
    const listAfterNoOpDelete = await noOpRemoveRuntime.runtime.removeApi(['missing-id'])
    assert.deepStrictEqual(listAfterNoOpDelete, [{ id: 'stable-id' }])
    assert.deepStrictEqual(noOpRemoveRuntime.actions, [])
    assert.strictEqual(noOpRemoveRuntime.getStoreCommits(), 0)
    assert.strictEqual(noOpRemoveRuntime.getChangeEvents(), 0)

    const firstPreparation = createDeferred()
    const serializedRuntime = createRuntimeHarness({
      initialApis: [],
      replacementSteps: [() => firstPreparation.promise],
      syncSteps: [[{ id: 'sync-id' }]],
    })
    const firstWrite = serializedRuntime.runtime.replaceApisFromGitHub(makeInput())
    await waitForAsyncTurn()
    const secondWrite = serializedRuntime.runtime.overwriteUserApisFromSync({ apis: [] })
    await waitForAsyncTurn()
    assert.deepStrictEqual(serializedRuntime.actions, ['replace'])
    firstPreparation.resolve([{ id: 'github-id' }])
    await Promise.all([firstWrite, secondWrite])
    assert.deepStrictEqual(serializedRuntime.actions, [
      'replace',
      'sync',
      'dispose:github-id:true',
    ])
    assert.deepStrictEqual(serializedRuntime.getCommittedApiIds(), [
      ['github-id'],
      ['sync-id'],
    ])
    assert.deepStrictEqual(await serializedRuntime.runtime.getApiList(), [{ id: 'sync-id' }])

    console.log('GitHub user API replacement tests passed')
  } finally {
    global.lx = originalLx
  }
})().catch(err => {
  console.error(err)
  process.exit(1)
})
