# QQ Music Home Recommend Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the QQ Music homepage recommendation batch request and print its raw response once per signed-in account to the renderer developer console.

**Architecture:** A focused main-process recommendation service reproduces `sansenjian/qq-music-api`'s GET request and receives the persisted QQ Cookie through the existing account boundary. The account service exposes the raw payload through a dedicated IPC event, while a small renderer diagnostic composable prevents duplicate and stale account logs on the QQ recommendation page.

**Tech Stack:** Electron IPC, TypeScript, Vue 3 Composition API, Node `assert`, the existing Babel TypeScript test loader, native `fetch`.

---

## File Structure

- Create `src/main/modules/qqMusic/recommend.ts`: build and execute the upstream homepage batch request; return the raw JSON payload.
- Create `src/renderer/views/QQRecommend/useQQHomeRecommendDiagnostic.ts`: coordinate once-per-account requests and credential-free Console output.
- Create `scripts/test-qq-music-home-recommend.js`: service request, error, account-race, and renderer diagnostic behavior tests.
- Modify `src/common/types/qq_music.d.ts`: define the raw homepage response contract.
- Modify `src/main/modules/qqMusic/index.ts`: place the new service behind stored-account auth handling.
- Modify `src/common/ipcNames.ts`: add the IPC event name.
- Modify `src/main/modules/winMain/rendererEvent/qqMusic.ts`: register the main-process handler.
- Modify `src/renderer/utils/ipc.ts`: expose the typed renderer helper.
- Modify `scripts/test-qq-music-account.js`: cover account-boundary success and auth-expiry behavior.
- Modify `scripts/test-qq-music-ipc.js`: protect the new IPC wiring and credential boundary.
- Modify `src/renderer/views/QQRecommend/index.vue`: invoke the diagnostic after initial login resolution and account changes.
- Modify `scripts/test-provider-recommend-pages.js`: protect QQ page diagnostic ownership.

### Task 1: Specify The Upstream Homepage Request

**Files:**
- Create: `scripts/test-qq-music-home-recommend.js`
- Create: `src/main/modules/qqMusic/recommend.ts`

- [ ] **Step 1: Write the failing request test**

Create a test harness that records the URL and fetch options, returns a recognizable raw object, and loads the future service through `scripts/qq-music-test-loader.js`:

```js
const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

let request
let fetchCalls = 0
const rawPayload = {
  code: 0,
  category: { code: 0, data: { marker: 'category' } },
  focus: { code: 0, data: { marker: 'focus' } },
}
class QQMusicAuthError extends Error {}

const fetchImpl = async(url, options) => {
  fetchCalls++
  request = { url, options }
  return { ok: true, json: async() => rawPayload }
}

const { createQQMusicRecommendService } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/recommend.ts'),
  {
    './auth': { getCookieValue: () => 'o123' },
    './song': { QQMusicAuthError },
  },
)

const main = async() => {
  const service = createQQMusicRecommendService({
    fetchImpl,
    getCookie: () => 'uin=o123; qqmusic_key=secret',
  })
  const result = await service.getHomeRecommend()
  const url = new URL(request.url)
  const data = JSON.parse(url.searchParams.get('data'))

  assert.strictEqual(result, rawPayload)
  assert.strictEqual(url.origin + url.pathname, 'https://u.y.qq.com/cgi-bin/musicu.fcg')
  assert.strictEqual(request.options.method, 'GET')
  assert.strictEqual(url.searchParams.get('format'), 'json')
  assert.strictEqual(url.searchParams.get('loginUin'), '123')
  assert.deepStrictEqual(data.comm, { ct: 24 })
  assert.deepStrictEqual(data.category, {
    method: 'get_hot_category',
    param: { qq: '' },
    module: 'music.web_category_svr',
  })
  assert.deepStrictEqual(data.recomPlaylist, {
    method: 'get_hot_recommend',
    param: { async: 1, cmd: 2 },
    module: 'playlist.HotRecommendServer',
  })
  assert.deepStrictEqual(data.playlist, {
    method: 'get_playlist_by_category',
    param: { id: 8, curPage: 1, size: 40, order: 5, titleid: 8 },
    module: 'playlist.PlayListPlazaServer',
  })
  assert.deepStrictEqual(data.new_song, {
    module: 'newsong.NewSongServer',
    method: 'get_new_song_info',
    param: { type: 5 },
  })
  assert.deepStrictEqual(data.new_album, {
    module: 'newalbum.NewAlbumServer',
    method: 'get_new_album_info',
    param: { area: 1, sin: 0, num: 10 },
  })
  assert.deepStrictEqual(data.new_album_tag, {
    module: 'newalbum.NewAlbumServer',
    method: 'get_new_album_area',
    param: {},
  })
  assert.deepStrictEqual(data.toplist, {
    module: 'musicToplist.ToplistInfoServer',
    method: 'GetAll',
    param: {},
  })
  assert.deepStrictEqual(data.focus, {
    module: 'QQMusic.MusichallServer',
    method: 'GetFocus',
    param: {},
  })
  assert.strictEqual(request.options.headers.Cookie, 'uin=o123; qqmusic_key=secret')
}

main().then(() => {
  console.log('QQ Music home recommendation tests passed')
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/test-qq-music-home-recommend.js`

