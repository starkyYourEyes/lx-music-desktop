# QQ Music Login and Guess You Like Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent QQ Music QR login and account-specific "猜你喜欢" songs while keeping QQ credentials in the Electron main process and preserving the existing NetEase workflow.

**Architecture:** A new main-process QQ Music module owns QR sessions, OAuth Cookies, account persistence, and radio ID 99 requests. Typed IPC exposes only safe account summaries, QR images, opaque session IDs, and normalized `tx` songs. Renderer-side provider state, login polling, account menu, settings, and recommendation UI remain separate from NetEase data but reuse the existing song grid, local favorites, and player queue.

**Tech Stack:** Electron 37, Node.js 22 fetch/AbortController/FormData APIs, TypeScript 5.9, Vue 3 Composition API, Pug/LESS, repository Node assertion test scripts, existing IPC/store/player helpers.

---

## Scope and Worktree Protection

The approved design is in `docs/superpowers/specs/2026-07-23-qq-music-login-guess-like-design.md`.

This repository is already heavily dirty, including several files this feature must modify. Before every task:

```powershell
git status --short
git diff --cached --name-only
```

Never reset, restore, or overwrite existing changes. A commit step may stage a newly created file directly. If an existing file was already dirty before the task, stage only a patch proven to contain this task's hunks. If that cannot be done safely, leave the task changes unstaged and record the checkpoint instead of committing unrelated user work.

## File Structure

### New main-process units

- `src/main/modules/qqMusic/auth.ts`: login hashes, structured Cookie parsing/merging, redaction, and expiring QR-session storage.
- `src/main/modules/qqMusic/login.ts`: QQ QR creation, QR status polling, QQ OAuth authorization, and final QQ Music Cookie acquisition.
- `src/main/modules/qqMusic/song.ts`: radio ID 99 request and `MusicInfo_tx` normalization.
- `src/main/modules/qqMusic/index.ts`: account persistence facade and singleton exports used by IPC.
- `src/main/modules/winMain/rendererEvent/qqMusic.ts`: safe typed IPC handlers.
- `src/common/types/qq_music.d.ts`: shared account, QR, and status contracts with no credential fields.

### New renderer units

- `src/renderer/store/qqMusic.ts`: renderer-safe QQ account summary and initialization lifecycle.
- `src/renderer/views/Recommend/useQQMusicLoginQr.ts`: QQ modal state and two-second polling.
- `src/renderer/views/Recommend/useQQGuessLikeData.ts`: account-keyed memory cache, load, refresh, and error state.
- `src/renderer/views/Recommend/components/QQGuessLikeSection.vue`: logged-out prompt plus logged-in loading/error/song states.

### New tests and license

- `scripts/test-qq-music-auth.js`: auth primitives, Cookie parsing, redaction, and QR-session expiry.
- `scripts/test-qq-music-login.js`: QR response-state mapping and the complete mocked QQ OAuth Cookie chain.
- `scripts/test-qq-music-song.js`: request contract and QQ song normalization.
- `scripts/test-qq-music-account.js`: persistence, restart, logout, and invalid-session behavior.
- `scripts/test-qq-music-ipc.js`: IPC/type/wiring security contract.
- `scripts/test-qq-music-renderer-account.js`: renderer store lifecycle.
- `scripts/test-qq-music-ui-wiring.js`: account menu, modal, settings, route, recommendation, and playback wiring.
- `licenses/qq-music-api-MIT.txt`: complete upstream MIT notice.

### Existing files to modify

- `src/common/constants.ts`: `DATA_KEYS.qqMusicAccount`.
- `src/common/defaultSetting.ts`: logged-out section visibility default.
- `src/common/ipcNames.ts`: QQ IPC names.
- `src/common/types/app_setting.d.ts`: setting type.
- `src/main/types/common.d.ts`, `src/renderer/types/common.d.ts`: import QQ shared types.
- `src/main/modules/winMain/rendererEvent/index.ts`: register QQ handlers.
- `src/renderer/utils/ipc.ts`: safe QQ renderer wrappers.
- `src/renderer/components/layout/Aside/index.vue`: two-provider account popover.
- `src/renderer/views/Recommend/components/LoginPanel.vue`: provider-specific title and instruction props.
- `src/renderer/views/Recommend/constants.ts`: QQ temporary player-list ID.
- `src/renderer/views/Recommend/useRecommendPlayback.ts`: third reusable song section.
- `src/renderer/views/Recommend/index.vue`: QQ login, route consumption, recommendation rendering, playback, and favorites.
- `src/renderer/views/Setting/components/SettingRecommend.vue`: logged-out visibility checkbox.
- `src/lang/zh-cn.json`, `src/lang/zh-tw.json`, `src/lang/en-us.json`: setting labels.

---

### Task 1: Authentication Primitives, QR Sessions, and MIT Notice

**Files:**
- Create: `scripts/test-qq-music-auth.js`
- Create: `src/main/modules/qqMusic/auth.ts`
- Create: `licenses/qq-music-api-MIT.txt`

- [ ] **Step 1: Write the failing authentication utility test**

Create `scripts/test-qq-music-auth.js`:

```js
const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const {
  hash33,
  getGtk,
  getSetCookieValues,
  mergeCookieValues,
  redactQQMusicSecret,
  createQrSessionStore,
} = loadTsModule(path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'))

assert.strictEqual(hash33('test-qrsig'), 1041100915)
assert.strictEqual(getGtk('test-p_skey'), 1737020733)

const structuredHeaders = {
  getSetCookie: () => [
    'uin=o123; Path=/; HttpOnly',
    'qqmusic_key=value=with=equals; Path=/',
    'uin=o456; Path=/',
  ],
  get: () => null,
}
assert.deepStrictEqual(getSetCookieValues(structuredHeaders), [
  'uin=o123; Path=/; HttpOnly',
  'qqmusic_key=value=with=equals; Path=/',
  'uin=o456; Path=/',
])
assert.strictEqual(
  mergeCookieValues(getSetCookieValues(structuredHeaders)),
  'uin=o456; qqmusic_key=value=with=equals',
)

const fallbackHeaders = {
  get: () => 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2; Path=/',
}
assert.strictEqual(mergeCookieValues(getSetCookieValues(fallbackHeaders)), 'a=1; b=2')
assert.strictEqual(
  redactQQMusicSecret('Cookie: uin=o123; qqmusic_key=secret qrsig=qr-value code=oauth-code'),
  'Cookie: [REDACTED] qrsig=[REDACTED] code=[REDACTED]',
)

let now = 1000
let nextId = 0
const sessions = createQrSessionStore({
  now: () => now,
  idFactory: () => `session-${++nextId}`,
  ttlMs: 5000,
})
const key = sessions.create({ qrsig: 'qr', ptqrtoken: 7 })
assert.strictEqual(key, 'session-1')
assert.deepStrictEqual(sessions.get(key), { qrsig: 'qr', ptqrtoken: 7 })
now = 6001
assert.strictEqual(sessions.get(key), null)
assert.strictEqual(sessions.size(), 0)

console.log('QQ Music auth tests passed')
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run:

```powershell
node scripts/test-qq-music-auth.js
```

Expected: FAIL because `src/main/modules/qqMusic/auth.ts` does not exist.

- [ ] **Step 3: Implement the authentication primitives**

Create `src/main/modules/qqMusic/auth.ts` with these public contracts and behavior:

```ts
export interface QQQrSession {
  qrsig: string
  ptqrtoken: number
}

