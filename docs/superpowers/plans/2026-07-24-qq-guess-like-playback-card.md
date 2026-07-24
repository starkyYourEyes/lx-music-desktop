# QQ Guess-Like Playback Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the QQ Music multi-song recommendation section with a Private-FM-style card that lazily loads personalized songs and directly controls playback.

**Architecture:** Build a provider-aware special-card view model in `useRecommendCards`, keep account-scoped song caching in `useQQGuessLikeData`, and add a deduplicated lazy-play action to `useRecommendPlayback`. The recommendation view will stop preloading QQ songs and will route both card-surface and cover-button activation through the same direct-play handler.

**Tech Stack:** Vue 3 composition API, TypeScript, Electron IPC, existing LX temporary-list player APIs, Node `assert` regression scripts, Less CSS modules.

---

## File Map

- Modify `scripts/test-qq-music-ui-wiring.js`: replace section-list assertions with card, lazy-load, deduplication, playback, and no-navigation assertions.
- Modify `src/renderer/views/Recommend/types.ts`: add a provider-aware QQ guess-like special-card discriminator.
- Modify `src/renderer/views/Recommend/constants.ts`: add a stable QQ guess-like card ID while retaining the temporary-list ID.
- Modify `src/renderer/views/Recommend/useRecommendCards.ts`: derive the QQ card and insert it after Private FM.
- Modify `src/renderer/views/Recommend/useRecommendPlayback.ts`: lazily load songs, deduplicate pending activation, and toggle the QQ temporary list.
- Modify `src/renderer/views/Recommend/index.vue`: remove the song section, stop eager QQ loads, pass QQ state into the card builder, and open login or play from the card.
- Delete `src/renderer/views/Recommend/components/QQGuessLikeSection.vue`: remove the obsolete multi-song renderer.

### Task 1: Lock the New Card Contract with Failing Tests

**Files:**
- Modify: `scripts/test-qq-music-ui-wiring.js`
- Test: `scripts/test-qq-music-ui-wiring.js`

- [ ] **Step 1: Replace static section assertions with card assertions**

Read `types.ts`, `useRecommendCards.ts`, and `index.vue` in `testStaticWiring`, then assert the obsolete component is gone and the QQ card is wired through `SpecialCards`:

```js
const recommendTypes = fs.readFileSync(path.join(root, 'src/renderer/views/Recommend/types.ts'), 'utf8')
const recommendCards = fs.readFileSync(path.join(root, 'src/renderer/views/Recommend/useRecommendCards.ts'), 'utf8')

assert.doesNotMatch(recommendIndex, /QQGuessLikeSection/)
assert.doesNotMatch(recommendIndex, /<QQGuessLikeSection/)
assert.match(recommendTypes, /isQQGuessLike\?:\s*boolean/)
assert.match(recommendCards, /QQ_GUESS_LIKE_CARD_ID/)
assert.match(recommendCards, /isQQGuessLike:\s*true/)
assert.match(recommendCards, /result\.push\(privateFmCard\.value\)[\s\S]*?result\.push\(qqGuessLikeCard\.value\)/)
assert.match(recommendIndex, /:cards="specialCards"/)
assert.match(recommendIndex, /@open="handleOpenPlaylist"/)
assert.match(recommendIndex, /@toggle-card-play="handleToggleCardPlay"/)
```

Replace eager-load assertions with the lazy contract:

```js
assert.doesNotMatch(recommendIndex, /qqLoadCoordinator/)
assert.doesNotMatch(recommendIndex, /handleRefreshQQGuessLike/)
assert.doesNotMatch(recommendIndex, /handlePlayQQGuessLikeSongs/)
assert.match(recommendIndex, /loadQQGuessLikeSongs/)
assert.match(recommendIndex, /qqIsLoggedIn\.value\s*\|\|\s*appSetting\['recommend\.qqGuessLikeLoggedOutVisible'\]/)
```

- [ ] **Step 2: Add a runtime card-order and visibility test**

Load `useRecommendCards.ts` with mocked `computed`, daily recommendations, and Private FM state. Verify QQ is after Private FM, uses the first QQ song artwork after loading, and disappears only for logged-out users whose setting is disabled:

```js
const testQQGuessLikeCardComposition = () => {
  const dailySongs = [song('daily')]
  dailySongs[0].meta.picUrl = 'daily.jpg'
  const privateSongs = [song('private')]
  privateSongs[0].meta.picUrl = 'private.jpg'
  const qqSongs = ref([])
  const showQQGuessLike = ref(true)
  const isLoading = ref(false)
  const loadError = ref('')

  const cardsModule = loadTsModule(path.join(root, 'src/renderer/views/Recommend/useRecommendCards.ts'), {
    '@common/utils/vueTools': { computed: getter => ({ get value() { return getter() } }) },
    '@renderer/store/dailyRecommend/state': {
      DAILY_RECOMMEND_TEMP_LIST_ID: 'wy__wy_daily_recommend',
      dailyRecommendSongs: dailySongs,
    },
    '@renderer/store/privateFm/state': { privateFmQueue: privateSongs },
    './constants': {
      PRIVATE_FM_CARD_ID: 'private_fm',
      PRIVATE_RADAR_PLAYLIST_ID: '3136952023',
      QQ_GUESS_LIKE_CARD_ID: 'qq_guess_like',
    },
  })
  const state = cardsModule.useRecommendCards(ref([]), {
    showQQGuessLike,
    qqGuessLikeSongs: qqSongs,
    isQQGuessLikeLoading: isLoading,
    qqGuessLikeLoadError: loadError,
  })

  assert.deepStrictEqual(state.specialCards.value.map(card => card.id), [
    'wy__wy_daily_recommend', 'private_fm', 'qq_guess_like',
  ])
  assert.strictEqual(state.specialCards.value[2].isQQGuessLike, true)
  isLoading.value = true
  assert.strictEqual(state.specialCards.value[2].desc, '\u6b63\u5728\u4ece QQ \u97f3\u4e50\u52a0\u8f7d\u731c\u4f60\u559c\u6b22...')
  isLoading.value = false
  loadError.value = 'retryable load failure'
  assert.strictEqual(state.specialCards.value[2].desc, 'retryable load failure')
  loadError.value = ''
  qqSongs.value = [{ ...song('qq-first'), meta: { picUrl: 'qq.jpg' } }]
  assert.strictEqual(state.specialCards.value[2].img, 'qq.jpg')
  showQQGuessLike.value = false
  assert.strictEqual(state.specialCards.value.some(card => card.isQQGuessLike), false)
}
```

- [ ] **Step 3: Replace the existing QQ playback test with lazy-load behavior**

Initialize `qqGuessLikeSongs` as empty and pass a deferred loader into `useRecommendPlayback`. Assert two clicks while pending cause one request, success creates one temporary list, and the card never routes:

```js
const pendingLoad = deferred()
let loadCalls = 0
let accountKey = 'account-A'
const routerPushCalls = []
const qqGuessLikeSongs = ref([])
const playback = playbackModule.useRecommendPlayback({
  homeStyleSongs: ref([]),
  homeSimilarSongs: ref([]),
  qqGuessLikeSongs,
  getQQGuessLikeAccountKey: () => accountKey,
  onQQGuessLikeLoginRequired: () => {},
  loadQQGuessLikeSongs: async() => {
    loadCalls++
    await pendingLoad.promise
    qqGuessLikeSongs.value = [song('qq-1'), song('qq-2')]
  },
  setError: () => {},
})

const first = playback.handleToggleQQGuessLikeCard()
const duplicate = playback.handleToggleQQGuessLikeCard()
assert.strictEqual(loadCalls, 1)
pendingLoad.resolve()
await Promise.all([first, duplicate])
assert.strictEqual(loadCalls, 1)
assert.deepStrictEqual(setTempListCalls, [['tx__qq_guess_like', qqGuessLikeSongs.value]])
assert.deepStrictEqual(playListCalls, [[LIST_IDS.TEMP, 0]])

await playback.handleOpenPlaylist({
  id: 'qq_guess_like', source: 'tx', name: 'Guess You Like', img: '', desc: '',
  author: '', play_count: '', isQQGuessLike: true,
})
assert.deepStrictEqual(routerPushCalls, [])
```

Keep the existing pause/resume assertions, but invoke `handleToggleQQGuessLikeCard` and assert `loadCalls` remains `1`.

Set `accountKey = 'account-B'`, clear `qqGuessLikeSongs.value`, and activate again. Assert it loads a new queue instead of pausing or resuming the queue owned by `account-A`.

- [ ] **Step 4: Add failure and empty-result assertions**