Expected: FAIL because `src/main/modules/qqMusic/recommend.ts` does not exist.

- [ ] **Step 3: Implement the minimal request service**

Create `src/main/modules/qqMusic/recommend.ts` with a constant batch object and an injectable service:

```ts
import { getCookieValue } from './auth'
import { QQMusicAuthError } from './song'

const HOME_RECOMMEND_REQUEST = {
  comm: { ct: 24 },
  category: {
    method: 'get_hot_category',
    param: { qq: '' },
    module: 'music.web_category_svr',
  },
  recomPlaylist: {
    method: 'get_hot_recommend',
    param: { async: 1, cmd: 2 },
    module: 'playlist.HotRecommendServer',
  },
  playlist: {
    method: 'get_playlist_by_category',
    param: { id: 8, curPage: 1, size: 40, order: 5, titleid: 8 },
    module: 'playlist.PlayListPlazaServer',
  },
  new_song: {
    module: 'newsong.NewSongServer',
    method: 'get_new_song_info',
    param: { type: 5 },
  },
  new_album: {
    module: 'newalbum.NewAlbumServer',
    method: 'get_new_album_info',
    param: { area: 1, sin: 0, num: 10 },
  },
  new_album_tag: {
    module: 'newalbum.NewAlbumServer',
    method: 'get_new_album_area',
    param: {},
  },
  toplist: {
    module: 'musicToplist.ToplistInfoServer',
    method: 'GetAll',
    param: {},
  },
  focus: {
    module: 'QQMusic.MusichallServer',
    method: 'GetFocus',
    param: {},
  },
}

export const createQQMusicRecommendService = ({
  fetchImpl = fetch,
  getCookie,
}: {
  fetchImpl?: typeof fetch
  getCookie: () => string
}) => {
  const getHomeRecommend = async(): Promise<LX.QQMusic.HomeRecommendResponse> => {
    const cookie = getCookie()
    if (!cookie) throw new QQMusicAuthError('QQ Music account is not logged in')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const loginUin = getCookieValue(cookie, 'uin') || getCookieValue(cookie, 'qqmusic_uin')
      const url = new URL('https://u.y.qq.com/cgi-bin/musicu.fcg')
      const params = {
        g_tk: '1124214810',
        loginUin: loginUin.replace(/^o/, ''),
        hostUin: '0',
        inCharset: 'utf8',
        outCharset: 'utf-8',
        notice: '0',
        platform: 'yqq.json',
        needNewCode: '0',
        format: 'json',
        data: JSON.stringify(HOME_RECOMMEND_REQUEST),
      }
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
      const response = await fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Referer: 'https://y.qq.com/portal/player.html',
          Cookie: cookie,
        },
      })
      if (!response.ok) throw new Error(`QQ Music request failed: ${response.status}`)
      const payload = await response.json() as LX.QQMusic.HomeRecommendResponse
      if (payload.code == 1000) throw new QQMusicAuthError()
      if (payload.code != 0) throw new Error('QQ Music home recommendation request failed')
      return payload
    } finally {
      clearTimeout(timer)
    }
  }
  return { getHomeRecommend }
}
```

- [ ] **Step 4: Add failure assertions**

Append tests for missing Cookie, HTTP failure, auth status `1000`, and nonzero QQ status. Verify missing Cookie does not invoke fetch and the successful object is returned by identity without normalization.