interface HeadersWithSetCookie {
  getSetCookie?: () => string[]
  get: (name: string) => string | null
}

export const hash33 = (value: string): number => {
  let hash = 0
  for (const char of value) hash += (hash << 5) + char.charCodeAt(0)
  return hash & 0x7fffffff
}

export const getGtk = (value: string): number => {
  let hash = 5381
  for (const char of value) hash += (hash << 5) + char.charCodeAt(0)
  return hash & 0x7fffffff
}

export const getGuid = (): string => crypto.randomUUID().toUpperCase()

const splitCombinedSetCookie = (value: string): string[] => {
  return value.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/).map(item => item.trim()).filter(Boolean)
}

export const getSetCookieValues = (headers: HeadersWithSetCookie): string[] => {
  const structured = headers.getSetCookie?.()
  if (structured?.length) return structured
  const combined = headers.get('set-cookie')
  return combined ? splitCombinedSetCookie(combined) : []
}

const getCookiePair = (value: string) => {
  const pair = value.split(';', 1)[0].trim()
  const separator = pair.indexOf('=')
  if (separator <= 0 || separator == pair.length - 1) return null
  return {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
  }
}

export const mergeCookieValues = (values: string[]): string => {
  const cookies = new Map<string, string>()
  for (const value of values) {
    const pair = getCookiePair(value)
    if (pair) cookies.set(pair.name, `${pair.name}=${pair.value}`)
  }
  return [...cookies.values()].join('; ')
}

export const getCookieValue = (cookie: string, name: string): string => {
  for (const item of cookie.split(';')) {
    const pair = getCookiePair(item)
    if (pair?.name == name) return pair.value
  }
  return ''
}

export const redactQQMusicSecret = (value: unknown): string => {
  return String(value)
    .replace(/Cookie:\s*[^\r\n]+?(?=\s+qrsig=|$)/gi, 'Cookie: [REDACTED]')
    .replace(/\b(qrsig|ptqrtoken|code)=([^\s&]+)/gi, '$1=[REDACTED]')
}

export const createQrSessionStore = ({
  now = Date.now,
  idFactory = () => crypto.randomUUID(),
  ttlMs = 5 * 60 * 1000,
}: {
  now?: () => number
  idFactory?: () => string
  ttlMs?: number
} = {}) => {
  const entries = new Map<string, { value: QQQrSession, expiresAt: number }>()
  const clearExpired = () => {
    const current = now()
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(key)
    }
  }
  return {
    create(value: QQQrSession) {
      clearExpired()
      const key = idFactory()
      entries.set(key, { value, expiresAt: now() + ttlMs })
      return key
    },
    get(key: string) {
      clearExpired()
      return entries.get(key)?.value ?? null
    },
    delete(key: string) {
      entries.delete(key)
    },
    clearExpired,
    size() {
      clearExpired()
      return entries.size
    },
  }
}

export type QQQrSessionStore = ReturnType<typeof createQrSessionStore>
```

- [ ] **Step 4: Add the upstream MIT notice**

Create `licenses/qq-music-api-MIT.txt` with the complete MIT text from `sansenjian/qq-music-api/LICENSE`, including the 2019 copyright line and all permission and warranty paragraphs. Do not paraphrase it.

- [ ] **Step 5: Run the focused test**

Run:

```powershell
node scripts/test-qq-music-auth.js
```

Expected: `QQ Music auth tests passed`.

- [ ] **Step 6: Commit the isolated new files**

```powershell
git add -- scripts/test-qq-music-auth.js src/main/modules/qqMusic/auth.ts licenses/qq-music-api-MIT.txt
git diff --cached --check
git commit -m "feat: add QQ Music auth primitives"
```

Expected: the commit contains only these three new files.

---

### Task 2: Guess You Like Request and Song Normalization

**Files:**
- Create: `scripts/test-qq-music-song.js`
- Create: `src/main/modules/qqMusic/song.ts`

- [ ] **Step 1: Write the failing song-service test**

Create a fixture with one valid track, a duplicate MID, and one malformed track. The test must assert the request body and normalized shape:

```js
const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

let request
const fetchImpl = async(url, options) => {
  request = { url, options }
  return {
    ok: true,
    json: async() => ({
      code: 0,
      songlist: {
        code: 0,
        data: {
          tracks: [
            {
              id: 17,
              mid: 'song-mid',
              name: 'Song',
              interval: 185,
              singer: [{ name: 'Singer' }],
              album: { mid: 'album-mid', name: 'Album' },
              file: {
                media_mid: 'media-mid',
                size_128mp3: 1024,
                size_320mp3: 2048,
                size_flac: 4096,
                size_hires: 0,
              },
            },
            { id: 18, mid: 'song-mid', name: 'Duplicate', file: {} },
            { id: 19, mid: '', name: 'Malformed', file: {} },
          ],
        },
      },
    }),
  }
}

const { createQQMusicSongService, QQMusicAuthError } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/song.ts'),
  {
    '@common/utils/common': {
      formatPlayTime: value => `time:${value}`,
      sizeFormate: value => `size:${value}`,
    },
  },
)

const service = createQQMusicSongService({
  fetchImpl,
  getCookie: () => 'uin=o123; qqmusic_key=secret',
})

service.getGuessLikeSongs().then(songs => {
  assert.match(String(request.url), /musicu\.fcg/)
  assert.strictEqual(request.options.headers.Cookie, 'uin=o123; qqmusic_key=secret')
  const body = JSON.parse(request.options.body)
  assert.deepStrictEqual(body.songlist.param, { id: 99, firstplay: 1, num: 15 })
  assert.strictEqual(songs.length, 1)
  assert.deepStrictEqual(songs[0], {
    id: 'tx_song-mid',
    name: 'Song',
    singer: 'Singer',
    source: 'tx',
    interval: 'time:185',
    meta: {
      songId: 'song-mid',
      albumName: 'Album',
      albumId: 'album-mid',
      picUrl: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000album-mid.jpg',
      strMediaMid: 'media-mid',
      id: 17,
      albumMid: 'album-mid',
      qualitys: [
        { type: 'flac', size: 'size:4096' },
        { type: '320k', size: 'size:2048' },
        { type: '128k', size: 'size:1024' },
      ],
      _qualitys: {
        flac: { size: 'size:4096' },
        '320k': { size: 'size:2048' },
        '128k': { size: 'size:1024' },
      },
    },
  })

  const noCookie = createQQMusicSongService({ fetchImpl, getCookie: () => '' })
  return assert.rejects(noCookie.getGuessLikeSongs(), QQMusicAuthError)
}).then(() => {
  console.log('QQ Music song tests passed')
}).catch(err => {
  console.error(err)
  process.exitCode = 1
})
```

- [ ] **Step 2: Run the test and verify failure**

Run `node scripts/test-qq-music-song.js`.

Expected: FAIL because `song.ts` is missing.

- [ ] **Step 3: Implement the focused song service**

Create `src/main/modules/qqMusic/song.ts` with this complete service structure:

```ts
import { formatPlayTime, sizeFormate } from '@common/utils/common'
import { getCookieValue } from './auth'

export class QQMusicAuthError extends Error {
  constructor(message = 'QQ Music login expired') {
    super(message)
    this.name = 'QQMusicAuthError'
  }
}

