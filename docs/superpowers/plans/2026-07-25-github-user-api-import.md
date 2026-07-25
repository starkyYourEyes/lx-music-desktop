# GitHub Latest Custom Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add connection testing and atomic full replacement from the newest version directory in `Macrohard0001/lx-ikun-music-sources`, then display imported sources in collapsible repository-folder groups.

**Architecture:** A pure CommonJS helper validates GitHub branch/tree responses, selects the newest `v/V + YYMMDD` directory, builds commit-pinned raw URLs, and enforces batch limits. A renderer service uses the existing proxy-aware request client to fetch the snapshot and scripts. One IPC call sends the completed batch to the main process, which parses and compresses every script before one store write and one change event.

**Tech Stack:** Electron 37, Vue 3 Options API with Pug templates, TypeScript/JavaScript, `needle` through the existing renderer request wrapper, Node `assert` scripts, Babel test loader, LESS.

---

## File Structure

- Create `src/common/utils/githubUserApi.js`: pure snapshot parsing, commit-pinned URL creation, bounded concurrent download orchestration, and shared limits.
- Create `src/common/utils/githubUserApi.d.ts`: public types for the CommonJS helper.
- Create `src/renderer/utils/githubUserApi.js`: proxy-aware GitHub API/raw client and HTTP/limit error normalization.
- Create `scripts/test-github-user-api.js`: executable unit tests for snapshot parsing, URL encoding, download concurrency, and renderer HTTP behavior.
- Create `scripts/test-user-api-github-replace.js`: executable tests for atomic replacement and active-runtime reload behavior.
- Create `scripts/test-user-api-github-wiring.js`: IPC, localization, and settings-modal wiring checks.
- Modify `src/common/types/user_api.d.ts`: remote provenance and batch IPC payload types.
- Modify `src/common/types/user_api_sync.d.ts`: carry optional remote provenance through desktop sync.
- Modify `src/common/utils/userApiSync.js`: normalize, validate, hash, and serialize remote provenance.
- Modify `scripts/test-user-api-sync.js`: lock remote provenance into the sync contract.
- Modify `src/main/utils/store.ts`: restore the previous in-memory value when a store write fails.
- Modify `scripts/test-store-validation.js`: verify failed writes do not mutate the store's readable value.
- Modify `src/main/modules/userApi/utils.ts`: validate and atomically persist a complete GitHub batch with stable IDs.
- Modify `src/main/modules/userApi/index.ts`: reload a preserved active source or close a removed active source after replacement.
- Modify `src/common/ipcNames.ts`: add the batch replacement channel.
- Modify `src/main/modules/winMain/rendererEvent/userApi.ts`: register the main-process handler.
- Modify `src/renderer/utils/ipc.ts`: expose the typed renderer wrapper.
- Modify `src/renderer/views/Setting/components/UserApiModal.vue`: add controls, confirmation, status, grouping, and collapse behavior.
- Modify `src/lang/zh-cn.json`, `src/lang/zh-tw.json`, and `src/lang/en-us.json`: add all visible strings and errors.

### Task 1: Lock Snapshot Discovery And Download Rules

**Files:**
- Create: `scripts/test-github-user-api.js`
- Create: `src/common/utils/githubUserApi.js`
- Create: `src/common/utils/githubUserApi.d.ts`

- [ ] **Step 1: Write the failing pure-helper test**

Create `scripts/test-github-user-api.js` with branch/tree fixtures that include `V260506`, `v260724`, a non-version directory, images, a root-level script outside the version, and scripts in all three current groups. Assert the desired API:

```js
const assert = require('node:assert')
const {
  GITHUB_USER_API_LIMITS,
  parseGitHubUserApiSnapshot,
  buildGitHubUserApiRawUrl,
  downloadGitHubUserApiScripts,
} = require('../src/common/utils/githubUserApi')

const commitSha = 'a'.repeat(40)
const snapshot = parseGitHubUserApiSnapshot(
  { commit: { sha: commitSha } },
  {
    truncated: false,
    tree: [
      { type: 'tree', path: 'V260506' },
      { type: 'tree', path: 'v260724' },
      { type: 'tree', path: 'v260724/V260720-其他' },
      { type: 'tree', path: 'v260724/V260720-推荐' },
      { type: 'tree', path: 'v260724/online' },
      { type: 'blob', path: 'v260724/V260720-其他/中文 音源.js', sha: 'b'.repeat(40), size: 120 },
      { type: 'blob', path: 'v260724/V260720-推荐/recommend.JS', sha: 'c'.repeat(40), size: 220 },
      { type: 'blob', path: 'v260724/online/latest.js', sha: 'd'.repeat(40), size: 320 },
      { type: 'blob', path: 'v260724/report.png', sha: 'e'.repeat(40), size: 420 },
      { type: 'blob', path: 'outside.js', sha: 'f'.repeat(40), size: 10 },
    ],
  },
)

assert.strictEqual(snapshot.version, 'v260724')
assert.strictEqual(snapshot.commitSha, commitSha)
assert.deepStrictEqual(snapshot.files.map(file => file.group), [
  'V260720-其他',
  'V260720-推荐',
  'online',
])
assert.strictEqual(
  buildGitHubUserApiRawUrl(commitSha, snapshot.files[0].path),
  `https://raw.githubusercontent.com/Macrohard0001/lx-ikun-music-sources/${commitSha}/v260724/V260720-%E5%85%B6%E4%BB%96/%E4%B8%AD%E6%96%87%20%E9%9F%B3%E6%BA%90.js`,
)
assert.throws(() => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, {
  truncated: true,
  tree: [],
}), err => err.code == 'GITHUB_TREE_TRUNCATED')
assert.strictEqual(GITHUB_USER_API_LIMITS.maxConcurrency, 4)

