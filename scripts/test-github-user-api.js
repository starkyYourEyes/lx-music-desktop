const assert = require('node:assert')

const {
  GITHUB_USER_API_LIMITS,
  createGitHubUserApiError,
  parseGitHubUserApiSnapshot,
  buildGitHubUserApiRawUrl,
  downloadGitHubUserApiScripts,
} = require('../src/common/utils/githubUserApi')

const repository = 'Macrohard0001/lx-ikun-music-sources'
const commitSha = 'a'.repeat(40)

const expectGitHubError = code => err => {
  assert.strictEqual(err?.code, code)
  return true
}

const createTreeData = (entries, truncated = false) => ({
  truncated,
  tree: entries,
})
const createTreeEntry = path => ({
  type: 'tree',
  path,
  sha: '9'.repeat(40),
})

const createSnapshot = files => ({
  commitSha,
  version: 'v260724',
  files,
})

const treeData = createTreeData([
  createTreeEntry('V260506'),
  createTreeEntry('v260724'),
  createTreeEntry('notes'),
  createTreeEntry('v260724/V260720-其他'),
  createTreeEntry('v260724/V260720-推荐'),
  createTreeEntry('v260724/online'),
  {
    type: 'blob',
    path: 'v260724/V260720-其他/中文 音源.js',
    sha: 'b'.repeat(40),
    size: 120,
  },
  {
    type: 'blob',
    path: 'v260724/V260720-推荐/recommend.JS',
    sha: 'c'.repeat(40),
    size: 220,
  },
  {
    type: 'blob',
    path: 'v260724/online/latest.js',
    sha: 'd'.repeat(40),
    size: 320,
  },
  {
    type: 'blob',
    path: 'v260724/direct.js',
    sha: 'e'.repeat(40),
    size: 20,
  },
  { type: 'blob', path: 'v260724/report.png', sha: 'f'.repeat(40), size: 420 },
  { type: 'blob', path: 'outside.js', sha: '0'.repeat(40), size: 10 },
])

assert.deepStrictEqual(GITHUB_USER_API_LIMITS, {
  maxScriptBytes: 9_000_000,
  maxFiles: 200,
  maxTotalBytes: 50_000_000,
  maxConcurrency: 4,
})
assert(Object.isFrozen(GITHUB_USER_API_LIMITS))

const customError = createGitHubUserApiError('GITHUB_TEST', 'detail')
assert(customError instanceof Error)
assert.strictEqual(customError.code, 'GITHUB_TEST')
assert.strictEqual(customError.detail, 'detail')
assert.match(customError.message, /GITHUB_TEST: detail/)

const snapshot = parseGitHubUserApiSnapshot(
  { commit: { sha: commitSha } },
  treeData,
)

assert.strictEqual(snapshot.version, 'v260724')
assert.strictEqual(snapshot.commitSha, commitSha)
assert.deepStrictEqual(snapshot.files, [
  {
    path: 'v260724/V260720-其他/中文 音源.js',
    blobSha: 'b'.repeat(40),
    size: 120,
    group: 'V260720-其他',
  },
  {
    path: 'v260724/V260720-推荐/recommend.JS',
    blobSha: 'c'.repeat(40),
    size: 220,
    group: 'V260720-推荐',
  },
  {
    path: 'v260724/online/latest.js',
    blobSha: 'd'.repeat(40),
    size: 320,
    group: 'online',
  },
  {
    path: 'v260724/direct.js',
    blobSha: 'e'.repeat(40),
    size: 20,
    group: 'v260724',
  },
])

assert.strictEqual(
  buildGitHubUserApiRawUrl(commitSha, snapshot.files[0].path),
  `https://raw.githubusercontent.com/${repository}/${commitSha}/v260724/V260720-%E5%85%B6%E4%BB%96/%E4%B8%AD%E6%96%87%20%E9%9F%B3%E6%BA%90.js`,
)
assert.throws(
  () => buildGitHubUserApiRawUrl('bad', snapshot.files[0].path),
  expectGitHubError('GITHUB_INVALID_RESPONSE'),
)

assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, createTreeData([], true)),
  expectGitHubError('GITHUB_TREE_TRUNCATED'),
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, createTreeData([])),
  expectGitHubError('GITHUB_VERSION_NOT_FOUND'),
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: 'bad' } }, createTreeData([])),
  expectGitHubError('GITHUB_INVALID_RESPONSE'),
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, null),
  expectGitHubError('GITHUB_INVALID_RESPONSE'),
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, createTreeData([null])),
  expectGitHubError('GITHUB_INVALID_RESPONSE'),
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, createTreeData([
    createTreeEntry('v260724'),
    { type: 'blob', path: 'v260724/group/bad.js', sha: 'bad', size: 1 },
  ])),
  expectGitHubError('GITHUB_INVALID_RESPONSE'),
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, createTreeData([
    createTreeEntry('v260724'),
    { type: 'commit', path: 'v260724/submodule', sha: 'bad' },
    {
      type: 'blob',
      path: 'v260724/group/valid.js',
      sha: '1'.repeat(40),
      size: 1,
    },
  ])),
  expectGitHubError('GITHUB_INVALID_RESPONSE'),
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, createTreeData([
    { type: 'tree', path: 'v260724', sha: 'bad' },
    {
      type: 'blob',
      path: 'v260724/group/valid.js',
      sha: '1'.repeat(40),
      size: 1,
    },
  ])),
  expectGitHubError('GITHUB_INVALID_RESPONSE'),
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, createTreeData([
    createTreeEntry('v260724'),
  ])),
  expectGitHubError('GITHUB_SCRIPTS_NOT_FOUND'),
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, createTreeData([
    createTreeEntry('v260724'),
    ...Array.from({ length: 201 }, (_, index) => ({
      type: 'blob',
      path: `v260724/group/${index}.js`,
      sha: index.toString(16).padStart(40, '0'),
      size: 1,
    })),
  ])),
  expectGitHubError('GITHUB_BATCH_LIMIT'),
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, createTreeData([
    createTreeEntry('v260724'),
    {
      type: 'blob',
      path: 'v260724/group/large.js',
      sha: '1'.repeat(40),
      size: 9_000_001,
    },
  ])),
  expectGitHubError('GITHUB_BATCH_LIMIT'),
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, createTreeData([
    createTreeEntry('v260724'),
    ...Array.from({ length: 6 }, (_, index) => ({
      type: 'blob',
      path: `v260724/group/total-${index}.js`,
      sha: String(index + 1).repeat(40),
      size: 8_500_000,
    })),
  ])),
  expectGitHubError('GITHUB_BATCH_LIMIT'),
)