export const isQQMusicAuthError = (error: unknown) => {
  return error instanceof QQMusicAuthError || (error as Error | null)?.name == 'QQMusicAuthError'
}

const getTracks = (payload: any): any[] | null => {
  const tracks = payload?.songlist?.data?.tracks ?? payload?.songlist?.data?.track_list
  return Array.isArray(tracks) ? tracks : null
}

const getSinger = (singers: any[] = []) => singers.map(singer => singer?.name).filter(Boolean).join('、')

const getArtwork = (song: any) => {
  const albumMid = song?.album?.mid ?? ''
  if (albumMid) return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`
  const singerMid = song?.singer?.[0]?.mid ?? ''
  return singerMid ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${singerMid}.jpg` : ''
}

const createQualityInfo = (file: any) => {
  const qualitys: LX.Music.MusicQualityType[] = []
  const _qualitys: LX.Music._MusicQualityType = {}
  const add = (type: LX.Quality, size: number) => {
    if (!(size > 0)) return
    const value = sizeFormate(size)
    qualitys.push({ type, size: value })
    _qualitys[type] = { size: value }
  }
  add('flac24bit', file?.size_hires)
  add('flac', file?.size_flac)
  add('320k', file?.size_320mp3)
  add('128k', file?.size_128mp3)
  return { qualitys, _qualitys }
}

export const normalizeGuessLikeSongs = (payload: any): LX.Music.MusicInfo_tx[] => {
  const tracks = getTracks(payload)
  if (!tracks) throw new Error('Invalid QQ Music guess-like response')
  const ids = new Set<string>()
  const songs: LX.Music.MusicInfo_tx[] = []
  for (const song of tracks) {
    const mid = String(song?.mid ?? '')
    const name = song?.name ?? song?.title ?? ''
    if (!mid || !name || ids.has(mid)) continue
    ids.add(mid)
    const albumMid = song?.album?.mid ?? ''
    const { qualitys, _qualitys } = createQualityInfo(song?.file)
    songs.push({
      id: `tx_${mid}`,
      name,
      singer: getSinger(song?.singer),
      source: 'tx',
      interval: typeof song?.interval == 'number' ? formatPlayTime(song.interval) : null,
      meta: {
        songId: mid,
        albumName: song?.album?.name ?? '',
        albumId: albumMid,
        picUrl: getArtwork(song),
        qualitys,
        _qualitys,
        strMediaMid: song?.file?.media_mid ?? mid,
        id: song?.id,
        albumMid,
      },
    })
  }
  return songs
}

export const createQQMusicSongService = ({
  fetchImpl = fetch,
  getCookie,
}: {
  fetchImpl?: typeof fetch
  getCookie: () => string
}) => {
  const getGuessLikeSongs = async(): Promise<LX.Music.MusicInfo_tx[]> => {
    const cookie = getCookie()
    if (!cookie) throw new QQMusicAuthError('QQ Music account is not logged in')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const loginUin = getCookieValue(cookie, 'uin') || getCookieValue(cookie, 'qqmusic_uin')
      const url = new URL('https://u.y.qq.com/cgi-bin/musicu.fcg')
      url.searchParams.set('format', 'json')
      url.searchParams.set('platform', 'yqq.json')
      url.searchParams.set('loginUin', loginUin.replace(/^o/, ''))
      const response = await fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://y.qq.com/',
          Cookie: cookie,
        },
        body: JSON.stringify({
          comm: { ct: 24, cv: 0 },
          songlist: {
            module: 'mb_track_radio_svr',
            method: 'get_radio_track',
            param: { id: 99, firstplay: 1, num: 15 },
          },
        }),
      })
      if (!response.ok) throw new Error(`QQ Music request failed: ${response.status}`)
      const payload = await response.json()
      if (payload?.songlist?.code == 1000) throw new QQMusicAuthError()
      if (payload?.code != 0 || payload?.songlist?.code != 0) throw new Error('QQ Music guess-like request failed')
      return normalizeGuessLikeSongs(payload)
    } finally {
      clearTimeout(timer)
    }
  }
  return { getGuessLikeSongs }
}
```

The existing test's `fetchImpl` accepts the `URL` object. If the project lint rule requires a string, pass `url.toString()` and keep the same assertion.

- [ ] **Step 4: Run the focused test**

Run `node scripts/test-qq-music-song.js`.

Expected: `QQ Music song tests passed`.

- [ ] **Step 5: Commit**

```powershell
git add -- scripts/test-qq-music-song.js src/main/modules/qqMusic/song.ts
git diff --cached --check
git commit -m "feat: add QQ Music guess-like service"
```

---

### Task 3: QQ QR/OAuth Flow and Persistent Account Facade

**Files:**
- Create: `scripts/test-qq-music-login.js`
- Create: `scripts/test-qq-music-account.js`
- Create: `src/main/modules/qqMusic/login.ts`
- Create: `src/main/modules/qqMusic/index.ts`
- Modify: `src/common/constants.ts`

- [ ] **Step 1: Write the failing account test**

The test uses an in-memory store and injected login/song services. It must cover restart, success, logout, and explicit auth failure:

```js
const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const data = new Map()
const store = {
  get: key => data.get(key),
  set: (key, value) => data.set(key, value),
}
let loginResult = {
  state: 'success',
  message: '登录成功',
  cookie: 'uin=o123; qqmusic_key=secret',
}
let songError = null
class QQMusicAuthError extends Error {}
const loginService = {
  createLoginQr: async() => ({ key: 'opaque', qrimg: 'data:image/png;base64,AA==' }),
  checkLoginQr: async() => loginResult,
}
const songService = {
  getGuessLikeSongs: async() => {
    if (songError) throw songError
    return [{ id: 'tx_mid' }]
  },
}

const { createQQMusicAccountService } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/index.ts'),
  {
    '@common/constants': { DATA_KEYS: { qqMusicAccount: 'qqMusicAccount' }, STORE_NAMES: { DATA: 'data' } },
    '@main/utils/store': () => store,
    './login': { createQQMusicLoginService: () => loginService },
    './song': {
      QQMusicAuthError,
      isQQMusicAuthError: error => error instanceof QQMusicAuthError,
      createQQMusicSongService: () => songService,
    },
  },
)

const service = createQQMusicAccountService({ store, loginService, songService, now: () => 42 })

Promise.resolve().then(async() => {
  assert.deepStrictEqual(await service.getAccountStatus(), { isLoggedIn: false, profile: null })
  const check = await service.checkLoginQr('opaque')
  assert.strictEqual(check.state, 'success')
  assert.deepStrictEqual(check.profile, { uin: 'o123', nickname: 'QQ 音乐账号' })
  assert.strictEqual(data.get('qqMusicAccount').cookie, 'uin=o123; qqmusic_key=secret')

  const restored = createQQMusicAccountService({ store, loginService, songService, now: () => 84 })
  assert.deepStrictEqual(await restored.getAccountStatus(), {
    isLoggedIn: true,
    profile: { uin: 'o123', nickname: 'QQ 音乐账号' },
  })
  assert.strictEqual((await restored.getGuessLikeSongs()).length, 1)

  songError = new Error('network unavailable')
  await assert.rejects(restored.getGuessLikeSongs(), /network unavailable/)
  assert.strictEqual((await restored.getAccountStatus()).isLoggedIn, true)

  songError = new QQMusicAuthError('expired')
  await assert.rejects(restored.getGuessLikeSongs(), QQMusicAuthError)
  assert.deepStrictEqual(await restored.getAccountStatus(), { isLoggedIn: false, profile: null })

  songError = null
  await restored.logout()
  assert.deepStrictEqual(await restored.getAccountStatus(), { isLoggedIn: false, profile: null })
}).then(() => {
  console.log('QQ Music account tests passed')
}).catch(err => {
  console.error(err)
  process.exitCode = 1
})
```

- [ ] **Step 2: Write the failing real login-service test**

Create `scripts/test-qq-music-login.js`. It uses fresh services for status mapping and one complete sequential OAuth fixture:

```js
const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const headers = ({ setCookie = [], location = null } = {}) => ({
  getSetCookie: () => setCookie,
  get: name => name.toLowerCase() == 'location' ? location : null,
})