;(async() => {
  let active = 0
  let maxActive = 0
  const scripts = await downloadGitHubUserApiScripts(snapshot, async file => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setImmediate(resolve))
    active--
    return `/*\n * @name ${file.group}\n */`
  })
  assert.strictEqual(scripts.length, 3)
  assert(maxActive <= 4)
  assert.deepStrictEqual(scripts[0].remote, {
    provider: 'github',
    repository: 'Macrohard0001/lx-ikun-music-sources',
    version: 'v260724',
    group: 'V260720-其他',
    path: 'v260724/V260720-其他/中文 音源.js',
    blobSha: 'b'.repeat(40),
    commitSha,
  })
  console.log('GitHub user API helper tests passed')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
```

Add these concrete boundary assertions below the snapshot assertions:

```js
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, { truncated: false, tree: [] }),
  err => err.code == 'GITHUB_VERSION_NOT_FOUND',
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: 'bad' } }, { truncated: false, tree: [] }),
  err => err.code == 'GITHUB_INVALID_RESPONSE',
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, {
    truncated: false,
    tree: [{ type: 'tree', path: 'v260724' }],
  }),
  err => err.code == 'GITHUB_SCRIPTS_NOT_FOUND',
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, {
    truncated: false,
    tree: [
      { type: 'tree', path: 'v260724' },
      ...Array.from({ length: 201 }, (_, index) => ({
        type: 'blob',
        path: `v260724/group/${index}.js`,
        sha: index.toString(16).padStart(40, '0'),
        size: 1,
      })),
    ],
  }),
  err => err.code == 'GITHUB_BATCH_LIMIT',
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, {
    truncated: false,
    tree: [
      { type: 'tree', path: 'v260724' },
      { type: 'blob', path: 'v260724/group/large.js', sha: '1'.repeat(40), size: 9_000_001 },
    ],
  }),
  err => err.code == 'GITHUB_BATCH_LIMIT',
)
assert.throws(
  () => parseGitHubUserApiSnapshot({ commit: { sha: commitSha } }, {
    truncated: false,
    tree: [
      { type: 'tree', path: 'v260724' },
      ...Array.from({ length: 6 }, (_, index) => ({
        type: 'blob',
        path: `v260724/group/total-${index}.js`,
        sha: String(index + 1).repeat(40),
        size: 8_500_000,
      })),
    ],
  }),
  err => err.code == 'GITHUB_BATCH_LIMIT',
)
;(async() => {
await assert.rejects(
  downloadGitHubUserApiScripts(snapshot, async file => {
    if (file.path.endsWith('latest.js')) throw new Error('download failed')
    return '/*\n * @name OK\n */'
  }),
  /download failed/,
)
await assert.rejects(
  downloadGitHubUserApiScripts(snapshot, async() => 'x'.repeat(9_000_001)),
  err => err.code == 'GITHUB_BATCH_LIMIT',
)
})().catch(err => {
  console.error(err)
  process.exitCode = 1
})

```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/test-github-user-api.js`

Expected: FAIL with `Cannot find module '../src/common/utils/githubUserApi'`.

- [ ] **Step 3: Implement the pure helper**

Create `src/common/utils/githubUserApi.js` with these exports and exact limits:

```js
const REPOSITORY = 'Macrohard0001/lx-ikun-music-sources'
const VERSION_RXP = /^[vV](\d{6})$/
const SHA_RXP = /^[0-9a-f]{40}$/i

const GITHUB_USER_API_LIMITS = Object.freeze({
  maxScriptBytes: 9_000_000,
  maxFiles: 200,
  maxTotalBytes: 50_000_000,
  maxConcurrency: 4,
})

const createGitHubUserApiError = (code, detail = '') => Object.assign(
  new Error(detail ? `${code}: ${detail}` : code),
  { code, detail },
)

const parseGitHubUserApiSnapshot = (branchData, treeData) => {
  const commitSha = branchData?.commit?.sha
  if (!SHA_RXP.test(commitSha ?? '')) throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'commit SHA')
  if (!treeData || !Array.isArray(treeData.tree)) throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'tree')
  if (treeData.truncated === true) throw createGitHubUserApiError('GITHUB_TREE_TRUNCATED')

  const versions = treeData.tree.flatMap(item => {
    if (item?.type != 'tree' || typeof item.path != 'string' || item.path.includes('/')) return []
    const match = VERSION_RXP.exec(item.path)
    return match ? [{ path: item.path, number: Number(match[1]) }] : []
  }).sort((a, b) => b.number - a.number || b.path.localeCompare(a.path))
  if (!versions.length) throw createGitHubUserApiError('GITHUB_VERSION_NOT_FOUND')

  const version = versions[0].path
  const prefix = version + '/'
  const files = treeData.tree.flatMap(item => {
    if (item?.type != 'blob' || typeof item.path != 'string' ||
      !item.path.startsWith(prefix) || !/\.js$/i.test(item.path)) return []
    if (!SHA_RXP.test(item.sha ?? '') || !Number.isSafeInteger(item.size) || item.size < 0) {
      throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', item.path)
    }
    if (item.size > GITHUB_USER_API_LIMITS.maxScriptBytes) {
      throw createGitHubUserApiError('GITHUB_BATCH_LIMIT', item.path)
    }
    const relativeParts = item.path.substring(prefix.length).split('/')
    return [{
      path: item.path,
      blobSha: item.sha,
      size: item.size,
      group: relativeParts.length > 1 ? relativeParts[0] : version,
    }]
  })
  if (!files.length) throw createGitHubUserApiError('GITHUB_SCRIPTS_NOT_FOUND')
  const declaredBytes = files.reduce((total, file) => total + file.size, 0)
  if (files.length > GITHUB_USER_API_LIMITS.maxFiles || declaredBytes > GITHUB_USER_API_LIMITS.maxTotalBytes) {
    throw createGitHubUserApiError('GITHUB_BATCH_LIMIT')
  }
  return { commitSha, version, files }
}

const buildGitHubUserApiRawUrl = (commitSha, filePath) => {
  if (!SHA_RXP.test(commitSha)) throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'commit SHA')
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${REPOSITORY}/${commitSha}/${encodedPath}`
}

