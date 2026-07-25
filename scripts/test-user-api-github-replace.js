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

const oldSerialized = () => [{
  id: 'user_api_old',
  name: 'Old source',
  description: 'Existing local source',
  version: '1.0.0',
  allowShowUpdateAlert: false,
  script: 'old-compressed-script',
}]

const createHarness = ({
  initialStored = [],
  failStore = false,
  failCompression = false,
} = {}) => {
  let stored = structuredClone(initialStored)
  const storeSets = []
  let changeEvents = 0
  let deflateCalls = 0
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
      },
    },
  }

  const userApiUtils = loadTsModule(
    path.join(__dirname, '../src/main/modules/userApi/utils.ts'),
    {
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
    },
  )

  return {
    userApiUtils,
    storeSets,
    getStored: () => stored,
    getChangeEvents: () => changeEvents,
    getDeflateCalls: () => deflateCalls,
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

    await assertAtomicFailure('invalid script', inputItems => {
      inputItems[1].script = 'console.log("missing metadata header")'
    }, { expectedDeflateCalls: 1 })
    await assertAtomicFailure('duplicate path', inputItems => {
      inputItems[1].remote.path = inputItems[0].remote.path
    }, { expectedDeflateCalls: 0 })
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

    console.log('GitHub user API replacement tests passed')
  } finally {
    global.lx = originalLx
  }
})().catch(err => {
  console.error(err)
  process.exit(1)
})