const main = async() => {
  const concurrencySnapshot = createSnapshot(Array.from({ length: 9 }, (_, index) => ({
    path: `v260724/online/${index}.js`,
    blobSha: index.toString(16).padStart(40, '0'),
    size: 1,
    group: 'online',
  })))
  let active = 0
  let maxActive = 0
  const scripts = await downloadGitHubUserApiScripts(concurrencySnapshot, async file => {
    active++
    maxActive = Math.max(maxActive, active)
    const index = Number.parseInt(file.path.match(/(\d+)\.js$/)[1])
    await new Promise(resolve => setTimeout(resolve, (9 - index) % 4))
    active--
    return `script-${index}`
  })

  assert.strictEqual(maxActive, 4)
  assert.deepStrictEqual(scripts.map(item => item.script), Array.from(
    { length: 9 },
    (_, index) => `script-${index}`,
  ))
  assert.deepStrictEqual(scripts[0].remote, {
    provider: 'github',
    repository,
    version: 'v260724',
    group: 'online',
    path: 'v260724/online/0.js',
    blobSha: '0'.repeat(40),
    commitSha,
  })
  assert.deepStrictEqual(Object.keys(scripts[0].remote), [
    'provider',
    'repository',
    'version',
    'group',
    'path',
    'blobSha',
    'commitSha',
  ])

  const queuedSnapshot = createSnapshot(Array.from({ length: 6 }, (_, index) => ({
    path: `v260724/online/queued-${index}.js`,
    blobSha: index.toString(16).padStart(40, '0'),
    size: 1,
    group: 'online',
  })))
  const started = []
  const controls = []
  let controlledActive = 0
  const controlledDownload = downloadGitHubUserApiScripts(queuedSnapshot, file => {
    const index = Number.parseInt(file.path.match(/(\d+)\.js$/)[1])
    started.push(index)
    controlledActive++
    if (index >= GITHUB_USER_API_LIMITS.maxConcurrency) {
      controlledActive--
      return Promise.resolve(`unexpected-${index}`)
    }
    return new Promise((resolve, reject) => {
      controls[index] = {
        resolve(script) {
          controlledActive--
          resolve(script)
        },
        reject(err) {
          controlledActive--
          reject(err)
        },
      }
    })
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepStrictEqual(started, [0, 1, 2, 3])
  assert.strictEqual(controlledActive, 4)

  const controlledError = new Error('controlled failure')
  let rejectionSettled = false
  const controlledRejection = assert.rejects(
    controlledDownload,
    err => err === controlledError,
  ).then(() => {
    rejectionSettled = true
  })
  controls[0].reject(controlledError)
  await new Promise(resolve => setImmediate(resolve))
  const rejectedBeforeActiveSettled = rejectionSettled
  controls.slice(1).forEach(control => control.resolve('started before failure'))
  await controlledRejection

  assert.strictEqual(rejectedBeforeActiveSettled, false)
  assert.deepStrictEqual(started, [0, 1, 2, 3])
  assert.strictEqual(controlledActive, 0)

  const exactCountSnapshot = parseGitHubUserApiSnapshot(
    { commit: { sha: commitSha } },
    createTreeData([
      createTreeEntry('v260724'),
      ...Array.from({ length: 200 }, (_, index) => ({
        type: 'blob',
        path: `v260724/online/exact-count-${index}.js`,
        sha: index.toString(16).padStart(40, '0'),
        size: 1,
      })),
    ]),
  )
  const exactCountDownloads = await downloadGitHubUserApiScripts(
    exactCountSnapshot,
    async() => 'x',
  )
  assert.strictEqual(exactCountDownloads.length, 200)

  const exactSizes = [9_000_000, 9_000_000, 9_000_000, 9_000_000, 9_000_000, 5_000_000]
  const exactTotalSnapshot = parseGitHubUserApiSnapshot(
    { commit: { sha: commitSha } },
    createTreeData([
      createTreeEntry('v260724'),
      ...exactSizes.map((size, index) => ({
        type: 'blob',
        path: `v260724/online/exact-size-${index}.js`,
        sha: String(index + 1).repeat(40),
        size,
      })),
    ]),
  )
  const exactScript = '\u754c'.repeat(3_000_000)
  const exactRemainder = 'x'.repeat(5_000_000)
  const exactTotalDownloads = await downloadGitHubUserApiScripts(exactTotalSnapshot, async file => {
    return file.size == GITHUB_USER_API_LIMITS.maxScriptBytes ? exactScript : exactRemainder
  })
  assert.strictEqual(Buffer.byteLength(exactTotalDownloads[0].script, 'utf8'), 9_000_000)
  assert.strictEqual(exactTotalDownloads.reduce(
    (total, item) => total + Buffer.byteLength(item.script, 'utf8'),
    0,
  ), 50_000_000)

  const downloadError = new Error('download failed')
  await assert.rejects(
    downloadGitHubUserApiScripts(snapshot, async file => {
      if (file.path.endsWith('latest.js')) throw downloadError
      return '/* @name OK */'
    }),
    err => err === downloadError,
  )
  await assert.rejects(
    downloadGitHubUserApiScripts(snapshot, async() => Buffer.from('not a string')),
    expectGitHubError('GITHUB_INVALID_SCRIPT'),
  )
  await assert.rejects(
    downloadGitHubUserApiScripts(createSnapshot([{
      path: 'v260724/online/large.js',
      blobSha: '1'.repeat(40),
      size: 1,
      group: 'online',
    }]), async() => 'x'.repeat(9_000_001)),
    expectGitHubError('GITHUB_BATCH_LIMIT'),
  )
  await assert.rejects(
    downloadGitHubUserApiScripts(createSnapshot([{
      path: 'v260724/online/unicode-large.js',
      blobSha: '2'.repeat(40),
      size: 1,
      group: 'online',
    }]), async() => '\u754c'.repeat(3_000_001)),
    expectGitHubError('GITHUB_BATCH_LIMIT'),
  )
  await assert.rejects(
    downloadGitHubUserApiScripts(createSnapshot(Array.from({ length: 6 }, (_, index) => ({
      path: `v260724/online/total-${index}.js`,
      blobSha: String(index + 1).repeat(40),
      size: 1,
      group: 'online',
    }))), async() => 'x'.repeat(8_500_000)),
    expectGitHubError('GITHUB_BATCH_LIMIT'),
  )
  let fetched = false
  await assert.rejects(
    downloadGitHubUserApiScripts(createSnapshot(Array.from({ length: 201 }, (_, index) => ({
      path: `v260724/online/${index}.js`,
      blobSha: index.toString(16).padStart(40, '0'),
      size: 1,
      group: 'online',
    }))), async() => {
      fetched = true
      return 'script'
    }),
    expectGitHubError('GITHUB_BATCH_LIMIT'),
  )
  assert.strictEqual(fetched, false)

  console.log('GitHub user API helper tests passed')
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