const response = ({ ok = true, status = 200, text = '', bytes = [1], setCookie = [], location = null } = {}) => ({
  ok,
  status,
  headers: headers({ setCookie, location }),
  text: async() => text,
  arrayBuffer: async() => Uint8Array.from(bytes).buffer,
})

const { createQrSessionStore } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'),
)
const { createQQMusicLoginService, parseQQQrStatus } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/login.ts'),
  {
    './auth': loadTsModule(path.join(__dirname, '../src/main/modules/qqMusic/auth.ts')),
  },
)

assert.deepStrictEqual(parseQQQrStatus("ptuiCB('66','0','','0','二维码未失效。','')"), { code: '66', redirectUrl: '' })
assert.deepStrictEqual(parseQQQrStatus("ptuiCB('67','0','','0','二维码认证中。','')"), { code: '67', redirectUrl: '' })
assert.deepStrictEqual(parseQQQrStatus("ptuiCB('65','0','','0','二维码已失效。','')"), { code: '65', redirectUrl: '' })

const runStatus = async(code, expectedState) => {
  const queue = [
    response({ setCookie: ['qrsig=qr-value; Path=/'] }),
    response({ text: `ptuiCB('${code}','0','','0','status','')` }),
  ]
  const service = createQQMusicLoginService({
    fetchImpl: async() => queue.shift(),
    sessions: createQrSessionStore({ idFactory: () => `status-${code}` }),
  })
  const qr = await service.createLoginQr()
  const result = await service.checkLoginQr(qr.key)
  assert.strictEqual(result.state, expectedState)
  assert.strictEqual(Object.hasOwn(result, 'cookie'), false)
}

Promise.resolve().then(async() => {
  await runStatus('66', 'waiting')
  await runStatus('67', 'scanned')
  await runStatus('65', 'expired')

  const calls = []
  const queue = [
    response({ setCookie: ['qrsig=qr-success; Path=/'] }),
    response({
      text: "ptuiCB('0','0','https://graph.qq.com/check-sig','0','登录成功！','')",
      setCookie: ['uin=o123; Path=/'],
    }),
    response({ setCookie: ['p_skey=p-value; Path=/'] }),
    response({ location: 'https://y.qq.com/portal/wx_redirect.html?code=oauth-code' }),
    response({ setCookie: ['qqmusic_key=music=value; Path=/', 'qqmusic_uin=123; Path=/'] }),
  ]
  const service = createQQMusicLoginService({
    fetchImpl: async(url, options) => {
      calls.push({ url: String(url), options })
      return queue.shift()
    },
    sessions: createQrSessionStore({ idFactory: () => 'success-session' }),
  })
  const qr = await service.createLoginQr()
  assert.deepStrictEqual(Object.keys(qr).sort(), ['key', 'qrimg'])
  const result = await service.checkLoginQr(qr.key)
  assert.deepStrictEqual(result, {
    state: 'success',
    message: '登录成功',
    cookie: 'uin=o123; p_skey=p-value; qqmusic_key=music=value; qqmusic_uin=123',
  })
  assert.match(calls[3].options.body.get('g_tk'), /^\d+$/)
  assert.match(calls[4].options.body, /QQConnectLogin\.LoginServer/)
  console.log('QQ Music login tests passed')
}).catch(err => {
  console.error(err)
  process.exitCode = 1
})
```

The internal success result contains the Cookie because it never crosses IPC; Task 3's account facade removes it before returning `LX.QQMusic.LoginQrCheck`.

- [ ] **Step 3: Run both tests and verify failure**

Run:

```powershell
node scripts/test-qq-music-login.js
node scripts/test-qq-music-account.js
```

Expected: both FAIL because the login service and account facade do not exist.

- [ ] **Step 4: Implement `login.ts` from the reviewed MIT reference**

Create `src/main/modules/qqMusic/login.ts` with a source comment naming the upstream repository and commit. Inject `fetchImpl`, session storage, and `onLogin` for tests. Public shape:

```ts
type InternalLoginCheck =
  | { state: 'waiting' | 'scanned' | 'expired', message: string }
  | { state: 'success', message: string, cookie: string }

export const createQQMusicLoginService = ({
  fetchImpl = fetch,
  sessions = createQrSessionStore(),
}: {
  fetchImpl?: typeof fetch
  sessions?: QQQrSessionStore
} = {}) => {
  const createLoginQr = async(): Promise<LX.QQMusic.LoginQr> => {
    const response = await fetchWithTimeout(QR_URL)
    if (!response.ok) throw new Error('QQ Music login QR request failed')
    const qrsig = /qrsig=([^;]+)/.exec(getSetCookieValues(response.headers).join('; '))?.[1]
    if (!qrsig) throw new Error('QQ Music login QR response is invalid')
    const key = sessions.create({ qrsig, ptqrtoken: hash33(qrsig) })
    const image = Buffer.from(await response.arrayBuffer()).toString('base64')
    return { key, qrimg: `data:image/png;base64,${image}` }
  }

  const checkLoginQr = async(key: string): Promise<InternalLoginCheck> => {
    const session = sessions.get(key)
    if (!session) return { state: 'expired', message: '二维码已过期' }
    const result = await fetchQQQrStatus(fetchImpl, session)
    if (result.code == '66') return { state: 'waiting', message: '等待扫码' }
    if (result.code == '67') return { state: 'scanned', message: '等待手机确认' }
    if (result.code == '65') {
      sessions.delete(key)
      return { state: 'expired', message: '二维码已过期' }
    }
    if (result.code != '0' || !result.redirectUrl) throw new Error('QQ Music login check failed')
    const cookie = await completeQQMusicOAuth(fetchImpl, result.response, result.redirectUrl)
    sessions.delete(key)
    return { state: 'success', message: '登录成功', cookie }
  }

  return { createLoginQr, checkLoginQr }
}
```

Define `QR_URL`, `fetchWithTimeout`, `fetchQQQrStatus`, and `completeQQMusicOAuth` in the same file before the factory. Export `parseQQQrStatus` for the pure parser test. It parses the first `ptuiCB` argument as `code` and the third argument as `redirectUrl`. `fetchQQQrStatus` returns the response too, so its `Set-Cookie` values enter the OAuth Cookie map.

Implement `checkLoginQr` as this exact state sequence:

```text
ptqrlogin code 66 -> waiting
ptqrlogin code 67 -> scanned
ptqrlogin code 65 or missing local session -> expired
ptqrlogin code 0 -> fetch check-sig redirect -> obtain p_skey
-> POST graph.qq.com/oauth2.0/authorize with g_tk
-> parse code from Location
-> POST QQConnectLogin.LoginServer/QQLogin to musicu.fcg
-> merge every Set-Cookie value by name
-> success with final Cookie
```

Use the exact form fields from the reference implementation: `client_id=100497308`, the QQ Music `redirect_uri`, scopes `get_user_info,get_app_friends`, and `g_tk=getGtk(p_skey)`. Every network call uses a 10-second abort timeout and manual redirects where the code needs `Location`. Delete the QR session on success, expiry, or terminal error. Never include upstream URLs or Cookie values in thrown messages.

- [ ] **Step 5: Add account storage and facade**

Add `qqMusicAccount: 'qqMusicAccount'` to `DATA_KEYS` in `src/common/constants.ts`.

Create `src/main/modules/qqMusic/index.ts` with a testable factory and singleton wrappers:

```ts
interface QQMusicAccountData {
  cookie: string
  profile: LX.QQMusic.Profile | null
  updatedAt: number
}