const downloadGitHubUserApiScripts = async(snapshot, fetchScript) => {
  const results = new Array(snapshot.files.length)
  let nextIndex = 0
  let totalBytes = 0
  const worker = async() => {
    while (nextIndex < snapshot.files.length) {
      const index = nextIndex++
      const file = snapshot.files[index]
      const script = await fetchScript(file)
      if (typeof script != 'string') throw createGitHubUserApiError('GITHUB_INVALID_SCRIPT', file.path)
      const bytes = Buffer.byteLength(script, 'utf8')
      if (bytes > GITHUB_USER_API_LIMITS.maxScriptBytes) {
        throw createGitHubUserApiError('GITHUB_BATCH_LIMIT', file.path)
      }
      totalBytes += bytes
      if (totalBytes > GITHUB_USER_API_LIMITS.maxTotalBytes) {
        throw createGitHubUserApiError('GITHUB_BATCH_LIMIT')
      }
      results[index] = {
        script,
        remote: {
          provider: 'github',
          repository: REPOSITORY,
          version: snapshot.version,
          group: file.group,
          path: file.path,
          blobSha: file.blobSha,
          commitSha: snapshot.commitSha,
        },
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(GITHUB_USER_API_LIMITS.maxConcurrency, snapshot.files.length) },
    worker,
  ))
  return results
}

module.exports = {
  GITHUB_USER_API_LIMITS,
  createGitHubUserApiError,
  parseGitHubUserApiSnapshot,
  buildGitHubUserApiRawUrl,
  downloadGitHubUserApiScripts,
}
```

Create `src/common/utils/githubUserApi.d.ts` with `GitHubUserApiSnapshot`, `GitHubUserApiSnapshotFile`, `GitHubUserApiDownload`, `GitHubUserApiError`, limits, and function signatures. Define the download item's `remote` object structurally in this declaration so Task 1 type-checks before Task 3 adds the shared `LX.UserApi.GitHubImportItem` IPC type.

- [ ] **Step 4: Run the helper test and verify GREEN**

Run: `node scripts/test-github-user-api.js`

Expected: PASS with `GitHub user API helper tests passed`.

- [ ] **Step 5: Commit the helper**

```bash
git add scripts/test-github-user-api.js src/common/utils/githubUserApi.js src/common/utils/githubUserApi.d.ts
git commit -m "feat: add GitHub custom source snapshot helpers"
```

### Task 2: Add The Proxy-Aware GitHub Client

**Files:**
- Modify: `scripts/test-github-user-api.js`
- Create: `src/renderer/utils/githubUserApi.js`

- [ ] **Step 1: Extend the test with failing renderer-client cases**

Load the renderer module through `scripts/test-utils/load-ts-module.js`, mock `./request`, and provide the real common helper as the alias mock. Assert:

```js
const loadModule = require('./test-utils/load-ts-module')
const commonHelper = require('../src/common/utils/githubUserApi')

const responses = new Map()
const requested = []
const httpFetch = (url, options) => {
  requested.push([url, options])
  return { promise: Promise.resolve(responses.get(url)) }
}
const { createGitHubUserApiClient } = loadModule(
  require('node:path').join(__dirname, '../src/renderer/utils/githubUserApi.js'),
  {
    './request': { httpFetch },
    '@common/utils/githubUserApi': commonHelper,
  },
)

const client = createGitHubUserApiClient(httpFetch)
```

Cover successful branch/tree discovery, commit-pinned raw downloads, the `Accept: application/vnd.github+json` header, a non-200 API response, a 403 response with `x-ratelimit-remaining: 0`, and a non-200 raw response. Assert the rate-limit error code is `GITHUB_RATE_LIMIT` and other HTTP failures use `GITHUB_HTTP_ERROR`.

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/test-github-user-api.js`

Expected: FAIL because `src/renderer/utils/githubUserApi.js` does not exist.

- [ ] **Step 3: Implement the renderer client**

Create `src/renderer/utils/githubUserApi.js` around the existing request wrapper:

```js
import { httpFetch } from './request'
import {
  createGitHubUserApiError,
  parseGitHubUserApiSnapshot,
  buildGitHubUserApiRawUrl,
  downloadGitHubUserApiScripts,
} from '@common/utils/githubUserApi'

const branchUrl = 'https://api.github.com/repos/Macrohard0001/lx-ikun-music-sources/branches/main'
const apiHeaders = { Accept: 'application/vnd.github+json' }

const assertResponse = (response, url) => {
  if (response?.statusCode == 200) return response
  if (response?.statusCode == 403 && response?.headers?.['x-ratelimit-remaining'] == '0') {
    throw createGitHubUserApiError('GITHUB_RATE_LIMIT', response.headers['x-ratelimit-reset'] ?? '')
  }
  throw createGitHubUserApiError('GITHUB_HTTP_ERROR', `${response?.statusCode ?? 0} ${url}`)
}

export const createGitHubUserApiClient = (request = httpFetch) => ({
  async getSnapshot() {
    const branch = assertResponse(await request(branchUrl, {
      headers: apiHeaders,
      follow_max: 3,
      timeout: 15_000,
    }).promise, branchUrl).body
    const commitSha = branch?.commit?.sha
    if (!/^[0-9a-f]{40}$/i.test(commitSha ?? '')) {
      throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'commit SHA')
    }
    const treeUrl = `https://api.github.com/repos/Macrohard0001/lx-ikun-music-sources/git/trees/${commitSha}?recursive=1`
    const tree = assertResponse(await request(treeUrl, {
      headers: apiHeaders,
      follow_max: 3,
      timeout: 15_000,
    }).promise, treeUrl).body
    return parseGitHubUserApiSnapshot(branch, tree)
  },
  async downloadSnapshot(snapshot) {
    return downloadGitHubUserApiScripts(snapshot, async file => {
      const url = buildGitHubUserApiRawUrl(snapshot.commitSha, file.path)
      const response = assertResponse(await request(url, {
        format: 'text',
        follow_max: 3,
        timeout: 30_000,
      }).promise, url)
      if (typeof response.body != 'string') throw createGitHubUserApiError('GITHUB_INVALID_SCRIPT', file.path)
      return response.body
    })
  },
})