```js
const noCookie = createQQMusicRecommendService({ fetchImpl, getCookie: () => '' })
await assert.rejects(noCookie.getHomeRecommend(), QQMusicAuthError)
assert.strictEqual(fetchCalls, 1)

const responseFor = payload => async() => ({ ok: true, json: async() => payload })
await assert.rejects(
  createQQMusicRecommendService({
    fetchImpl: async() => ({ ok: false, status: 503 }),
    getCookie: () => 'uin=o123; qqmusic_key=secret',
  }).getHomeRecommend(),
  /QQ Music request failed: 503/,
)
await assert.rejects(
  createQQMusicRecommendService({
    fetchImpl: responseFor({ code: 1000 }),
    getCookie: () => 'uin=o123; qqmusic_key=secret',
  }).getHomeRecommend(),
  QQMusicAuthError,
)
await assert.rejects(
  createQQMusicRecommendService({
    fetchImpl: responseFor({ code: 1 }),
    getCookie: () => 'uin=o123; qqmusic_key=secret',
  }).getHomeRecommend(),
  /home recommendation request failed/,
)
```

- [ ] **Step 5: Run the service test and verify GREEN**

Run: `node scripts/test-qq-music-home-recommend.js`

Expected: `QQ Music home recommendation tests passed`.

- [ ] **Step 6: Commit the service slice**

```powershell
git add scripts/test-qq-music-home-recommend.js src/main/modules/qqMusic/recommend.ts
git commit -m "feat: request QQ home recommendations"
```

### Task 2: Put The Request Behind The Account Boundary

**Files:**
- Modify: `src/common/types/qq_music.d.ts`
- Modify: `src/main/modules/qqMusic/index.ts`
- Modify: `scripts/test-qq-music-account.js`

- [ ] **Step 1: Add failing account-service assertions**

Add a `recommendService` mock and pass it to every `createQQMusicAccountService` call:

```js
let recommendError = null
const rawRecommend = { code: 0, focus: { code: 0 } }
const recommendService = {
  getHomeRecommend: async() => {
    if (recommendError) throw recommendError
    return rawRecommend
  },
}

const createFacade = () => createQQMusicAccountService({
  store,
  loginService,
  songService,
  recommendService,
  now: () => 123456,
})
```

After the existing successful restart assertion, add the success and ordinary
failure checks without changing the account:

```js
assert.strictEqual(await restarted.getHomeRecommend(), rawRecommend)

recommendError = new Error('recommend unavailable')
await assert.rejects(restarted.getHomeRecommend(), /recommend unavailable/)
assert.strictEqual(restarted.getAccountStatus().isLoggedIn, true)
recommendError = null
```

At the end of the account-race test, while account B is still current, add the
auth-expiry assertion so it cannot invalidate state needed by earlier cases:

```js
recommendError = new QQMusicAuthError('expired')
await assert.rejects(raceFacade.getHomeRecommend(), QQMusicAuthError)
assert.strictEqual(raceFacade.getAccountStatus().isLoggedIn, false)
recommendError = null
```

Update the singleton module mocks so `./recommend` captures the same private
`getCookie` closure and returns `recommendService`:

```js
let singletonGetRecommendCookie

'./recommend': {
  createQQMusicRecommendService: options => {
    singletonGetRecommendCookie = options.getCookie
    return recommendService
  },
},
```

After invalid stored-account cases, assert `singletonGetRecommendCookie()` is
also empty so the new service cannot bypass account validation.

- [ ] **Step 2: Run the account test and verify RED**

Run: `node scripts/test-qq-music-account.js`

Expected: FAIL because `createQQMusicAccountService` has no `recommendService` dependency or `getHomeRecommend` method.

- [ ] **Step 3: Define the raw response type**

Add to `LX.QQMusic` in `src/common/types/qq_music.d.ts`:

```ts
interface HomeRecommendResponse {
  code: number
  [key: string]: unknown
}
```

- [ ] **Step 4: Wire the recommendation service into the account facade**

In `src/main/modules/qqMusic/index.ts`, import
`createQQMusicRecommendService`, define the dependency, and add it to the
facade parameters:

```ts
interface RecommendService {
  getHomeRecommend: () => Promise<LX.QQMusic.HomeRecommendResponse>
}

export const createQQMusicAccountService = ({
  store,
  loginService,
  songService,
  recommendService,
  now = Date.now,
}: {
  store: AccountStore
  loginService: LoginService
  songService: SongService
  recommendService: RecommendService
  now?: () => number
}) => {
```

Instantiate both services from the same validated private Cookie getter:

```ts
const getCookie = () => getAccountData(store).cookie
const songService = createQQMusicSongService({ getCookie })
const recommendService = createQQMusicRecommendService({ getCookie })
accountService = createQQMusicAccountService({
  store,
  loginService,
  songService,
  recommendService,
})
```