const emptyAccount = (): QQMusicAccountData => ({ cookie: '', profile: null, updatedAt: 0 })

export const createQQMusicAccountService = ({ store, loginService, songService, now = Date.now }) => {
  const read = () => store.get(DATA_KEYS.qqMusicAccount) ?? emptyAccount()
  const write = (value: QQMusicAccountData) => store.set(DATA_KEYS.qqMusicAccount, value)

  return {
    getAccountStatus: async() => {
      const account = read()
      return { isLoggedIn: !!account.cookie, profile: account.cookie ? account.profile : null }
    },
    createLoginQr: loginService.createLoginQr,
    checkLoginQr: async(key: string) => {
      const result = await loginService.checkLoginQr(key)
      if (result.state != 'success') return { ...result, isLoggedIn: false, profile: null }
      const uin = getCookieValue(result.cookie, 'uin') || getCookieValue(result.cookie, 'qqmusic_uin')
      const profile = { uin, nickname: 'QQ 音乐账号' }
      write({ cookie: result.cookie, profile, updatedAt: now() })
      return { state: 'success', message: result.message, isLoggedIn: true, profile }
    },
    logout: async() => write({ ...emptyAccount(), updatedAt: now() }),
    getGuessLikeSongs: async() => {
      try {
        return await songService.getGuessLikeSongs()
      } catch (error) {
        if (isQQMusicAuthError(error)) write({ ...emptyAccount(), updatedAt: now() })
        throw error
      }
    },
  }
}
```

Instantiate the singleton with `getStore(STORE_NAMES.DATA)`, the real login service, and a song service whose `getCookie` callback reads the account record. Export the five functions specified by the design.

- [ ] **Step 6: Run auth, login, song, and account tests**

```powershell
node scripts/test-qq-music-auth.js
node scripts/test-qq-music-login.js
node scripts/test-qq-music-song.js
node scripts/test-qq-music-account.js
```

Expected: all four scripts print their PASS message.

- [ ] **Step 7: Commit safe files only**

`src/common/constants.ts` was clean at planning time, but recheck. If still clean, stage it with the new files. Otherwise stage only the new files and defer its hunk.

```powershell
git add -- scripts/test-qq-music-login.js scripts/test-qq-music-account.js src/main/modules/qqMusic/login.ts src/main/modules/qqMusic/index.ts
git diff --cached --check
git commit -m "feat: persist QQ Music login"
```

---

### Task 4: Shared Types, IPC, and Credential Boundary

**Files:**
- Create: `scripts/test-qq-music-ipc.js`
- Create: `src/common/types/qq_music.d.ts`
- Create: `src/main/modules/winMain/rendererEvent/qqMusic.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/main/types/common.d.ts`
- Modify: `src/renderer/types/common.d.ts`
- Modify: `src/main/modules/winMain/rendererEvent/index.ts`
- Modify: `src/renderer/utils/ipc.ts`

- [ ] **Step 1: Write the failing IPC security contract**

Create `scripts/test-qq-music-ipc.js` to read the listed source files and assert:

```js
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

const types = read('src/common/types/qq_music.d.ts')
const names = read('src/common/ipcNames.ts')
const handlers = read('src/main/modules/winMain/rendererEvent/qqMusic.ts')
const handlerIndex = read('src/main/modules/winMain/rendererEvent/index.ts')
const rendererIpc = read('src/renderer/utils/ipc.ts')

for (const name of [
  'qq_music_get_account_status',
  'qq_music_login_qr_create',
  'qq_music_login_qr_check',
  'qq_music_logout',
  'qq_music_get_guess_like_songs',
]) {
  assert.match(names, new RegExp(`${name}: '${name}'`))
  assert.match(handlers, new RegExp(name))
}
assert.match(handlerIndex, /import qqMusic from '.\/qqMusic'/)
assert.match(handlerIndex, /qqMusic\(\)/)
assert.match(rendererIpc, /getQQMusicAccountStatus/)
assert.match(rendererIpc, /createQQMusicLoginQr/)
assert.match(rendererIpc, /checkQQMusicLoginQr/)
assert.match(rendererIpc, /logoutQQMusic/)
assert.match(rendererIpc, /getQQMusicGuessLikeSongs/)

const publicTypeBodies = [...types.matchAll(/interface (?:Profile|AccountStatus|LoginQr|LoginQrCheck)\s*\{([\s\S]*?)\n\s*\}/g)]
  .map(match => match[1]).join('\n')
assert.doesNotMatch(publicTypeBodies, /\b(cookie|qrsig|ptqrtoken|code)\s*:/i)

console.log('QQ Music IPC security tests passed')
```

- [ ] **Step 2: Run the test and verify failure**

Run `node scripts/test-qq-music-ipc.js`.

Expected: FAIL because the shared type and handler files are missing.

- [ ] **Step 3: Add safe shared types**

Create `src/common/types/qq_music.d.ts`:

```ts
declare namespace LX {
  namespace QQMusic {
    interface Profile {
      uin: string
      nickname: string
    }

    interface AccountStatus {
      isLoggedIn: boolean
      profile: Profile | null
    }

    interface LoginQr {
      key: string
      qrimg: string
    }

    type LoginQrState = 'waiting' | 'scanned' | 'expired' | 'success'

    interface LoginQrCheck extends AccountStatus {
      state: LoginQrState
      message: string
    }
  }
}
```

Import this declaration from both environment type entry files.

- [ ] **Step 4: Add IPC names, handlers, and renderer wrappers**

Register all five names. Create `qqMusic.ts` handlers that call only the five safe facade operations. Add renderer wrappers with exact return types:

```ts
export const getQQMusicAccountStatus = async() =>
  rendererInvoke<LX.QQMusic.AccountStatus>(WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_account_status)

export const createQQMusicLoginQr = async() =>
  rendererInvoke<LX.QQMusic.LoginQr>(WIN_MAIN_RENDERER_EVENT_NAME.qq_music_login_qr_create)

export const checkQQMusicLoginQr = async(key: string) =>
  rendererInvoke<string, LX.QQMusic.LoginQrCheck>(WIN_MAIN_RENDERER_EVENT_NAME.qq_music_login_qr_check, key)

export const logoutQQMusic = async() =>
  rendererInvoke(WIN_MAIN_RENDERER_EVENT_NAME.qq_music_logout)