const client = createGitHubUserApiClient()
export const getGitHubUserApiSnapshot = () => client.getSnapshot()
export const downloadGitHubUserApiSnapshot = snapshot => client.downloadSnapshot(snapshot)
```

- [ ] **Step 4: Run the combined test and verify GREEN**

Run: `node scripts/test-github-user-api.js`

Expected: PASS.

- [ ] **Step 5: Commit the client**

```bash
git add scripts/test-github-user-api.js src/renderer/utils/githubUserApi.js
git commit -m "feat: add GitHub custom source client"
```

### Task 3: Make Store Writes And Batch Replacement Atomic

**Files:**
- Modify: `scripts/test-store-validation.js`
- Create: `scripts/test-user-api-github-replace.js`
- Modify: `src/main/utils/store.ts`
- Modify: `src/common/types/user_api.d.ts`
- Modify: `src/main/modules/userApi/utils.ts`

- [ ] **Step 1: Write failing store rollback coverage**

Extend `scripts/test-store-validation.js` after the existing root validation loop. Create a store, save `value: 'before'`, replace `fs.renameSync` with a function that throws `simulated write failure`, call `store.set('value', 'after')`, restore `renameSync` in `finally`, and assert `store.get('value') == 'before'`.

- [ ] **Step 2: Write the failing batch replacement test**

Create `scripts/test-user-api-github-replace.js`. Load `src/main/modules/userApi/utils.ts` through `load-ts-module`, mock the store, default config, logging, and sync helper, and install `global.lx.event_app.user_api_changed`. Use two valid scripts and assert:

```js
const input = [
  {
    script: '/*\n * @name Source A\n * @version 1.0.0\n */\n',
    remote: {
      provider: 'github',
      repository: 'Macrohard0001/lx-ikun-music-sources',
      version: 'v260724',
      group: 'V260720-推荐',
      path: 'v260724/V260720-推荐/a.js',
      blobSha: 'a'.repeat(40),
      commitSha: 'b'.repeat(40),
    },
  },
  {
    script: '/*\n * @name Source B\n */\n',
    remote: {
      provider: 'github',
      repository: 'Macrohard0001/lx-ikun-music-sources',
      version: 'v260724',
      group: 'online',
      path: 'v260724/online/b.js',
      blobSha: 'c'.repeat(40),
      commitSha: 'b'.repeat(40),
    },
  },
]
const next = await userApiUtils.replaceApisFromGitHub(input)

assert.strictEqual(next.length, 2)
assert.match(next[0].id, /^user_api_github_[0-9a-f]{16}$/)
assert.strictEqual(storeSets.length, 1)
assert.strictEqual(changeEvents, 1)
assert.deepStrictEqual(next[0].remote, input[0].remote)
```

Run a second replacement with the same first path and assert the first ID is unchanged. In fresh module instances, assert an invalid script, duplicate path, wrong repository, oversized script, and mocked `store.set` failure leave `getUserApis()` and stored serialized data unchanged and emit no change event.

- [ ] **Step 3: Run both tests and verify RED**

Run:

```bash
node scripts/test-store-validation.js
node scripts/test-user-api-github-replace.js
```

Expected: the store test fails because `set()` leaves `after` in memory; the replacement test fails because `replaceApisFromGitHub` does not exist.

- [ ] **Step 4: Restore Store state on failed writes**

Change `Store.set` in `src/main/utils/store.ts`:

```ts
set(key: string, value: any) {
  const existed = Object.prototype.hasOwnProperty.call(this.store, key)
  const previous = this.store[key]
  this.store[key] = value
  try {
    this.writeFile()
  } catch (err) {
    if (existed) this.store[key] = previous
    else delete this.store[key]
    throw err
  }
}
```

- [ ] **Step 5: Add remote and batch types**

Add to `src/common/types/user_api.d.ts`:

```ts
interface GitHubRemoteInfo {
  provider: 'github'
  repository: 'Macrohard0001/lx-ikun-music-sources'
  version: string
  group: string
  path: string
  blobSha: string
  commitSha: string
}

interface GitHubImportItem {
  script: string
  remote: GitHubRemoteInfo
}
```

Add `remote?: GitHubRemoteInfo` to `UserApiInfoFull`; `UserApiInfo` inherits it through the existing omit.

- [ ] **Step 6: Implement validated atomic replacement**

In `src/main/modules/userApi/utils.ts`, import `createHash` and the shared limits. Export `replaceApisFromGitHub(items)` with this ordering:

```ts
const GITHUB_REPOSITORY = 'Macrohard0001/lx-ikun-music-sources'
const GITHUB_VERSION_RXP = /^[vV]\d{6}$/
const GITHUB_SHA_RXP = /^[0-9a-f]{40}$/i

const validateGitHubImportItems = (items: LX.UserApi.GitHubImportItem[]) => {
  if (!Array.isArray(items) || !items.length || items.length > GITHUB_USER_API_LIMITS.maxFiles) {
    throw new Error('Invalid GitHub user API item count')
  }
  const paths = new Set<string>()
  const batchVersion = items[0].remote?.version
  const batchCommit = items[0].remote?.commitSha
  let totalBytes = 0
  for (const item of items) {
    const { remote, script } = item ?? {}
    if (typeof script != 'string' || !remote || remote.provider != 'github' ||
      remote.repository != GITHUB_REPOSITORY || !GITHUB_VERSION_RXP.test(remote.version) ||
      !remote.group || typeof remote.path != 'string' || !GITHUB_SHA_RXP.test(remote.blobSha) ||
      !GITHUB_SHA_RXP.test(remote.commitSha)) {
      throw new Error('Invalid GitHub user API metadata')
    }
    if (remote.version != batchVersion || remote.commitSha != batchCommit ||
      paths.has(remote.path) || !remote.path.startsWith(remote.version + '/') ||
      !/\.js$/i.test(remote.path)) {
      throw new Error('Invalid or duplicate GitHub user API path')
    }
    const relativeParts = remote.path.substring(remote.version.length + 1).split('/')
    const expectedGroup = relativeParts.length > 1 ? relativeParts[0] : remote.version
    if (!relativeParts.at(-1) || remote.group != expectedGroup) {
      throw new Error('Invalid GitHub user API group')
    }
    paths.add(remote.path)
    const bytes = Buffer.byteLength(script, 'utf8')
    if (bytes > GITHUB_USER_API_LIMITS.maxScriptBytes) {
      throw new Error(`GitHub user API script is too large: ${remote.path}`)
    }
    totalBytes += bytes
  }
  if (totalBytes > GITHUB_USER_API_LIMITS.maxTotalBytes) {
    throw new Error('GitHub user API batch is too large')
  }
}

