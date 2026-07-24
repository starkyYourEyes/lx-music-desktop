# QQ Music Continuous Recommendation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend QQ Music Guess You Like playback into an account-scoped continuous queue that prefetches and appends personalized songs when two or fewer tracks remain.

**Architecture:** Add an optional continuation flag across the existing QQ renderer-to-main request and translate it to QQ Music's numeric `firstplay` request field. Move QQ queue ownership into a renderer store parallel to Private FM, with an account owner, generation counter, deduplication, single-flight continuation, and temporary-list synchronization; the global player invokes its guard on track changes and before end-of-track next selection.

**Tech Stack:** Electron IPC, TypeScript, Vue 3 reactive stores, Node `assert` regression scripts, ESLint, Webpack.

---

## File Structure

- Create `src/renderer/store/qqGuessLike/state.ts`: reactive continuous-mode, queue, owner, generation, and loading state only.
- Create `src/renderer/store/qqGuessLike/action.ts`: initial loading, session activation/reset, continuation single-flight, stale-response validation, deduplication, and temporary-list synchronization.
- Create `scripts/test-qq-music-continuous.js`: behavioral tests for the global queue and source-wiring assertions for account/page/player lifecycle.
- Modify `src/common/types/qq_music.d.ts`: public IPC request type containing only the continuation boolean.
- Modify `src/main/modules/qqMusic/song.ts`: convert continuation intent to `firstplay: 0`, preserving initial default `firstplay: 1` and `num: 15`.
- Modify `src/main/modules/qqMusic/index.ts`: pass request options through the account/auth boundary.
- Modify `src/main/modules/winMain/rendererEvent/qqMusic.ts`: accept the typed IPC request.
- Modify `src/renderer/utils/ipc.ts`: send initial or continuation intent without exposing QQ credentials.
- Modify `src/renderer/store/qqMusic.ts`: invalidate the queue when the committed QQ account identity changes or logout succeeds.
- Modify `src/renderer/views/Recommend/useQQGuessLikeData.ts`: expose the global queue to the card and delegate initial loads to the queue action.
- Modify `src/renderer/views/QQRecommend/useQQGuessLikePlayback.ts`: delegate activation and active-list detection to the global queue action.
- Modify `src/renderer/views/QQRecommend/index.vue`: stop resetting playback on route unmount and account watcher cleanup.
- Modify `src/renderer/core/useApp/usePlayer/usePlayer.ts`: run QQ synchronization/prefetch beside Private FM and await both before `playNext(true)`.
- Modify `scripts/test-qq-music-song.js`: assert both initial and continuation request bodies.
- Modify `scripts/test-qq-music-ipc.js`: assert the continuation parameter is wired through IPC.

### Task 1: Add QQ Request Semantics

**Files:**
- Modify: `scripts/test-qq-music-song.js`
- Modify: `src/common/types/qq_music.d.ts`
- Modify: `src/main/modules/qqMusic/song.ts`
- Modify: `src/main/modules/qqMusic/index.ts`
- Modify: `src/main/modules/winMain/rendererEvent/qqMusic.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `scripts/test-qq-music-ipc.js`

- [ ] **Step 1: Write the failing song-service assertion for continuation requests.**

After the existing initial request assertions in `scripts/test-qq-music-song.js`, call the service again and assert the only semantic difference is `firstplay`:

```js
await service.getGuessLikeSongs({ continuation: true })
const continuationBody = JSON.parse(request.options.body)
assert.deepStrictEqual(continuationBody.songlist.param, {
  id: 99,
  firstplay: 0,
  num: 15,
})
assert.strictEqual(fetchCalls, 2)
```

- [ ] **Step 2: Run the song test and verify RED.**

Run: `node scripts/test-qq-music-song.js`

Expected: FAIL because `getGuessLikeSongs` ignores the continuation option and still sends `firstplay: 1`.

- [ ] **Step 3: Add the typed request and minimal main-process implementation.**

Add to `LX.QQMusic` in `src/common/types/qq_music.d.ts`:

```ts
interface GuessLikeRequest {
  continuation?: boolean
}
```

Update the song service signature and request payload:

```ts
const getGuessLikeSongs = async(
  { continuation = false }: LX.QQMusic.GuessLikeRequest = {},
): Promise<LX.Music.MusicInfo_tx[]> => {
  const cookie = getCookie()
  if (!cookie) throw new QQMusicAuthError('QQ Music account is not logged in')
  const param = { id: 99, firstplay: continuation ? 0 : 1, num: 15 }
  // Use `param` as the value of `body.songlist.param` in the current fetch call.
}
```

Update the account service interface and pass-through without changing auth-expiry handling:

```ts
interface SongService {
  getGuessLikeSongs: (options?: LX.QQMusic.GuessLikeRequest) => Promise<LX.Music.MusicInfo_tx[]>
}