Create a playback instance whose loader leaves `qqGuessLikeSongs.value` empty. Invoke it twice and assert each completed activation may retry while neither activation calls `setTempList` nor `playList`:

```js
await emptyPlayback.handleToggleQQGuessLikeCard()
await emptyPlayback.handleToggleQQGuessLikeCard()
assert.strictEqual(emptyLoadCalls, 2)
assert.deepStrictEqual(emptySetTempListCalls, [])
assert.deepStrictEqual(emptyPlayListCalls, [])
```

- [ ] **Step 5: Run the focused test and verify RED**

Run:

```powershell
node scripts/test-qq-music-ui-wiring.js
```

Expected: FAIL because `QQGuessLikeSection` is still rendered and `handleToggleQQGuessLikeCard` plus the QQ card discriminator do not exist.

- [ ] **Step 6: Commit the failing regression test**

```powershell
git add -- scripts/test-qq-music-ui-wiring.js
git commit -m "test: define QQ guess-like playback card behavior"
```

### Task 2: Build the QQ Special-Card View Model

**Files:**
- Modify: `src/renderer/views/Recommend/types.ts`
- Modify: `src/renderer/views/Recommend/constants.ts`
- Modify: `src/renderer/views/Recommend/useRecommendCards.ts`
- Test: `scripts/test-qq-music-ui-wiring.js`

- [ ] **Step 1: Add the card discriminator and stable ID**

Add the constant:

```ts
export const QQ_GUESS_LIKE_CARD_ID = 'qq_guess_like'
```

Make the shared card shape provider-aware while preserving all fields used by `SpecialCards` and `ExplorePlaylistGrid`:

```ts
export type RecommendCard = Omit<LX.Netease.Playlist, 'source'> & {
  source: 'wy' | 'tx'
  isPrivateFm?: boolean
  isDailyRecommend?: boolean
  isPrivateRadar?: boolean
  isQQGuessLike?: boolean
  isPlaceholder?: boolean
}
```

- [ ] **Step 2: Derive the QQ card in `useRecommendCards`**

Accept refs for visibility, songs, loading, and error state. Derive the card without requesting data:

```ts
const qqGuessLikeCard = computed((): RecommendCard | null => {
  if (!showQQGuessLike.value) return null
  const song = qqGuessLikeSongs.value[0]
  return {
    id: QQ_GUESS_LIKE_CARD_ID,
    source: 'tx',
    play_count: '',
    author: song?.singer ?? 'QQ Music',
    name: '\u731c\u4f60\u559c\u6b22',
    time: '',
    img: song?.meta.picUrl ?? '',
    desc: isQQGuessLikeLoading.value
      ? '\u6b63\u5728\u4ece QQ \u97f3\u4e50\u52a0\u8f7d\u731c\u4f60\u559c\u6b22...'
      : qqGuessLikeLoadError.value || song?.name || 'QQ Music',
    total: qqGuessLikeSongs.value.length ? String(qqGuessLikeSongs.value.length) : '',
    isQQGuessLike: true,
  }
})
```

The Unicode escapes above render the existing Chinese UI label while keeping the plan file ASCII. Source code may use the repository's existing literal Chinese style. Insert the card after Private FM:

```ts
if (dailyRecommendCard.value) result.push(dailyRecommendCard.value)
if (privateFmCard.value) result.push(privateFmCard.value)
if (qqGuessLikeCard.value) result.push(qqGuessLikeCard.value)
if (privateRadarCard.value) result.push(privateRadarCard.value)
```

Return `QQ Music` from `getSpecialCardKicker` when `isQQGuessLike` is true.

- [ ] **Step 3: Run the focused test and verify the card tests pass up to playback**

Run:

```powershell
node scripts/test-qq-music-ui-wiring.js
```

Expected: card composition assertions pass; the test still fails on the missing lazy playback handler or obsolete section wiring.

- [ ] **Step 4: Commit the card model**

```powershell
git add -- src/renderer/views/Recommend/types.ts src/renderer/views/Recommend/constants.ts src/renderer/views/Recommend/useRecommendCards.ts
git commit -m "feat: add QQ guess-like special card"
```

### Task 3: Implement Lazy Direct Playback

**Files:**
- Modify: `src/renderer/views/Recommend/useRecommendPlayback.ts`
- Test: `scripts/test-qq-music-ui-wiring.js`

- [ ] **Step 1: Add the lazy loader dependency and pending guard**