const createGitHubUserApiId = (remotePath: string) => {
  return 'user_api_github_' + createHash('sha256').update(remotePath).digest('hex').substring(0, 16)
}

export const replaceApisFromGitHub = async(items: LX.UserApi.GitHubImportItem[]) => {
  getUserApis()
  validateGitHubImportItems(items)

  const nextUserApis: LX.UserApi.UserApiInfo[] = []
  const nextScripts = new Map<string, string>()
  for (const item of items) {
    const id = createGitHubUserApiId(item.remote.path)
    nextUserApis.push({
      id,
      ...parseScriptInfo(item.script),
      allowShowUpdateAlert: true,
      remote: { ...item.remote },
    })
    nextScripts.set(id, await deflateScript(item.script))
  }

  getStore(STORE_NAMES.USER_API).set('userApis', serializeUserApis(nextUserApis, nextScripts))
  userApis = nextUserApis
  scripts = nextScripts
  global.lx.event_app.user_api_changed()
  return getUserApis()
}
```

The function above validates every remote field before parsing or compressing scripts. The replacement loop completes every parse and compression before it calls `store.set`.

- [ ] **Step 7: Run replacement and store tests and verify GREEN**

Run:

```bash
node scripts/test-store-validation.js
node scripts/test-user-api-github-replace.js
```

Expected: both PASS.

- [ ] **Step 8: Commit the atomic storage layer**

```bash
git add scripts/test-store-validation.js scripts/test-user-api-github-replace.js src/main/utils/store.ts src/common/types/user_api.d.ts src/main/modules/userApi/utils.ts
git commit -m "feat: atomically replace GitHub custom sources"
```

### Task 4: Wire Batch Replacement Through IPC And Reload The Active Source

**Files:**
- Modify: `scripts/test-user-api-github-replace.js`
- Create: `scripts/test-user-api-github-wiring.js`
- Modify: `src/main/modules/userApi/index.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/main/modules/winMain/rendererEvent/userApi.ts`
- Modify: `src/renderer/utils/ipc.ts`

- [ ] **Step 1: Add failing active-source and IPC tests**

In `scripts/test-user-api-github-replace.js`, load `src/main/modules/userApi/index.ts` with mocked `closeWindow`, `replaceApisFromGitHub`, `getUserApis`, `loadApi`, and renderer-event exports. Select `stable-id` through `setApi`, replace with a list containing `stable-id`, and assert one close followed by one reload. Repeat with a returned list that omits `stable-id` and assert close without reload.

Create `scripts/test-user-api-github-wiring.js` and assert the source files contain:

```js
assert.match(ipcNames, /replace_user_api_from_github:\s*'replace_user_api_from_github'/)
assert.match(mainHandler, /mainHandle<LX\.UserApi\.GitHubImportItem\[\]/)
assert.match(mainHandler, /replaceApisFromGitHub\(items\)/)
assert.match(rendererIpc, /replaceUserApisFromGitHub/)
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node scripts/test-user-api-github-replace.js
node scripts/test-user-api-github-wiring.js
```

Expected: FAIL because the main wrapper and IPC channel do not exist.

- [ ] **Step 3: Implement runtime reload and IPC**

In `src/main/modules/userApi/index.ts`, wrap the utility replacement:

```ts
export const replaceApisFromGitHub = async(items: LX.UserApi.GitHubImportItem[]) => {
  const apiList = await handleReplaceApisFromGitHub(items)
  if (!userApiId) return apiList

  const activeId = userApiId
  userApiId = null
  await closeWindow()
  if (apiList.some(api => api.id == activeId)) {
    userApiId = activeId
    await loadApi(activeId)
  }
  return apiList
}
```

Add `replace_user_api_from_github` to `src/common/ipcNames.ts`. Register a typed `mainHandle<LX.UserApi.GitHubImportItem[], LX.UserApi.UserApiInfo[]>` in the main user-API handler. Add this renderer wrapper:

```ts
export const replaceUserApisFromGitHub = async(items: LX.UserApi.GitHubImportItem[]) => {
  return rendererInvoke<LX.UserApi.GitHubImportItem[], LX.UserApi.UserApiInfo[]>(
    WIN_MAIN_RENDERER_EVENT_NAME.replace_user_api_from_github,
    items,
  )
}
```

- [ ] **Step 4: Run and verify GREEN**

Run:

```bash
node scripts/test-user-api-github-replace.js
node scripts/test-user-api-github-wiring.js
```

Expected: both PASS.

- [ ] **Step 5: Commit IPC wiring**

```bash
git add scripts/test-user-api-github-replace.js scripts/test-user-api-github-wiring.js src/main/modules/userApi/index.ts src/common/ipcNames.ts src/main/modules/winMain/rendererEvent/userApi.ts src/renderer/utils/ipc.ts
git commit -m "feat: wire GitHub custom source replacement"
```

### Task 5: Preserve Remote Group Metadata Through Sync

**Files:**
- Modify: `scripts/test-user-api-sync.js`
- Modify: `src/common/types/user_api_sync.d.ts`
- Modify: `src/common/utils/userApiSync.js`

- [ ] **Step 1: Write failing sync assertions**

Add a `remote` object to the `user_api_ok` fixture in `scripts/test-user-api-sync.js`. Assert the created sync API contains the same object, stable MD5 changes when `remote.group` changes, `assertUserApiSyncData` rejects invalid provider/SHA/path data, and merge preserves the incoming remote object.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/test-user-api-sync.js`