Refactor the existing compare-and-clear behavior into one local helper used by both authenticated requests:

```ts
const runAuthenticatedRequest = async<T>(request: () => Promise<T>) => {
  const account = getAccountData(store)
  try {
    return await request()
  } catch (error) {
    if (isQQMusicAuthError(error)) {
      const currentAccount = getAccountData(store)
      if (currentAccount.cookie == account.cookie && currentAccount.updatedAt == account.updatedAt) {
        clearAccount()
      }
    }
    throw error
  }
}

const getGuessLikeSongs = async(options?: LX.QQMusic.GuessLikeRequest) => {
  return runAuthenticatedRequest(() => songService.getGuessLikeSongs(options))
}

const getHomeRecommend = async() => {
  return runAuthenticatedRequest(() => recommendService.getHomeRecommend())
}
```

Return `getHomeRecommend` from the facade and export a singleton wrapper:

```ts
export const getHomeRecommend = async() => getAccountService().getHomeRecommend()
```

- [ ] **Step 5: Run account and service tests and verify GREEN**

Run:

```powershell
node scripts/test-qq-music-home-recommend.js
node scripts/test-qq-music-account.js
```

Expected: both scripts print their pass messages.

- [ ] **Step 6: Commit the account slice**

```powershell
git add src/common/types/qq_music.d.ts src/main/modules/qqMusic/index.ts scripts/test-qq-music-account.js
git commit -m "feat: expose QQ home recommendations through account service"
```

### Task 3: Add The Renderer IPC Contract

**Files:**
- Modify: `src/common/ipcNames.ts`
- Modify: `src/main/modules/winMain/rendererEvent/qqMusic.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `scripts/test-qq-music-ipc.js`

- [ ] **Step 1: Add failing IPC wiring assertions**

Extend the event-name loop in `scripts/test-qq-music-ipc.js` with `qq_music_get_home_recommend`, then add:

```js
assert.match(handlers, /getHomeRecommend/)
assert.match(rendererIpc, /getQQMusicHomeRecommend/)
assert.match(
  rendererIpc,
  /rendererInvoke<LX\.QQMusic\.HomeRecommendResponse>\(WIN_MAIN_RENDERER_EVENT_NAME\.qq_music_get_home_recommend\)/,
)
```

Keep the existing credential assertions so the renderer helper cannot acquire Cookie or QR internals.

- [ ] **Step 2: Run the IPC test and verify RED**

Run: `node scripts/test-qq-music-ipc.js`

Expected: FAIL because `qq_music_get_home_recommend` does not exist.

- [ ] **Step 3: Add the event, handler, and renderer helper**

Add to `src/common/ipcNames.ts`:

```ts
qq_music_get_home_recommend: 'qq_music_get_home_recommend',
```

Import `getHomeRecommend` in the main handler and register:

```ts
mainHandle<LX.QQMusic.HomeRecommendResponse>(
  WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_home_recommend,
  async() => getHomeRecommend(),
)
```

Add to `src/renderer/utils/ipc.ts`:

```ts
export const getQQMusicHomeRecommend = async() => {
  return rendererInvoke<LX.QQMusic.HomeRecommendResponse>(
    WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_home_recommend,
  )
}
```

- [ ] **Step 4: Run IPC and account tests and verify GREEN**

Run:

```powershell
node scripts/test-qq-music-ipc.js
node scripts/test-qq-music-account.js
```

Expected: both scripts print their pass messages.

- [ ] **Step 5: Commit the IPC slice**

```powershell
git add src/common/ipcNames.ts src/main/modules/winMain/rendererEvent/qqMusic.ts src/renderer/utils/ipc.ts scripts/test-qq-music-ipc.js
git commit -m "feat: add QQ home recommendation IPC"
```

### Task 4: Log Once Per Signed-In Account

**Files:**
- Create: `src/renderer/views/QQRecommend/useQQHomeRecommendDiagnostic.ts`
- Modify: `src/renderer/views/QQRecommend/index.vue`
- Modify: `scripts/test-qq-music-home-recommend.js`
- Modify: `scripts/test-provider-recommend-pages.js`

- [ ] **Step 1: Add failing diagnostic behavior tests**

Load the future composable with a mocked `getQQMusicHomeRecommend`, temporarily replace `console.log` and `console.warn`, and verify:

```js
const logs = []
const warnings = []
const originalLog = console.log
const originalWarn = console.warn
console.log = (...args) => logs.push(args)
console.warn = (...args) => warnings.push(args)