export const getQQMusicGuessLikeSongs = async() =>
  rendererInvoke<LX.Music.MusicInfo_tx[]>(WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_guess_like_songs)
```

Register `qqMusic()` immediately after `netease()` or beside it in the main handler index. Preserve the existing dirty `localMusic()` registration.

- [ ] **Step 5: Run the IPC security contract**

Run `node scripts/test-qq-music-ipc.js`.

Expected: `QQ Music IPC security tests passed`.

- [ ] **Step 6: Build the Electron main bundle**

Run:

```powershell
npm run build:main
```

Expected: webpack exits 0 with no TypeScript or ESLint errors in QQ files.

- [ ] **Step 7: Commit only isolated QQ IPC work**

Several existing IPC/type index files were dirty at planning time. Stage the two new files first; stage existing-file hunks only if isolated.

```powershell
git add -- scripts/test-qq-music-ipc.js src/common/types/qq_music.d.ts src/main/modules/winMain/rendererEvent/qqMusic.ts
git diff --cached --check
git commit -m "feat: expose safe QQ Music IPC"
```

---

### Task 5: Renderer Account Store and QQ Login Polling

**Files:**
- Create: `scripts/test-qq-music-renderer-account.js`
- Create: `src/renderer/store/qqMusic.ts`
- Create: `src/renderer/views/Recommend/useQQMusicLoginQr.ts`
- Modify: `src/renderer/views/Recommend/components/LoginPanel.vue`

- [ ] **Step 1: Write the failing renderer store test**

Create `scripts/test-qq-music-renderer-account.js` using minimal Vue ref mocks:

```js
const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const ref = value => ({ value })
const computed = getter => ({ get value() { return getter() } })
let getCount = 0
let logoutCount = 0

const store = loadTsModule(path.join(__dirname, '../src/renderer/store/qqMusic.ts'), {
  '@common/utils/vueTools': { ref, shallowRef: ref, computed },
  '@renderer/utils/ipc': {
    getQQMusicAccountStatus: async() => {
      getCount++
      return { isLoggedIn: true, profile: { uin: 'o123', nickname: 'QQ 音乐账号' } }
    },
    logoutQQMusic: async() => { logoutCount++ },
  },
})

Promise.all([store.initQQMusicAccount(), store.initQQMusicAccount()]).then(async() => {
  assert.strictEqual(getCount, 1)
  assert.strictEqual(store.isLoggedIn.value, true)
  assert.strictEqual(store.profile.value.uin, 'o123')
  await store.logoutQQMusicAccount()
  assert.strictEqual(logoutCount, 1)
  assert.strictEqual(store.isLoggedIn.value, false)
  console.log('QQ Music renderer account tests passed')
}).catch(err => {
  console.error(err)
  process.exitCode = 1
})
```

- [ ] **Step 2: Run the test and verify failure**

Run `node scripts/test-qq-music-renderer-account.js`.

Expected: FAIL because the renderer store is missing.

- [ ] **Step 3: Implement the renderer store**

Mirror `src/renderer/store/netease.ts` exactly with QQ types and QQ IPC wrappers. Preserve the same single-flight initialization behavior, force refresh option, safe empty status, and state update after logout.

- [ ] **Step 4: Implement QQ QR polling**

Create `useQQMusicLoginQr.ts` with the same lifecycle surface as `useNeteaseLoginQr`, but map string states:

```ts
const statusText = {
  waiting: '请使用手机 QQ 扫码登录',
  scanned: '已扫码，请在手机上确认登录',
  expired: '二维码已过期，请重新获取',
  success: '登录成功',
}
```

Poll every 2000 ms only for `waiting` and `scanned`. On success, call `setQQMusicAccountStatus(status)` and await the injected success callback. On close, expiry, success, or component disposal, clear the timer. `handleShowLogin` reuses a still-valid QR image; otherwise it creates a new one.

- [ ] **Step 5: Generalize the login panel text**

Add required `title` and `instruction` props to `LoginPanel.vue`. Replace hardcoded `<h3>登录</h3>` with `title`. Render `instruction` as the stable scanner instruction and render `qrStatusText` in a separate status line. Existing callers must supply NetEase text; the QQ caller supplies `登录 QQ 音乐` and `请使用手机 QQ 扫码，并在手机上确认`.

- [ ] **Step 6: Run the renderer store test**

Run `node scripts/test-qq-music-renderer-account.js`.

Expected: `QQ Music renderer account tests passed`.

- [ ] **Step 7: Commit new renderer units**

```powershell
git add -- scripts/test-qq-music-renderer-account.js src/renderer/store/qqMusic.ts src/renderer/views/Recommend/useQQMusicLoginQr.ts
git diff --cached --check
git commit -m "feat: manage QQ Music renderer login state"
```

---

### Task 6: Two-Provider Avatar Account Menu

**Files:**
- Create: `scripts/test-qq-music-ui-wiring.js`
- Modify: `src/renderer/components/layout/Aside/index.vue`

- [ ] **Step 1: Add failing account-menu assertions**

Start `scripts/test-qq-music-ui-wiring.js` with:

```js
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

const aside = read('src/renderer/components/layout/Aside/index.vue')
assert.match(aside, /initQQMusicAccount/)
assert.match(aside, /logoutQQMusicAccount/)
assert.match(aside, />QQ 音乐</)
assert.match(aside, />网易云音乐</)
assert.match(aside, /login:\s*'qq'/)
assert.match(aside, /login:\s*'netease'/)
assert.match(aside, /logoProfile.*neteaseProfile/s)

console.log('QQ Music UI wiring tests passed')
```

- [ ] **Step 2: Run the test and verify failure**

Run `node scripts/test-qq-music-ui-wiring.js`.

Expected: FAIL on missing QQ account menu wiring.

- [ ] **Step 3: Replace the single action with provider rows**

In `Aside/index.vue`:

- retain the current avatar button and NetEase-avatar fallback computation;
- import QQ profile/status/init/logout under explicit aliases;
- initialize QQ and NetEase in parallel on mount;
- render two `.providerRow` blocks with provider marker, provider name, account label, and login/logout button;
- close the popover before every action;
- on login, dispatch the existing provider event only when already on the recommendation route, then navigate to `/recommend` with `login: 'qq'` or `login: 'netease'`;
- on logout, call only the selected provider store action.

Increase the popover width to approximately 238px while preserving 8px radius, current theme variables, outside-click close, and no-drag behavior. Use stable row dimensions so status text cannot resize the popover.

- [ ] **Step 4: Run the UI wiring test**

Run `node scripts/test-qq-music-ui-wiring.js`.

Expected: `QQ Music UI wiring tests passed`.

- [ ] **Step 5: Commit if the file was clean at task start**

```powershell
git add -- scripts/test-qq-music-ui-wiring.js src/renderer/components/layout/Aside/index.vue
git diff --cached --check
git commit -m "feat: add QQ Music account menu"
```

---

### Task 7: Logged-Out Visibility Setting and Locales

**Files:**
- Modify: `scripts/test-qq-music-ui-wiring.js`
- Modify: `src/common/defaultSetting.ts`
- Modify: `src/common/types/app_setting.d.ts`
- Modify: `src/renderer/views/Setting/components/SettingRecommend.vue`
- Modify: `src/lang/zh-cn.json`
- Modify: `src/lang/zh-tw.json`
- Modify: `src/lang/en-us.json`

- [ ] **Step 1: Add failing setting assertions**

Extend the UI wiring test to assert:

```js
const defaultSetting = read('src/common/defaultSetting.ts')
const settingTypes = read('src/common/types/app_setting.d.ts')
const settingView = read('src/renderer/views/Setting/components/SettingRecommend.vue')
const zhCN = JSON.parse(read('src/lang/zh-cn.json'))
const zhTW = JSON.parse(read('src/lang/zh-tw.json'))
const enUS = JSON.parse(read('src/lang/en-us.json'))