Expected: FAIL because `createUserApiSyncData` drops `remote`.

- [ ] **Step 3: Implement sync normalization and validation**

Add `remote?: LX.UserApi.GitHubRemoteInfo` to `LX.Sync.UserApi.ApiInfo`. In `src/common/utils/userApiSync.js`, add a copier that returns only the seven known remote fields, then include it in both `createUserApiSyncData` and `createStableUserApiSyncData`:

```js
const normalizeRemote = remote => remote == null
  ? undefined
  : {
      provider: remote.provider,
      repository: remote.repository,
      version: normalizeApiText(remote.version),
      group: normalizeApiText(remote.group),
      path: normalizeApiText(remote.path),
      blobSha: normalizeApiText(remote.blobSha),
      commitSha: normalizeApiText(remote.commitSha),
    }
```

Only add the property when `remote` exists. Extend `assertUserApiSyncData` with the same exact provider/repository, nonempty version/group/path, version path prefix, and 40-character SHA checks used by the import boundary.

- [ ] **Step 4: Run sync tests and verify GREEN**

Run:

```bash
node scripts/test-user-api-sync.js
node scripts/test-user-api-sync-v2-wiring.js
```

Expected: both PASS.

- [ ] **Step 5: Commit sync metadata support**

```bash
git add scripts/test-user-api-sync.js src/common/types/user_api_sync.d.ts src/common/utils/userApiSync.js
git commit -m "feat: sync GitHub custom source groups"
```

### Task 6: Add Settings Controls And Collapsible Groups

**Files:**
- Modify: `scripts/test-user-api-github-wiring.js`
- Modify: `src/renderer/views/Setting/components/UserApiModal.vue`
- Modify: `src/lang/zh-cn.json`
- Modify: `src/lang/zh-tw.json`
- Modify: `src/lang/en-us.json`

- [ ] **Step 1: Add failing UI wiring assertions**

Extend `scripts/test-user-api-github-wiring.js` to assert the modal imports `getGitHubUserApiSnapshot`, `downloadGitHubUserApiSnapshot`, and `replaceUserApisFromGitHub`; calls `this.$dialog.confirm`; renders `aria-expanded`; references `#icon-down`; groups on `api.remote?.group`; contains both GitHub buttons; and no longer contains `this.userApi.list.length > 20`.

For each language file, parse JSON and assert these keys are nonempty:

```text
user_api__github_test
user_api__github_testing
user_api__github_import
user_api__github_importing
user_api__github_local_group
user_api__github_test_success
user_api__github_import_confirm
user_api__github_import_success
user_api__github_error_rate_limit
user_api__github_error_http
user_api__github_error_tree
user_api__github_error_version
user_api__github_error_scripts
user_api__github_error_limit
user_api__github_error_invalid_script
user_api__github_error_generic
```

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/test-user-api-github-wiring.js`

Expected: FAIL on missing modal controls and translation keys.

- [ ] **Step 3: Implement modal state and actions**

Update `UserApiModal.vue` with:

```js
data() {
  return {
    githubAction: '',
    githubStatus: '',
    collapsedGroups: new Set(),
  }
},
watch: {
  modelValue(show) {
    if (!show) return
    this.collapsedGroups = new Set()
    this.githubStatus = ''
  },
},

computed: {
  apiGroups() {
    const groups = new Map()
    for (const api of this.apiList) {
      const name = api.remote?.group ?? ''
      if (!groups.has(name)) groups.set(name, [])
      groups.get(name).push(api)
    }
    return [...groups].map(([name, apis]) => ({ name, apis }))
  },
},
methods: {
  toggleGroup(name) {
    if (this.collapsedGroups.has(name)) this.collapsedGroups.delete(name)
    else this.collapsedGroups.add(name)
  },
  formatGitHubError(err) {
    const errorKeys = {
      GITHUB_RATE_LIMIT: 'user_api__github_error_rate_limit',
      GITHUB_HTTP_ERROR: 'user_api__github_error_http',
      GITHUB_INVALID_RESPONSE: 'user_api__github_error_tree',
      GITHUB_TREE_TRUNCATED: 'user_api__github_error_tree',
      GITHUB_VERSION_NOT_FOUND: 'user_api__github_error_version',
      GITHUB_SCRIPTS_NOT_FOUND: 'user_api__github_error_scripts',
      GITHUB_BATCH_LIMIT: 'user_api__github_error_limit',
      GITHUB_INVALID_SCRIPT: 'user_api__github_error_invalid_script',
    }
    return this.$t(errorKeys[err?.code] ?? 'user_api__github_error_generic', {
      message: err?.detail || err?.message || String(err),
    })
  },
  async handleGitHubTest() {
    if (this.githubAction) return
    this.githubAction = 'test'
    try {
      const snapshot = await getGitHubUserApiSnapshot()
      this.githubStatus = this.$t('user_api__github_test_success', {
        version: snapshot.version,
        count: snapshot.files.length,
        commit: snapshot.commitSha.substring(0, 7),
      })
    } catch (err) {
      const message = this.formatGitHubError(err)
      this.githubStatus = message
      void dialog(message)
    } finally {
      this.githubAction = ''
    }
  },
  async handleGitHubImport() {
    if (this.githubAction) return
    this.githubAction = 'import'
    try {
      const snapshot = await getGitHubUserApiSnapshot()
      const confirmed = await this.$dialog.confirm({
        message: this.$t('user_api__github_import_confirm', {
          localCount: this.apiList.length,
          version: snapshot.version,
          remoteCount: snapshot.files.length,
        }),
        confirmButtonText: this.$t('ok'),
        cancelButtonText: this.$t('cancel'),
      })
      if (!confirmed) return

      const previousId = appSetting['common.apiSource']
      const previousWasCustom = this.apiList.some(api => api.id == previousId)
      const items = await downloadGitHubUserApiSnapshot(snapshot)
      const apiList = await replaceUserApisFromGitHub(items)
      userApi.list = apiList
      if (previousWasCustom && !apiList.some(api => api.id == previousId)) {
        const fallback = apiSourceInfo.find(api => !api.disabled) ?? apiList[0]
        updateSetting({ 'common.apiSource': fallback?.id ?? '' })
      }
      this.githubStatus = this.$t('user_api__github_import_success', {
        version: snapshot.version,
        count: apiList.length,
      })
    } catch (err) {
      const message = this.formatGitHubError(err)
      this.githubStatus = message
      void dialog(message)
    } finally {
      this.githubAction = ''
    }
  },
}
```

The `formatGitHubError` method shown above maps known codes to localized messages and includes the request detail only in the generic fallback.

Replace the flat list and footer with this structure:

```pug
div.scroll(v-if="apiList.length" :class="$style.content")
  section(v-for="group in apiGroups" :key="group.name || 'local'" :class="$style.group")
    button(
      type="button"
      :class="$style.groupHeader"
      :aria-expanded="!collapsedGroups.has(group.name)"
      @click="toggleGroup(group.name)"
    )
      span {{ group.name || $t('user_api__github_local_group') }}
      span(:class="$style.groupCount") {{ group.apis.length }}
      svg(:class="[$style.groupIcon, { [$style.collapsed]: collapsedGroups.has(group.name) }]")
        use(xlink:href="#icon-down")
    ul(v-show="!collapsedGroups.has(group.name)")
      li(
        v-for="api in group.apis"
        :key="api.id"
        :class="[$style.listItem, { [$style.active]: appSetting['common.apiSource'] == api.id }]"
      )
        div(:class="$style.listLeft")
          h3 {{ api.name }}
          p {{ api.description }}
          base-checkbox(
            :id="`user_api_${api.id}`"
            v-model="api.allowShowUpdateAlert"
            :class="$style.checkbox"
            :label="$t('user_api__allow_show_update_alert')"
            @change="handleChangeAllowUpdateAlert(api, $event)"
          )
        base-btn(:class="$style.listBtn" outline :aria-label="$t('user_api__btn_remove')" @click.stop="handleRemove(api)")
          svg
            use(xlink:href="#icon-delete")