Add `loadQQGuessLikeSongs: () => Promise<void>`, `getQQGuessLikeAccountKey: () => string | null`, and `onQQGuessLikeLoginRequired: () => void` to the composable options. Track the account that owns the installed queue and share the complete load-and-play task for duplicate activations:

```ts
let qqGuessLikeQueueAccountKey: string | null = null
let qqGuessLikeActivation: { accountKey: string, task: Promise<void> } | null = null

const startQQGuessLike = async(accountKey: string) => {
  if (!qqGuessLikeSongs.value.length) await loadQQGuessLikeSongs()
  if (getQQGuessLikeAccountKey() != accountKey || !qqGuessLikeSongs.value.length) return
  await setTempList(QQ_GUESS_LIKE_TEMP_LIST_ID, toCloneable(qqGuessLikeSongs.value))
  if (getQQGuessLikeAccountKey() != accountKey) return
  qqGuessLikeQueueAccountKey = accountKey
  playList(LIST_IDS.TEMP, 0)
}
```

- [ ] **Step 2: Replace list-section handlers with one card handler**

Implement pause/resume before loading, then install the first non-empty queue:

```ts
const handleToggleQQGuessLikeCard = async() => {
  const accountKey = getQQGuessLikeAccountKey()
  if (!accountKey) {
    onQQGuessLikeLoginRequired()
    return
  }
  if (isQQGuessLikePlayingList()) {
    if (isPlay.value) pause()
    else play()
    return
  }
  if (qqGuessLikeActivation?.accountKey == accountKey) return qqGuessLikeActivation.task

  const task = startQQGuessLike(accountKey)
  qqGuessLikeActivation = { accountKey, task }
  try {
    await task
  } finally {
    if (qqGuessLikeActivation?.task == task) qqGuessLikeActivation = null
  }
}
```

Define `isQQGuessLikePlayingList` as the temporary-list check plus `qqGuessLikeQueueAccountKey == getQQGuessLikeAccountKey()`. This prevents account B from resuming account A's installed queue.

Remove `isQQGuessLikeSongPlaying` and `handlePlayQQGuessLikeSongs`, which existed only for the deleted song list.

- [ ] **Step 3: Route both special-card events to direct playback**

Update `handleOpenPlaylist`, `isCardPlaying`, `getCardPlayLabel`, and `handleToggleCardPlay`:

```ts
if (playlist.isQQGuessLike) {
  await handleToggleQQGuessLikeCard()
  return
}
```

`handleOpenPlaylist` should become `async` so tests can await it. Its normal playlist branch still calls `router.push`, while the QQ branch returns before navigation.

Change `handleTogglePrivateRadar` to accept `RecommendCard` and call `playSongListDetail(playlist.id, 'wy')`. This keeps the private-radar branch type-safe after `RecommendCard.source` becomes provider-aware.

- [ ] **Step 4: Run the focused test and verify playback behavior passes**

Run:

```powershell
node scripts/test-qq-music-ui-wiring.js
```

Expected: lazy-load, duplicate-click, direct-play, pause/resume, empty-result, and no-navigation assertions pass; static wiring may still fail until Task 4.

- [ ] **Step 5: Commit lazy playback**

```powershell
git add -- src/renderer/views/Recommend/useRecommendPlayback.ts scripts/test-qq-music-ui-wiring.js
git commit -m "feat: lazily play QQ guess-like recommendations"
```

### Task 4: Replace the Song Section in the Recommendation View

**Files:**
- Modify: `src/renderer/views/Recommend/index.vue`
- Delete: `src/renderer/views/Recommend/components/QQGuessLikeSection.vue`
- Test: `scripts/test-qq-music-ui-wiring.js`

- [ ] **Step 1: Remove the multi-song component and its bindings**

Delete the `<QQGuessLikeSection ... />` template block and its import. Remove single-song playback, refresh, and QQ love-status bindings that no longer have a UI consumer.

- [ ] **Step 2: Derive card visibility and pass QQ state to `useRecommendCards`**

```ts
const showQQGuessLikeCard = computed(() => (
  qqIsLoggedIn.value || appSetting['recommend.qqGuessLikeLoggedOutVisible']
))

const { specialCards, getSpecialCardKicker } = useRecommendCards(specialSourcePlaylists, {
  showQQGuessLike: showQQGuessLikeCard,
  qqGuessLikeSongs,
  isQQGuessLikeLoading,
  qqGuessLikeLoadError,
})
```