assert.match(defaultSetting, /'recommend\.qqGuessLikeLoggedOutVisible': true/)
assert.match(settingTypes, /'recommend\.qqGuessLikeLoggedOutVisible': boolean/)
assert.match(settingView, /setting_recommend_qq_guess_like_logged_out_visible/)
assert.match(settingView, /recommend\.qqGuessLikeLoggedOutVisible/)
assert.strictEqual(zhCN.setting__recommend_qq_guess_like_logged_out_visible, '未登录 QQ 音乐时显示“猜你喜欢”登录入口')
assert.strictEqual(zhTW.setting__recommend_qq_guess_like_logged_out_visible, '未登入 QQ 音樂時顯示「猜你喜歡」登入入口')
assert.strictEqual(enUS.setting__recommend_qq_guess_like_logged_out_visible, 'Show the Guess You Like login entry when QQ Music is signed out')
```

- [ ] **Step 2: Run the test and verify failure**

Run `node scripts/test-qq-music-ui-wiring.js`.

Expected: FAIL on the missing setting default.

- [ ] **Step 3: Add the setting contract and UI**

Add the boolean default and type. Add this Pug block before the section-order controls:

```pug
dd
  base-checkbox(
    id="setting_recommend_qq_guess_like_logged_out_visible"
    :model-value="appSetting['recommend.qqGuessLikeLoggedOutVisible']"
    :label="$t('setting__recommend_qq_guess_like_logged_out_visible')"
    @update:model-value="updateSetting({ 'recommend.qqGuessLikeLoggedOutVisible': $event })")
```

Return `appSetting` and `updateSetting` from `SettingRecommend.setup()` because the template must access them.

- [ ] **Step 4: Add all three translations**

Use the exact strings from the assertions. Preserve valid JSON and neighboring user changes.

- [ ] **Step 5: Run the setting wiring test**

Run `node scripts/test-qq-music-ui-wiring.js`.

Expected: `QQ Music UI wiring tests passed`.

- [ ] **Step 6: Commit only isolatable hunks**

`SettingRecommend.vue` was clean at planning time; the defaults, types, and locale files were already dirty. Stage only safe hunks. Do not stage whole locale files without reviewing cached diff.

---

### Task 8: QQ Recommendation Data and Section States

**Files:**
- Create: `src/renderer/views/Recommend/useQQGuessLikeData.ts`
- Create: `src/renderer/views/Recommend/components/QQGuessLikeSection.vue`
- Modify: `scripts/test-qq-music-ui-wiring.js`

- [ ] **Step 1: Add failing recommendation-unit assertions**

Extend the wiring test to require the new files and state contracts:

```js
const qqData = read('src/renderer/views/Recommend/useQQGuessLikeData.ts')
const qqSection = read('src/renderer/views/Recommend/components/QQGuessLikeSection.vue')
assert.match(qqData, /getQQMusicGuessLikeSongs/)
assert.match(qqData, /initQQMusicAccount\(true\)/)
assert.match(qqData, /recommendCache/)
assert.match(qqSection, /登录 QQ 音乐后获取猜你喜欢/)
assert.match(qqSection, /SimilarSongsSection/)
assert.match(qqSection, /@click="\$emit\('login'\)"/)
```

- [ ] **Step 2: Run the test and verify failure**

Run `node scripts/test-qq-music-ui-wiring.js`.

Expected: FAIL because `useQQGuessLikeData.ts` is missing.

- [ ] **Step 3: Implement account-keyed recommendation state**

Create `useQQGuessLikeData.ts` with a module-level cache:

```ts
const recommendCache = new Map<string, LX.Music.MusicInfo_tx[]>()
```

Expose `songs`, `isLoading`, `isRefreshing`, `loadError`, `load(force = false)`, and `clear()`. Use `profile.value?.uin` as the key. Rules:

- logged out: clear visible songs and return;
- cached and not forced: use cache without IPC;
- initial request sets `isLoading`; forced request sets `isRefreshing`;
- success replaces cache and visible songs, including a successful empty list;
- failure keeps current songs, sets a safe Chinese error, and calls `initQQMusicAccount(true)` so a main-process auth clear reaches renderer state;
- `clear()` removes the active account's cache and visible state.

- [ ] **Step 4: Implement the section component**

`QQGuessLikeSection.vue` receives `visibleWhenLoggedOut`, account state, song state, and playback/favorite callbacks.

Render exactly one of:

1. nothing when logged out and the setting is false;
2. an unframed compact section with the login command when logged out and visible;
3. loading text when logged in with no songs;
4. retryable error or empty state when logged in with no songs;
5. `SimilarSongsSection` with title `猜你喜欢`, QQ source description, refresh, play-all, play-one, and local-favorite events.

Do not nest decorative cards. Reuse current section typography, spacing, and theme variables.

- [ ] **Step 5: Run the UI wiring test**

Run `node scripts/test-qq-music-ui-wiring.js`.

Expected: PASS.

- [ ] **Step 6: Commit new recommendation units**

```powershell
git add -- src/renderer/views/Recommend/useQQGuessLikeData.ts src/renderer/views/Recommend/components/QQGuessLikeSection.vue
git diff --cached --check
git commit -m "feat: add QQ Music recommendation state"
```

---

### Task 9: Recommendation Page, Login Routing, Playback, and Favorites

**Files:**
- Modify: `scripts/test-qq-music-ui-wiring.js`
- Modify: `src/renderer/views/Recommend/constants.ts`
- Modify: `src/renderer/views/Recommend/useRecommendPlayback.ts`
- Modify: `src/renderer/views/Recommend/index.vue`
- Modify: `src/renderer/views/Recommend/components/LoginPanel.vue`

- [ ] **Step 1: Add failing page-integration assertions**

Extend the wiring test:

```js
const recommend = read('src/renderer/views/Recommend/index.vue')
const playback = read('src/renderer/views/Recommend/useRecommendPlayback.ts')
const constants = read('src/renderer/views/Recommend/constants.ts')
const loginPanel = read('src/renderer/views/Recommend/components/LoginPanel.vue')