const loadDiagnostic = getHomeRecommend => loadTsModule(
  path.join(__dirname, '../src/renderer/views/QQRecommend/useQQHomeRecommendDiagnostic.ts'),
  { '@renderer/utils/ipc': { getQQMusicHomeRecommend: getHomeRecommend } },
).useQQHomeRecommendDiagnostic()

let requestCount = 0
const useQQHomeRecommendDiagnostic = () => loadDiagnostic(async() => {
  requestCount++
  return rawPayload
})
const diagnostic = useQQHomeRecommendDiagnostic()
await diagnostic.inspect('account-a')
await diagnostic.inspect('account-a')
assert.strictEqual(requestCount, 1)
assert.deepStrictEqual(logs, [['[QQ Music getRecommend]', rawPayload]])

diagnostic.reset()
await diagnostic.inspect(null)
assert.strictEqual(requestCount, 1)

await diagnostic.inspect('account-b')
assert.strictEqual(requestCount, 2)
```

Add a deferred A request followed by B and assert A's late result is not logged. Add a rejected request and assert the warning contains only the fixed label and error object, then assert retrying the same account starts another request.

```js
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const accountA = deferred()
const accountB = deferred()
const responses = [accountA.promise, accountB.promise]
requestCount = 0
logs.length = 0
warnings.length = 0
const staleDiagnostic = loadDiagnostic(async() => responses[requestCount++])
const pendingA = staleDiagnostic.inspect('account-a')
const pendingB = staleDiagnostic.inspect('account-b')
accountA.resolve({ code: 0, account: 'a' })
await pendingA
assert.deepStrictEqual(logs, [])
accountB.resolve({ code: 0, account: 'b' })
await pendingB
assert.deepStrictEqual(logs, [[
  '[QQ Music getRecommend]',
  { code: 0, account: 'b' },
]])

const failure = new Error('request failed')
let failureCalls = 0
const retryDiagnostic = loadDiagnostic(async() => {
  failureCalls++
  if (failureCalls == 1) throw failure
  return rawPayload
})
await retryDiagnostic.inspect('account-c')
assert.deepStrictEqual(warnings, [[
  '[QQ Music getRecommend] request failed',
  failure,
]])
await retryDiagnostic.inspect('account-c')
assert.strictEqual(failureCalls, 2)

console.log = originalLog
console.warn = originalWarn
```

- [ ] **Step 2: Add failing page wiring assertions**

Extend `scripts/test-provider-recommend-pages.js`:

```js
assert(exists('src/renderer/views/QQRecommend/useQQHomeRecommendDiagnostic.ts'),
  'QQ page should own the home recommendation diagnostic')
assert.match(qqPage, /useQQHomeRecommendDiagnostic/)
assert.match(qqPage, /inspectHomeRecommend\(accountKey\.value\)/)
assert.match(qqPage, /resetHomeRecommendDiagnostic\(\)/)
```

- [ ] **Step 3: Run both tests and verify RED**

Run:

```powershell
node scripts/test-qq-music-home-recommend.js
node scripts/test-provider-recommend-pages.js
```

Expected: FAIL because the diagnostic composable and page wiring do not exist.

- [ ] **Step 4: Implement the diagnostic composable**

Create `src/renderer/views/QQRecommend/useQQHomeRecommendDiagnostic.ts`:

```ts
import { getQQMusicHomeRecommend } from '@renderer/utils/ipc'