Pass the lazy loader and login callbacks to playback so both card events share the same login behavior:

```ts
const loadQQGuessLikeForPlayback = async() => {
  await loadQQGuessLikeSongs()
}

const playback = useRecommendPlayback({
  homeStyleSongs,
  homeSimilarSongs,
  qqGuessLikeSongs,
  getQQGuessLikeAccountKey: () => qqAccountKey.value,
  onQQGuessLikeLoginRequired: handleShowQQLogin,
  loadQQGuessLikeSongs: loadQQGuessLikeForPlayback,
  setError: message => {
    playlistLoadError.value = message
  },
})
```

Relocate the `useRecommendPlayback` initialization below the `handleShowQQLogin` declaration so the callback is initialized before it is passed. `handleOpenPlaylist` and `handleToggleCardPlay` both call `handleToggleQQGuessLikeCard`, so a logged-out activation invokes `handleShowQQLogin` and returns before loading or routing.

- [ ] **Step 3: Remove eager QQ recommendation lifecycle code**

On QQ login success, close the panel only:

```ts
useQQMusicLoginQr(async() => {
  handleCloseQQLogin()
})
```

On QQ account changes, invalidate stale visible data but do not call `loadQQGuessLikeSongs`:

```ts
watch(qqAccountKey, (value, oldValue) => {
  if (value == oldValue) return
  clearQQGuessLikeSongs()
  if (value) handleCloseQQLogin()
})
```

Initialization restores only account state:

```ts
const initializeQQAccount = async() => {
  await initQQMusicAccount().catch(() => null)
  if (!qqAccountKey.value) clearQQGuessLikeSongs()
}
```

Remove `qqLoadCoordinator`, QQ initialization suppression flags, forced QQ loading flags, and refresh handlers. Keep NetEase coordinator and lifecycle unchanged.

- [ ] **Step 4: Delete the obsolete component**

Delete `src/renderer/views/Recommend/components/QQGuessLikeSection.vue`. The file is recoverable from Git history and has no remaining imports.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```powershell
node scripts/test-qq-music-ui-wiring.js
```

Expected: `QQ Music account menu and recommendation state tests passed`.

- [ ] **Step 6: Commit recommendation-view integration**

```powershell
git add -- src/renderer/views/Recommend/index.vue src/renderer/views/Recommend/components/QQGuessLikeSection.vue scripts/test-qq-music-ui-wiring.js
git commit -m "refactor: show QQ guess-like as a playback card"
```

### Task 5: Verify the Complete Change

**Files:**
- Verify: all files changed in Tasks 1-4

- [ ] **Step 1: Run focused QQ regression tests**

```powershell
node scripts/test-qq-music-ui-wiring.js
node scripts/test-qq-music-login.js
node scripts/test-qq-music-browser-auth.js
node scripts/test-qq-music-browser-login.js
node scripts/test-electron-security-boundaries.js
node scripts/test-web-contents-navigation-guard.js
```

Expected: every command exits `0` and prints its pass message.

- [ ] **Step 2: Lint the touched implementation and test files**

```powershell
npx eslint src/renderer/views/Recommend/index.vue src/renderer/views/Recommend/types.ts src/renderer/views/Recommend/constants.ts src/renderer/views/Recommend/useRecommendCards.ts src/renderer/views/Recommend/useRecommendPlayback.ts scripts/test-qq-music-ui-wiring.js
```

Expected: exit code `0` with no lint errors.

- [ ] **Step 3: Build both renderer and main process**

```powershell
npm run build:renderer
npm run build:main
```

Expected: both webpack builds exit `0` and report `compiled successfully`.

- [ ] **Step 4: Check the final diff**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; status contains only intended QQ feature changes plus pre-existing unrelated worktree changes.

- [ ] **Step 5: Manually verify in Electron**

Using the existing development process, verify:

1. QQ login remains restored after the main-process restart.
2. The old QQ song row is absent.
3. The QQ card appears after Private FM and uses the same responsive layout.
4. A logged-in first click loads songs and starts playback without changing routes.
5. Subsequent clicks pause and resume without a new load indicator.
6. A logged-out click opens QQ login when the setting is enabled.
7. Disabling the logged-out setting hides only the QQ card.
8. NetEase cards and sections behave as before.