assert.match(constants, /QQ_GUESS_LIKE_TEMP_LIST_ID = 'tx__qq_guess_like'/)
assert.match(playback, /qqGuessLikeSongs/)
assert.match(playback, /handleToggleQQGuessLikeSongs/)
assert.match(playback, /handlePlayQQGuessLikeSongs/)
assert.match(recommend, /QQGuessLikeSection/)
assert.match(recommend, /useQQMusicLoginQr/)
assert.match(recommend, /useQQGuessLikeData/)
assert.match(recommend, /recommend\.qqGuessLikeLoggedOutVisible/)
assert.match(recommend, /login == 'qq'/)
assert.match(recommend, /login == 'netease' \|\| login == '1'/)
assert.match(recommend, /delete query\.login/)
assert.match(loginPanel, /title: string/)
assert.match(loginPanel, /instruction: string/)
```

- [ ] **Step 2: Run the test and verify failure**

Run `node scripts/test-qq-music-ui-wiring.js`.

Expected: FAIL on the missing QQ temporary list ID.

- [ ] **Step 3: Extend generic song-section playback**

Add `QQ_GUESS_LIKE_TEMP_LIST_ID = 'tx__qq_guess_like'`.

Add `qqGuessLikeSongs` to `useRecommendPlayback` inputs. Reuse the existing private helpers instead of duplicating player logic:

```ts
const isQQGuessLikePlayingList = () => isSongSectionPlayingList(QQ_GUESS_LIKE_TEMP_LIST_ID)
const isQQGuessLikePlaying = () => isQQGuessLikePlayingList() && isPlay.value
const isQQGuessLikeSongPlaying = (song: LX.Music.MusicInfoOnline) =>
  isSongSectionSongPlaying(QQ_GUESS_LIKE_TEMP_LIST_ID, song)
const handleToggleQQGuessLikeSongs = async() =>
  handleToggleSongSection(QQ_GUESS_LIKE_TEMP_LIST_ID, qqGuessLikeSongs)
const handlePlayQQGuessLikeSongs = async(index = 0) =>
  handlePlaySongSection(QQ_GUESS_LIKE_TEMP_LIST_ID, qqGuessLikeSongs, index)
```

Return these functions with the existing playback API.

- [ ] **Step 4: Wire QQ login and recommendation into `Recommend/index.vue`**

Add the QQ store, QR composable, data composable, and component. Render `QQGuessLikeSection` immediately after `SpecialCards` and before the NetEase `homeSectionOrder` loop.

Include QQ songs in `recommendSongsForLove` so the existing source-neutral favorite actions work.

Initialize QQ and NetEase account state independently. After QQ login success, force-load QQ recommendations. Watch QQ login state: login loads, logout clears.

Update `effectivePlaylistNoItemText` so a visible QQ logged-out prompt, QQ loading/error state, or QQ songs keep the home flow rendered even when NetEase has no content.

Render provider-specific `LoginPanel` instances with explicit title/instruction props. Ensure only one provider panel can be open at once.

- [ ] **Step 5: Consume provider login queries safely**

Replace the numeric-only watcher with:

```ts
watch(() => route.query.login, login => {
  if (login == 'qq' && !qqIsLoggedIn.value) handleShowQQLogin()
  if ((login == 'netease' || login == '1') && !neteaseIsLoggedIn.value) handleShowNeteaseLogin()
  if (login == null) return
  const query = { ...route.query }
  delete query.login
  void router.replace({ path: route.path, query }).catch(_ => _)
}, { immediate: true })
```

Keep provider window-event listeners only as immediate same-view helpers; the consumed route query is the navigation-safe path.

- [ ] **Step 6: Run focused renderer contracts**

```powershell
node scripts/test-qq-music-renderer-account.js
node scripts/test-qq-music-ui-wiring.js
```

Expected: both PASS.

- [ ] **Step 7: Build the renderer**

Run:

```powershell
npm run build:renderer
```

Expected: webpack exits 0 and produces no Vue, TypeScript, or ESLint errors in touched files.

- [ ] **Step 8: Commit only verified task hunks**

These files were clean at planning time except unrelated surrounding work may have changed since. Review cached diff before committing.

```powershell
git diff --cached --check
git commit -m "feat: show QQ Music guess-like recommendations"
```

---

### Task 10: Full Regression, Security Audit, and Manual Acceptance

**Files:**
- No planned file changes. Any verification failure returns to the owning task after invoking `superpowers:systematic-debugging`.

- [ ] **Step 1: Run every QQ focused test**

```powershell
node scripts/test-qq-music-auth.js
node scripts/test-qq-music-login.js
node scripts/test-qq-music-song.js
node scripts/test-qq-music-account.js
node scripts/test-qq-music-ipc.js
node scripts/test-qq-music-renderer-account.js
node scripts/test-qq-music-ui-wiring.js
```

Expected: seven PASS messages and exit code 0.

- [ ] **Step 2: Run overlapping repository regressions**

```powershell
node scripts/test-electron-security-boundaries.js
node scripts/test-store-validation.js
node scripts/test-safe-array-removal.js
```

Expected: all existing scripts pass. If a script fails, invoke `superpowers:systematic-debugging` before changing code.

- [ ] **Step 3: Run TypeScript, lint, and production bundles**

```powershell
npx tsc --noEmit
npx eslint --ext .ts,.js,.vue -f node_modules/eslint-formatter-friendly src/main/modules/qqMusic src/main/modules/winMain/rendererEvent/qqMusic.ts src/renderer/store/qqMusic.ts src/renderer/views/Recommend src/renderer/components/layout/Aside/index.vue src/renderer/views/Setting/components/SettingRecommend.vue
npm run build:main
npm run build:renderer
```

Expected: all commands exit 0. If global `tsc` reports pre-existing errors outside touched files, record them separately and prove the focused bundles still pass.

- [ ] **Step 4: Audit credential containment**

```powershell
rg -n -S "cookie|qrsig|ptqrtoken|oauth" src/renderer/store/qqMusic.ts src/renderer/views/Recommend src/renderer/components/layout/Aside/index.vue src/common/types/qq_music.d.ts
```

Expected: no credential fields or values in renderer state/types. Benign instructional comments must not include live values.

Inspect main-process logging paths and confirm all messages pass through safe constant strings or `redactQQMusicSecret`.

- [ ] **Step 5: Start the Electron development app**

Run:

```powershell
npm run dev
```

Keep the dev process running and provide its local app state to the user for manual QR acceptance.

- [ ] **Step 6: Manually verify UI and account lifecycle**

In the running app:

1. Click the top-left avatar and verify two independent provider rows.
2. Confirm the NetEase avatar still controls the top-level avatar when available.
3. Open QQ login and verify waiting, scanned, confirmed, success, expiry, close, and refresh states.
4. Scan with the user's mobile QQ account.
5. Confirm "猜你喜欢" loads account-specific radio ID 99 songs.
6. Play one song, play all, pause, refresh, and toggle local favorites.
7. Close and reopen the app; confirm QQ and NetEase states persist independently.
8. Explicitly log out of QQ; confirm only QQ state and songs clear.
9. Toggle the recommendation setting and verify both logged-out display branches.
10. Disconnect the network during refresh; confirm prior songs remain and NetEase content is unaffected.

- [ ] **Step 7: Verify packaged license inclusion**

Run a directory package only if focused builds and manual login pass:

```powershell
npm run pack:dir
```

Expected: the packaged resources contain `licenses/qq-music-api-MIT.txt`, because `build-config/build-pack.js` already includes the whole `licenses` directory as `extraResources`.

- [ ] **Step 8: Final diff review**

```powershell
git status --short
git diff --check
git diff --stat
git diff --cached --name-only
```

Confirm no existing user change was reverted or accidentally staged. Summarize any uncommitted QQ hunks that were intentionally left unstaged because they share dirty files.

- [ ] **Step 9: Final feature checkpoint**

Only after verification, commit isolatable remaining QQ changes with a precise message. Do not use `git add -A` or `git add .` in this dirty worktree.
