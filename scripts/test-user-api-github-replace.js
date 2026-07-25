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

const createRuntimeHarness = (replacementSteps = [[{
  id: 'stable-id',
}]]) => {
  const actions = []
  let replacementCall = 0
  const stableApi = {
    id: 'stable-id',
  }
  const runtime = loadTsModule(
    path.join(__dirname, '../src/main/modules/userApi/index.ts'),
    {
      './main': {
        async closeWindow() {
          actions.push('close')
        },
      },
      './utils': {
        getUserApis: () => [stableApi],
        async importApi() {},
        removeApi() {},
        setAllowShowUpdateAlert() {},
        async replaceApisFromGitHub(items) {
          actions.push('replace')
          const step = replacementSteps[replacementCall++]
          if (step instanceof Error) throw step
          return step
        },
      },
      './rendererEvent/rendererEvent': {
        async loadApi(id) {
          actions.push('load:' + id)
        },
        setAllowShowUpdateAlert() {},
        init() {},
      },
    },
  )

  return {
    runtime,
    actions,
    selectStableApi: async() => {
      await runtime.setApi(stableApi.id)
      actions.length = 0
    },
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

  const userApiUtils = loadTsModule(
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
    undefined,
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

    await assertAtomicFailure('invalid script', inputItems => {
      inputItems[1].script = 'console.log("missing metadata header")'
    }, { expectedDeflateCalls: 1 })
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
    await retainedRuntime.selectStableApi()
    const retainedList = await retainedRuntime.runtime.replaceApisFromGitHub(makeInput())
    assert.deepStrictEqual(retainedList, [{ id: 'stable-id' }])
    assert.deepStrictEqual(retainedRuntime.actions, [
      'replace',
      'close',
      'load:stable-id',
    ])

    const removedRuntime = createRuntimeHarness([[]])
    await removedRuntime.selectStableApi()
    const removedList = await removedRuntime.runtime.replaceApisFromGitHub(makeInput())
    assert.deepStrictEqual(removedList, [])
    assert.deepStrictEqual(removedRuntime.actions, ['replace', 'close'])

    const replacementError = new Error('simulated runtime replacement failure')
    const failedRuntime = createRuntimeHarness([
      replacementError,
      [{ id: 'stable-id' }],
    ])
    await failedRuntime.selectStableApi()
    await assert.rejects(
      () => failedRuntime.runtime.replaceApisFromGitHub(makeInput()),
      replacementError,
    )
    assert.deepStrictEqual(failedRuntime.actions, ['replace'])
    failedRuntime.actions.length = 0
    await failedRuntime.runtime.replaceApisFromGitHub(makeInput())
    assert.deepStrictEqual(failedRuntime.actions, [
      'replace',
      'close',
      'load:stable-id',
    ])

    const inactiveRuntime = createRuntimeHarness()
    const inactiveList = await inactiveRuntime.runtime.replaceApisFromGitHub(makeInput())
    assert.deepStrictEqual(inactiveList, [{ id: 'stable-id' }])
    assert.deepStrictEqual(inactiveRuntime.actions, ['replace'])

    console.log('GitHub user API replacement tests passed')
  } finally {
    global.lx = originalLx
  }
})().catch(err => {
  console.error(err)
  process.exit(1)
})