export const useQQHomeRecommendDiagnostic = () => {
  let requestedAccountKey: string | null = null

  const reset = () => {
    requestedAccountKey = null
  }

  const inspect = async(accountKey: string | null) => {
    if (!accountKey || requestedAccountKey == accountKey) return
    requestedAccountKey = accountKey
    try {
      const response = await getQQMusicHomeRecommend()
      if (requestedAccountKey != accountKey) return
      console.log('[QQ Music getRecommend]', response)
    } catch (error) {
      if (requestedAccountKey != accountKey) return
      requestedAccountKey = null
      console.warn('[QQ Music getRecommend] request failed', error)
    }
  }

  return { inspect, reset }
}
```

- [ ] **Step 5: Invoke it from the QQ page lifecycle**

In `src/renderer/views/QQRecommend/index.vue`, create aliases:

```ts
const {
  inspect: inspectHomeRecommend,
  reset: resetHomeRecommendDiagnostic,
} = useQQHomeRecommendDiagnostic()
```

After initial account resolution:

```ts
if (accountKey.value) {
  void inspectHomeRecommend(accountKey.value)
  await loadQQGuessLikeSongs()
} else {
  resetHomeRecommendDiagnostic()
  clearQQGuessLikeSongs()
}
```

In the `accountKey` watcher, reset on logout and inspect a new signed-in key without awaiting it or blocking Guess You Like:

```ts
if (!value) {
  resetHomeRecommendDiagnostic()
  return
}
void inspectHomeRecommend(value)
if (isInitializingAccount) return
void loadQQGuessLikeSongs()
```

- [ ] **Step 6: Run renderer diagnostic tests and verify GREEN**

Run:

```powershell
node scripts/test-qq-music-home-recommend.js
node scripts/test-provider-recommend-pages.js
```

Expected: both scripts print their pass messages.

- [ ] **Step 7: Commit the renderer slice**

```powershell
git add src/renderer/views/QQRecommend/useQQHomeRecommendDiagnostic.ts src/renderer/views/QQRecommend/index.vue scripts/test-qq-music-home-recommend.js scripts/test-provider-recommend-pages.js
git commit -m "feat: log QQ home recommendations after login"
```

### Task 5: Regression And Live Response Verification

**Files:**
- Verify all files changed in Tasks 1-4.

- [ ] **Step 1: Run all focused QQ tests**

```powershell
node scripts/test-qq-music-auth.js
node scripts/test-qq-music-login.js
node scripts/test-qq-music-browser-auth.js
node scripts/test-qq-music-browser-login.js
node scripts/test-qq-music-account.js
node scripts/test-qq-music-renderer-account.js
node scripts/test-qq-music-song.js
node scripts/test-qq-music-home-recommend.js
node scripts/test-qq-music-ipc.js
node scripts/test-provider-recommend-pages.js
```

Expected: every script exits `0` and prints its pass message.

- [ ] **Step 2: Run focused lint**

```powershell
npx eslint src/common/types/qq_music.d.ts src/common/ipcNames.ts src/main/modules/qqMusic/recommend.ts src/main/modules/qqMusic/index.ts src/main/modules/winMain/rendererEvent/qqMusic.ts src/renderer/utils/ipc.ts src/renderer/views/QQRecommend/useQQHomeRecommendDiagnostic.ts src/renderer/views/QQRecommend/index.vue
```

Expected: exit `0` with no new findings.

- [ ] **Step 3: Build both affected processes**

First run the affected TypeScript projects:

```powershell
npx tsc -p src/common/tsconfig.json --noEmit
npx tsc -p src/main/tsconfig.json --noEmit
npx tsc -p src/renderer/tsconfig.json --noEmit
```

Expected: all three commands exit `0`.

Run: `npm run build:main`

Expected: webpack exits `0`.

Run: `npm run build:renderer`

Expected: webpack exits `0`.

- [ ] **Step 4: Inspect the feature diff and credential boundary**

```powershell
git diff HEAD~4 -- src/common/types/qq_music.d.ts src/common/ipcNames.ts src/main/modules/qqMusic/recommend.ts src/main/modules/qqMusic/index.ts src/main/modules/winMain/rendererEvent/qqMusic.ts src/renderer/utils/ipc.ts src/renderer/views/QQRecommend/useQQHomeRecommendDiagnostic.ts src/renderer/views/QQRecommend/index.vue scripts/test-qq-music-home-recommend.js scripts/test-qq-music-account.js scripts/test-qq-music-ipc.js scripts/test-provider-recommend-pages.js
```

Expected: Cookie access remains main-process-only, no request headers are logged, the renderer logs only the fixed label plus raw response or error, and unrelated working-tree changes remain untouched.

- [ ] **Step 5: Start the development application**

Run: `npm run dev`

Expected: the Electron application opens and the development process remains running without compilation errors.

- [ ] **Step 6: Verify the real signed-in payload**

Open the QQ recommendation page. Reuse the existing signed-in account or complete QR login, open renderer developer tools, and locate:

```text
[QQ Music getRecommend]
```

Expand the logged object and confirm `code` is `0` and the keys include `category`, `recomPlaylist`, `playlist`, `new_song`, `new_album`, `new_album_tag`, `toplist`, and `focus`. Record the actual top-level keys and useful nested collection paths in the task handoff without reproducing any account identifier.

- [ ] **Step 7: Stop the development process after inspection**

Return to the terminal running `npm run dev` and stop it cleanly after the Console payload has been inspected.