div(v-else :class="$style.content")
  div(:class="$style.noitem") {{ $t('user_api__noitem') }}
div(v-if="githubStatus" :class="$style.githubStatus") {{ githubStatus }}
div(:class="$style.footer")
  base-btn(:class="$style.footerBtn" :disabled="!!githubAction" @click="handleGitHubTest")
    | {{ $t(githubAction == 'test' ? 'user_api__github_testing' : 'user_api__github_test') }}
  base-btn(:class="$style.footerBtn" :disabled="!!githubAction" @click="handleGitHubImport")
    | {{ $t(githubAction == 'import' ? 'user_api__github_importing' : 'user_api__github_import') }}
  base-btn(:class="$style.footerBtn" @click="isShowOnlineImportModal = true") {{ $t('user_api__btn_import_online') }}
  base-btn(:class="$style.footerBtn" @click="handleImport") {{ $t('user_api__btn_import') }}
```

Change the delete method to `async handleRemove(api)` and remove its index lookup. Group-local indexes cannot address the flat source list. Keep the existing active-source fallback and `removeUserApi([api.id])` call.

Add LESS for a full-width group-header button, a fixed-size 16 px arrow, `transform: rotate(-90deg)` on `.collapsed`, and a two-column footer grid with a 10 px gap. Under `@media (max-width: 420px)`, switch the footer to one column. Use `min-width: 0`, wrapping status text, and existing theme variables so labels cannot overlap controls.

Remove the old 20-item check from `handleImport`. Add the two GitHub buttons before the existing import buttons. Use `flex-wrap`, two stable columns above 420 px, and full-width buttons below 420 px. Keep the existing modal width and theme variables.

- [ ] **Step 4: Add translations**

Add these values:

| Key | Simplified Chinese | Traditional Chinese | English |
|---|---|---|---|
| `user_api__github_test` | `\u6d4b\u8bd5\u4ed3\u5e93\u8fde\u63a5` | `\u6e2c\u8a66\u5009\u5eab\u9023\u7dda` | Test Repository |
| `user_api__github_testing` | `\u6d4b\u8bd5\u4e2d...` | `\u6e2c\u8a66\u4e2d...` | Testing... |
| `user_api__github_import` | `\u83b7\u53d6\u6700\u65b0\u97f3\u6e90` | `\u53d6\u5f97\u6700\u65b0\u97f3\u6e90` | Get Latest Sources |
| `user_api__github_importing` | `\u83b7\u53d6\u4e2d...` | `\u53d6\u5f97\u4e2d...` | Getting Sources... |
| `user_api__github_local_group` | `\u672c\u5730\u5bfc\u5165` | `\u672c\u6a5f\u532f\u5165` | Local Imports |
| `user_api__github_test_success` | `\u4ed3\u5e93\u8fde\u63a5\u6210\u529f\uff1a{version}\uff0c{count} \u4e2a\u97f3\u6e90\uff0c\u63d0\u4ea4 {commit}` | `\u5009\u5eab\u9023\u7dda\u6210\u529f\uff1a{version}\uff0c{count} \u500b\u97f3\u6e90\uff0c\u63d0\u4ea4 {commit}` | Repository connected: {version}, {count} sources, commit {commit} |
| `user_api__github_import_confirm` | `\u5c06\u6e05\u7a7a\u73b0\u6709 {localCount} \u4e2a\u81ea\u5b9a\u4e49\u6e90\uff0c\u5e76\u5bfc\u5165 {version} \u7684 {remoteCount} \u4e2a\u97f3\u6e90\u3002\u662f\u5426\u7ee7\u7eed\uff1f` | `\u5c07\u6e05\u7a7a\u73fe\u6709 {localCount} \u500b\u81ea\u8a02\u4f86\u6e90\uff0c\u4e26\u532f\u5165 {version} \u7684 {remoteCount} \u500b\u97f3\u6e90\u3002\u662f\u5426\u7e7c\u7e8c\uff1f` | Replace all {localCount} custom sources with {remoteCount} sources from {version}? |
| `user_api__github_import_success` | `\u5df2\u5bfc\u5165 {version} \u7684 {count} \u4e2a\u97f3\u6e90` | `\u5df2\u532f\u5165 {version} \u7684 {count} \u500b\u97f3\u6e90` | Imported {count} sources from {version} |
| `user_api__github_error_rate_limit` | `GitHub \u8bf7\u6c42\u6b21\u6570\u5df2\u8fbe\u4e0a\u9650\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5` | `GitHub \u8acb\u6c42\u6b21\u6578\u5df2\u9054\u4e0a\u9650\uff0c\u8acb\u7a0d\u5f8c\u91cd\u8a66` | GitHub rate limit reached. Try again later. |
| `user_api__github_error_http` | `GitHub \u8bf7\u6c42\u5931\u8d25\uff1a{message}` | `GitHub \u8acb\u6c42\u5931\u6557\uff1a{message}` | GitHub request failed: {message} |
| `user_api__github_error_tree` | `\u4ed3\u5e93\u76ee\u5f55\u6570\u636e\u65e0\u6548\u6216\u4e0d\u5b8c\u6574` | `\u5009\u5eab\u76ee\u9304\u8cc7\u6599\u7121\u6548\u6216\u4e0d\u5b8c\u6574` | Repository tree data is invalid or incomplete. |
| `user_api__github_error_version` | `\u4ed3\u5e93\u4e2d\u6ca1\u6709\u53ef\u7528\u7684\u7248\u672c\u76ee\u5f55` | `\u5009\u5eab\u4e2d\u6c92\u6709\u53ef\u7528\u7684\u7248\u672c\u76ee\u9304` | No version directory was found. |
| `user_api__github_error_scripts` | `\u6700\u65b0\u7248\u672c\u76ee\u5f55\u4e2d\u6ca1\u6709 JS \u97f3\u6e90` | `\u6700\u65b0\u7248\u672c\u76ee\u9304\u4e2d\u6c92\u6709 JS \u97f3\u6e90` | The latest version has no JavaScript sources. |
| `user_api__github_error_limit` | `\u8fdc\u7a0b\u97f3\u6e90\u6570\u91cf\u6216\u5927\u5c0f\u8d85\u8fc7\u5b89\u5168\u9650\u5236` | `\u9060\u7aef\u97f3\u6e90\u6578\u91cf\u6216\u5927\u5c0f\u8d85\u904e\u5b89\u5168\u9650\u5236` | The remote source batch exceeds the size or count limit. |
| `user_api__github_error_invalid_script` | `\u8fdc\u7a0b\u97f3\u6e90\u811a\u672c\u65e0\u6548\uff1a{message}` | `\u9060\u7aef\u97f3\u6e90\u8173\u672c\u7121\u6548\uff1a{message}` | Invalid remote source script: {message} |
| `user_api__github_error_generic` | `\u83b7\u53d6 GitHub \u97f3\u6e90\u5931\u8d25\uff1a{message}` | `\u53d6\u5f97 GitHub \u97f3\u6e90\u5931\u6557\uff1a{message}` | Failed to get GitHub sources: {message} |

- [ ] **Step 5: Run focused UI and type checks**

Run:

```bash
node scripts/test-user-api-github-wiring.js
npx tsc -p src/common/tsconfig.json --noEmit
npx tsc -p src/main/tsconfig.json --noEmit
npx tsc -p src/renderer/tsconfig.json --noEmit
```

Expected: all commands exit 0 with no diagnostics.

- [ ] **Step 6: Commit the settings UI**

```bash
git add scripts/test-user-api-github-wiring.js src/renderer/views/Setting/components/UserApiModal.vue src/lang/zh-cn.json src/lang/zh-tw.json src/lang/en-us.json
git commit -m "feat: import and group latest GitHub custom sources"
```

### Task 7: Run Full Verification And Smoke-Test The Feature

**Files:**
- Modify only if a verification failure exposes a defect in the files listed above.

- [ ] **Step 1: Run all focused behavioral tests**

Run:

```bash
node scripts/test-github-user-api.js
node scripts/test-user-api-github-replace.js
node scripts/test-user-api-github-wiring.js
node scripts/test-user-api-sync.js
node scripts/test-user-api-sync-v2-wiring.js
node scripts/test-store-validation.js
```

Expected: six PASS messages and exit code 0.

- [ ] **Step 2: Run static verification**

Run:

```bash
npx tsc -p src/common/tsconfig.json --noEmit
npx tsc -p src/main/tsconfig.json --noEmit
npx tsc -p src/renderer/tsconfig.json --noEmit
npm run lint
git diff --check
```

Expected: no TypeScript diagnostics, ESLint errors, or whitespace errors.

- [ ] **Step 3: Run production builds**

Run:

```bash
npm run build:main
npm run build:renderer
```

Expected: both webpack builds exit 0.

- [ ] **Step 4: Verify the live repository contract without importing into user data**

Use the renderer client in a read-only harness or the existing approved GitHub request path to fetch `main` and its tree. Assert the result reports `v260724`, 26 scripts, the groups `V260720-其他`, `V260720-推荐`, and `online`, and a 40-character commit SHA. Do not call the replacement IPC in this check.

- [ ] **Step 5: Smoke-test the Electron modal when GUI execution is available**

Start `npm run dev`, open “设置 > 自定义源管理”, and verify desktop and minimum-width layouts. Check that all four buttons remain readable, groups collapse without shifting adjacent controls, connection testing reports the snapshot, and canceling replacement leaves the source list unchanged. Stop the development process after the check.

- [ ] **Step 6: Review the final diff and status**

Run:

```bash
git status --short
git diff --stat HEAD~6..HEAD
git log -7 --oneline
```

Expected: only planned files changed; the feature commits follow the design and all verification commands have recorded passing output.