const getGuessLikeSongs = async(options?: LX.QQMusic.GuessLikeRequest) => {
  const account = getAccountData(store)
  try {
    return await songService.getGuessLikeSongs(options)
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

export const getGuessLikeSongs = async(options?: LX.QQMusic.GuessLikeRequest) => {
  return getAccountService().getGuessLikeSongs(options)
}
```

Wire IPC in `rendererEvent/qqMusic.ts` and `renderer/utils/ipc.ts`:

```ts
mainHandle<LX.QQMusic.GuessLikeRequest | undefined, LX.Music.MusicInfo_tx[]>(
  WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_guess_like_songs,
  async({ params }) => getGuessLikeSongs(params),
)

export const getQQMusicGuessLikeSongs = async(continuation = false) => {
  return rendererInvoke<LX.QQMusic.GuessLikeRequest, LX.Music.MusicInfo_tx[]>(
    WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_guess_like_songs,
    { continuation },
  )
}
```

- [ ] **Step 4: Strengthen IPC wiring assertions.**

Add to `scripts/test-qq-music-ipc.js`:

```js
assert.match(types, /interface GuessLikeRequest[\s\S]*?continuation\?: boolean/)
assert.match(handlers, /getGuessLikeSongs\(params\)/)
assert.match(rendererIpc, /getQQMusicGuessLikeSongs = async\(continuation = false\)/)
assert.match(rendererIpc, /\{ continuation \}/)
```

- [ ] **Step 5: Run focused tests and verify GREEN.**

Run: `node scripts/test-qq-music-song.js`

Expected: `QQ Music song tests passed`.

Run: `node scripts/test-qq-music-ipc.js`

Expected: `QQ Music IPC security tests passed`.

- [ ] **Step 6: Commit the request contract.**

```powershell
git add src/common/types/qq_music.d.ts src/main/modules/qqMusic/song.ts src/main/modules/qqMusic/index.ts src/main/modules/winMain/rendererEvent/qqMusic.ts src/renderer/utils/ipc.ts scripts/test-qq-music-song.js scripts/test-qq-music-ipc.js
git commit -m "feat: add QQ recommendation continuation requests"
```

### Task 2: Specify The Global Queue Behavior

**Files:**
- Create: `scripts/test-qq-music-continuous.js`

- [ ] **Step 1: Add a loader harness with reactive state, player state, list ownership, deferred requests, and spies.**

The harness loads `state.ts` and `action.ts` with the existing `qq-music-test-loader` and provides deterministic mocks:

```js
const ref = value => ({ value })
const shallowReactive = value => value
const markRawList = value => value
const toRaw = value => value
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const song = id => ({ id, name: id, singer: 'Singer', source: 'tx', interval: null, meta: {} })
const LIST_IDS = { TEMP: 'temp' }
const QQ_GUESS_LIKE_TEMP_LIST_ID = 'tx__qq_guess_like'
```

The harness records `getQQMusicGuessLikeSongs(continuation)`, `setTempList(id, list)`, `clearPlayedList()`, and `playList(listId, index)` calls while exposing mutable `playInfo`, `playMusicInfo`, and `tempListMeta`.

- [ ] **Step 2: Add initial-session tests.**

Implement tests with these exact assertions:

```js
await action.prepareQQGuessLikeQueue('account-a')
assert.deepStrictEqual(requestKinds, [false])
assert.deepStrictEqual(state.qqGuessLikeQueue.map(item => item.id), ['a', 'b', 'c'])

await action.enterQQGuessLikeMode('account-a')
assert.strictEqual(state.isQQGuessLikeMode.value, true)
assert.strictEqual(state.qqGuessLikeOwnerAccountKey.value, 'account-a')
assert.deepStrictEqual(setTempListCalls.at(-1).list.map(item => item.id), ['a', 'b', 'c'])
assert.deepStrictEqual(playListCalls.at(-1), { listId: 'temp', index: 0 })
```

- [ ] **Step 3: Add threshold, single-flight, append, and deduplication tests.**

Cover both sides of the threshold and concurrent calls:

```js
playMusicInfo.musicInfo = song('a')
await action.ensureQQGuessLikeNextSongs('account-a')
assert.deepStrictEqual(requestKinds, [false]) // more than two remain

playMusicInfo.musicInfo = song('c')
const first = action.ensureQQGuessLikeNextSongs('account-a')
const second = action.ensureQQGuessLikeNextSongs('account-a')
assert.strictEqual(first, second)
assert.deepStrictEqual(requestKinds, [false, true])
continuation.resolve([song('b'), song('d'), song('e')])
await Promise.all([first, second])
assert.deepStrictEqual(state.qqGuessLikeQueue.map(item => item.id), ['a', 'b', 'c', 'd', 'e'])
```

Also return an all-duplicate batch and assert the queue and active temporary list are unchanged.

- [ ] **Step 4: Add failure/retry and stale-response tests.**

Reject a continuation, assert the queue is preserved, then invoke the guard at the same boundary and assert a new request occurs. For stale work, start a continuation and then call each invalidator before resolving it:

```js
action.resetQQGuessLikeQueue()
staleContinuation.resolve([song('stale')])
await pending
assert(!state.qqGuessLikeQueue.some(item => item.id == 'stale'))
```

Repeat that exact pending-response pattern in three independent harness instances: one calls `resetQQGuessLikeQueue()`, one changes from account A to account B by calling `prepareQQGuessLikeQueue('account-b')`, and one assigns `tempListMeta.id = 'another-temp-owner'` before resolution.

- [ ] **Step 5: Add global-lifecycle wiring assertions.**

Read source files and assert:

```js
assert.doesNotMatch(qqPage, /onBeforeUnmount\([\s\S]*resetPlayback/)
assert.match(accountStore, /resetQQGuessLikeQueue/)
assert.match(player, /syncQQGuessLikeModeWithPlayer/)
assert.match(player, /ensureQQGuessLikeNextSongs/)
assert.match(player, /await ensureContinuousNextSongs\(\)[\s\S]*playNext\(true\)/)
```

- [ ] **Step 6: Run the new test and verify RED.**

Run: `node scripts/test-qq-music-continuous.js`

Expected: FAIL because `src/renderer/store/qqGuessLike/state.ts` and `action.ts` do not exist.

- [ ] **Step 7: Commit the failing behavioral specification.**

```powershell
git add scripts/test-qq-music-continuous.js
git commit -m "test: specify continuous QQ recommendations"
```

### Task 3: Implement The Global QQ Queue

**Files:**
- Create: `src/renderer/store/qqGuessLike/state.ts`
- Create: `src/renderer/store/qqGuessLike/action.ts`
- Test: `scripts/test-qq-music-continuous.js`

- [ ] **Step 1: Add focused reactive state.**

Create `state.ts`:

```ts
import { ref, shallowReactive } from '@common/utils/vueTools'

export const isQQGuessLikeMode = ref(false)
export const qqGuessLikeQueue = shallowReactive<LX.Music.MusicInfo_tx[]>([])
export const qqGuessLikeOwnerAccountKey = ref<string | null>(null)
export const qqGuessLikeGeneration = ref(0)
export const isLoadingQQGuessLike = ref(false)
```

- [ ] **Step 2: Add ownership and reset helpers.**

In `action.ts`, define constants and invalidate all asynchronous work through the generation:

```ts
const MIN_QUEUE_REMAINING = 2
let request: { accountKey: string, generation: number, continuation: boolean, task: Promise<LX.Music.MusicInfo_tx[]> } | null = null

export const resetQQGuessLikeQueue = () => {
  qqGuessLikeGeneration.value++
  isQQGuessLikeMode.value = false
  qqGuessLikeOwnerAccountKey.value = null
  qqGuessLikeQueue.splice(0, qqGuessLikeQueue.length)
  request = null
}

const beginAccountSession = (accountKey: string) => {
  if (qqGuessLikeOwnerAccountKey.value == accountKey) return
  resetQQGuessLikeQueue()
  qqGuessLikeOwnerAccountKey.value = accountKey
}
```

- [ ] **Step 3: Implement initial loading with stale-result validation.**

`prepareQQGuessLikeQueue(accountKey, force)` must reuse an initial request for the same owner/generation, default to `getQQMusicGuessLikeSongs(false)`, keep a cached queue unless forced, and replace the queue only when this snapshot is still current:

```ts
const isCurrentSnapshot = (accountKey: string, generation: number) =>
  qqGuessLikeOwnerAccountKey.value == accountKey &&
  qqGuessLikeGeneration.value == generation

const isActiveSnapshot = (accountKey: string, generation: number) =>
  isCurrentSnapshot(accountKey, generation) &&
  isQQGuessLikeMode.value &&
  playInfo.playerListId == LIST_IDS.TEMP &&
  tempListMeta.id == QQ_GUESS_LIKE_TEMP_LIST_ID

export const prepareQQGuessLikeQueue = async(accountKey: string, force = false) => {
  beginAccountSession(accountKey)
  if (!force && qqGuessLikeQueue.length) return qqGuessLikeQueue
  const generation = qqGuessLikeGeneration.value
  if (request?.accountKey == accountKey && request.generation == generation && !request.continuation) {
    return request.task
  }
  isLoadingQQGuessLike.value = true
  const task = getQQMusicGuessLikeSongs(false).then(songs => {
    if (!isCurrentSnapshot(accountKey, generation)) return []
    qqGuessLikeQueue.splice(0, qqGuessLikeQueue.length, ...markRawList(songs))
    return songs
  }).finally(() => {
    if (request?.task == task) request = null
    if (isCurrentSnapshot(accountKey, generation)) isLoadingQQGuessLike.value = false
  })
  request = { accountKey, generation, continuation: false, task }
  return task
}
```

- [ ] **Step 4: Implement entry, synchronization, and exit.**

Add `syncQQGuessLikeTempList`, `enterQQGuessLikeMode`, and `syncQQGuessLikeModeWithPlayer`:

```ts
export const enterQQGuessLikeMode = async(accountKey: string) => {
  beginAccountSession(accountKey)
  if (!qqGuessLikeQueue.length) await prepareQQGuessLikeQueue(accountKey)
  if (!qqGuessLikeQueue.length) throw new Error('QQ Guess You Like has no songs')
  qqGuessLikeGeneration.value++
  isQQGuessLikeMode.value = true
  await syncQQGuessLikeTempList()
  clearPlayedList()
  playList(LIST_IDS.TEMP, 0)
}

export const syncQQGuessLikeModeWithPlayer = (accountKey: string | null) => {
  if (!isQQGuessLikeMode.value) return
  if (accountKey != qqGuessLikeOwnerAccountKey.value ||
      playInfo.playerListId != LIST_IDS.TEMP ||
      tempListMeta.id != QQ_GUESS_LIKE_TEMP_LIST_ID) {
    isQQGuessLikeMode.value = false
    qqGuessLikeGeneration.value++
    request = null
  }
}

export const isQQGuessLikeListActive = (accountKey: string | null) =>
  accountKey != null &&
  accountKey == qqGuessLikeOwnerAccountKey.value &&
  isQQGuessLikeMode.value &&
  playInfo.playerListId == LIST_IDS.TEMP &&
  tempListMeta.id == QQ_GUESS_LIKE_TEMP_LIST_ID
```

The route does not call this exit logic; only player/account ownership changes do.

- [ ] **Step 5: Implement continuation, deduplication, and retry release.**

`ensureQQGuessLikeNextSongs(accountKey)` must return a shared promise object for concurrent calls, use `remaining = queue.length - currentIndex - 1`, request only when `remaining <= 2`, and validate account/generation/list ownership before appending:

```ts
const getMusicId = (musicInfo: LX.Player.PlayMusicInfo['musicInfo'] | null) => {
  if (!musicInfo) return null
  return 'progress' in musicInfo ? musicInfo.metadata.musicInfo.id : musicInfo.id
}

export const ensureQQGuessLikeNextSongs = (accountKey: string | null): Promise<LX.Music.MusicInfo_tx[]> => {
  syncQQGuessLikeModeWithPlayer(accountKey)
  if (!accountKey || !isQQGuessLikeMode.value) return Promise.resolve([])
  const currentId = getMusicId(playMusicInfo.musicInfo)
  const currentIndex = qqGuessLikeQueue.findIndex(song => song.id == currentId)
  if (currentIndex < 0 || qqGuessLikeQueue.length - currentIndex - 1 > MIN_QUEUE_REMAINING) return Promise.resolve([])

  const generation = qqGuessLikeGeneration.value
  if (request?.accountKey == accountKey && request.generation == generation && request.continuation) return request.task
  const task = getQQMusicGuessLikeSongs(true).then(songs => {
    if (!isActiveSnapshot(accountKey, generation)) return []
    const ids = new Set(qqGuessLikeQueue.map(song => song.id))
    const nextSongs = markRawList(songs.filter(song => !ids.has(song.id)))
    if (!nextSongs.length) return []
    qqGuessLikeQueue.push(...nextSongs)
    return syncQQGuessLikeTempList().then(() => nextSongs)
  }).finally(() => {
    if (request?.task == task) request = null
  })
  request = { accountKey, generation, continuation: true, task }
  return task
}
```

Do not catch inside the action. Callers log background failures, and `finally` releases the request so the next track/end boundary retries.

- [ ] **Step 6: Run the queue test and verify the behavioral cases pass.**

Run: `node scripts/test-qq-music-continuous.js`

Expected: queue behavior passes; source-wiring assertions may remain RED until Tasks 4 and 5.

- [ ] **Step 7: Commit the queue implementation.**

```powershell
git add src/renderer/store/qqGuessLike/state.ts src/renderer/store/qqGuessLike/action.ts scripts/test-qq-music-continuous.js
git commit -m "feat: add continuous QQ recommendation queue"
```

### Task 4: Connect Account And QQ Page Lifecycles

**Files:**
- Modify: `src/renderer/store/qqMusic.ts`
- Modify: `src/renderer/views/Recommend/useQQGuessLikeData.ts`
- Modify: `src/renderer/views/QQRecommend/useQQGuessLikePlayback.ts`
- Modify: `src/renderer/views/QQRecommend/index.vue`
- Test: `scripts/test-qq-music-continuous.js`
- Test: `scripts/test-qq-music-renderer-account.js`

- [ ] **Step 1: Add failing account invalidation assertions.**

Inject a `resetQQGuessLikeQueue` spy into the renderer-account test loader. Assert a different committed UIN and successful logout reset the queue, while recommitting the same UIN does not:

```js
store.setQQMusicAccountStatus(loggedIn('account-a'))
store.setQQMusicAccountStatus(loggedIn('account-a'))
assert.strictEqual(resetCount, 1)
store.setQQMusicAccountStatus(loggedIn('account-b'))
assert.strictEqual(resetCount, 2)
await store.logoutQQMusicAccount()
assert.strictEqual(resetCount, 3)
```

- [ ] **Step 2: Reset only when committed identity changes.**

In `qqMusic.ts`, derive the account key before and after commit and invalidate on a real identity transition:

```ts
const getStatusAccountKey = (status: LX.QQMusic.AccountStatus) =>
  status.isLoggedIn ? status.profile?.uin ?? null : null

const commitQQMusicAccountStatus = (status: LX.QQMusic.AccountStatus) => {
  const previousKey = getStatusAccountKey(accountStatus.value)
  accountStatus.value = { isLoggedIn: status.isLoggedIn, profile: status.profile }
  if (previousKey != getStatusAccountKey(accountStatus.value)) resetQQGuessLikeQueue()
}
```

Because `logoutQQMusicAccount` commits `emptyStatus` only after main-process logout succeeds, a failed logout keeps both account and queue intact.

- [ ] **Step 3: Replace route-local data caching with the queue adapter.**

`useQQGuessLikeData.ts` keeps page-local `loadError` but uses global queue/loading state:

```ts
export const useQQGuessLikeData = () => {
  const songs = computed(() => qqGuessLikeQueue)
  const loadError = ref('')
  const load = async(force = false) => {
    const accountKey = getQQMusicAccountKey()
    if (!accountKey) return []
    loadError.value = ''
    try {
      return await prepareQQGuessLikeQueue(accountKey, force)
    } catch {
      loadError.value = LOAD_ERROR
      await initQQMusicAccount(true).catch(() => null)
      return []
    }
  }
  return {
    songs,
    isLoading: isLoadingQQGuessLike,
    loadError,
    load,
    clear: () => { loadError.value = '' },
  }
}
```

Export `getQQMusicAccountKey()` from the account store so page and player use one identity rule.

- [ ] **Step 4: Make the playback composable a thin global-store adapter.**

Retain login and pause/resume UI behavior, but remove route-local generation and queue ownership:

```ts
const isPlayingList = () => isQQGuessLikeListActive(getAccountKey())

const toggle = async() => {
  const accountKey = getAccountKey()
  if (!accountKey) return onLoginRequired()
  if (isPlayingList()) {
    if (isPlay.value) pause()
    else play()
    return
  }
  await loadSongs()
  await enterQQGuessLikeMode(accountKey)
}
```

The composable no longer exports `reset`.

- [ ] **Step 5: Remove route-unmount and watcher resets.**

In `QQRecommend/index.vue`, remove `resetPlayback`, remove the call from the account watcher, and leave `onBeforeUnmount` responsible only for removing `show-qq-music-login`:

```ts
onBeforeUnmount(() => {
  window.removeEventListener('show-qq-music-login', handleLoginRequest)
})
```

- [ ] **Step 6: Run focused lifecycle tests and verify GREEN.**

Run: `node scripts/test-qq-music-renderer-account.js`

Expected: `QQ Music renderer account tests passed`.

Run: `node scripts/test-qq-music-continuous.js`

Expected: queue and lifecycle cases pass except any player source assertion intentionally deferred to Task 5.

- [ ] **Step 7: Commit page/account integration.**

```powershell
git add src/renderer/store/qqMusic.ts src/renderer/views/Recommend/useQQGuessLikeData.ts src/renderer/views/QQRecommend/useQQGuessLikePlayback.ts src/renderer/views/QQRecommend/index.vue scripts/test-qq-music-renderer-account.js scripts/test-qq-music-continuous.js
git commit -m "feat: keep QQ recommendations active across routes"
```

### Task 5: Connect The Global Player Boundaries

**Files:**
- Modify: `src/renderer/core/useApp/usePlayer/usePlayer.ts`
- Test: `scripts/test-qq-music-continuous.js`

- [ ] **Step 1: Add one orchestration helper for both continuous sources.**

Import `getQQMusicAccountKey`, `ensureQQGuessLikeNextSongs`, and `syncQQGuessLikeModeWithPlayer`. Keep each provider's error isolated:

```ts
const ensureContinuousNextSongs = async() => {
  const results = await Promise.allSettled([
    ensurePrivateFmNextSongs(),
    ensureQQGuessLikeNextSongs(getQQMusicAccountKey()),
  ])
  if (results[0].status == 'rejected') console.warn('Load private FM next songs failed:', results[0].reason)
  if (results[1].status == 'rejected') console.warn('Load QQ Guess You Like next songs failed:', results[1].reason)
}
```

- [ ] **Step 2: Synchronize and prefetch after track changes.**

At the start of `handleUpdatePlayInfo`, call both ownership synchronizers and launch the shared guard:

```ts
syncPrivateFmModeWithPlayer()
syncQQGuessLikeModeWithPlayer(getQQMusicAccountKey())
setTitle(musicInfo.id ? `${musicInfo.name} - ${musicInfo.singer}` : null)
if (playMusicInfo.musicInfo) {
  const currentMusicInfo = 'progress' in playMusicInfo.musicInfo
    ? playMusicInfo.musicInfo.metadata.musicInfo
    : playMusicInfo.musicInfo
  addRecentPlayMusic(currentMusicInfo)
}
void ensureContinuousNextSongs()
```

- [ ] **Step 3: Await appends before end-of-track next selection.**

Replace the Private FM-only promise with:

```ts
void (async() => {
  await ensureContinuousNextSongs()
  await playNext(true)
})()
```

This guarantees a continuation appended at the final-track boundary is in `LIST_IDS.TEMP` before the next index is selected.

- [ ] **Step 4: Run the continuous behavior and player-ordering test.**

Run: `node scripts/test-qq-music-continuous.js`

Expected: `QQ Music continuous recommendation tests passed`.

- [ ] **Step 5: Commit player integration.**

```powershell
git add src/renderer/core/useApp/usePlayer/usePlayer.ts scripts/test-qq-music-continuous.js
git commit -m "feat: prefetch QQ recommendations during playback"
```

### Task 6: Regression And Build Verification

**Files:**
- Verify all files changed in Tasks 1-5.

- [ ] **Step 1: Run all focused QQ scripts.**

```powershell
node scripts/test-qq-music-auth.js
node scripts/test-qq-music-login.js
node scripts/test-qq-music-browser-auth.js
node scripts/test-qq-music-browser-login.js
node scripts/test-qq-music-account.js
node scripts/test-qq-music-renderer-account.js
node scripts/test-qq-music-song.js
node scripts/test-qq-music-ipc.js
node scripts/test-qq-music-ui-wiring.js
node scripts/test-provider-recommend-pages.js
node scripts/test-qq-music-continuous.js
```

Expected: every script exits 0 and prints its pass message.

- [ ] **Step 2: Run focused ESLint.**

```powershell
npx eslint src/common/types/qq_music.d.ts src/main/modules/qqMusic/song.ts src/main/modules/qqMusic/index.ts src/main/modules/winMain/rendererEvent/qqMusic.ts src/renderer/utils/ipc.ts src/renderer/store/qqMusic.ts src/renderer/store/qqGuessLike/state.ts src/renderer/store/qqGuessLike/action.ts src/renderer/views/Recommend/useQQGuessLikeData.ts src/renderer/views/QQRecommend/useQQGuessLikePlayback.ts src/renderer/views/QQRecommend/index.vue src/renderer/core/useApp/usePlayer/usePlayer.ts
```

Expected: exit 0 with no new lint findings.

- [ ] **Step 3: Build both affected processes.**

Run: `npm run build:main`

Expected: Webpack exits 0.

Run: `npm run build:renderer`

Expected: Webpack exits 0.

- [ ] **Step 4: Inspect only the feature diff and preserve unrelated work.**

```powershell
git diff -- src/common/types/qq_music.d.ts src/main/modules/qqMusic/song.ts src/main/modules/qqMusic/index.ts src/main/modules/winMain/rendererEvent/qqMusic.ts src/renderer/utils/ipc.ts src/renderer/store/qqMusic.ts src/renderer/store/qqGuessLike/state.ts src/renderer/store/qqGuessLike/action.ts src/renderer/views/Recommend/useQQGuessLikeData.ts src/renderer/views/QQRecommend/useQQGuessLikePlayback.ts src/renderer/views/QQRecommend/index.vue src/renderer/core/useApp/usePlayer/usePlayer.ts scripts/test-qq-music-song.js scripts/test-qq-music-ipc.js scripts/test-qq-music-renderer-account.js scripts/test-qq-music-continuous.js
```

Expected: no Cookie/UIN secrets, no unrelated file edits, no route-unmount reset, and no queue replacement during continuation.

- [ ] **Step 5: If verification required a feature fix, stage only the exact affected feature files shown by `git diff --name-only` and commit them with `git commit -m "fix: harden continuous QQ recommendation playback"`; otherwise make no additional commit.**
