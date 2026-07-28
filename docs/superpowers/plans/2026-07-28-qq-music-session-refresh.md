# QQ Music Session Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep QQ Music credentials refreshed, retry one authenticated request after a successful refresh, and stop ambiguous recommendation errors from deleting a valid account.

**Architecture:** Add a focused main-process credential client that accepts a Cookie and returns a fully merged Cookie or a typed sanitized failure. Extend the account service with snapshot-guarded single-flight refresh coordination, then add a 20-hour unrefed renewal timer and one-hour transient backoff without changing renderer or IPC contracts.

**Tech Stack:** TypeScript, Electron main process, Node `fetch`, existing account store, Node assertion scripts, ESLint, webpack main-process build

**Design:** `docs/superpowers/specs/2026-07-28-qq-music-session-refresh-design.md`

---

## File Map

- Create `src/main/modules/qqMusic/credential.ts`
  - Build the private QQ Music login refresh request.
  - Classify sanitized `invalid`, `unavailable`, and `transient` failures.
  - Merge rotated credentials into the original Cookie.
  - Calculate the 20-hour renewal deadline.
- Modify `src/main/modules/qqMusic/auth.ts`
  - Add a Cookie-overlay helper that preserves unrelated pairs.
- Modify `src/main/modules/qqMusic/index.ts`
  - Own single-flight refresh, snapshot checks, persistence, retry, proactive
    scheduling, and confirmed-invalid logout.
- Modify `scripts/test-qq-music-auth.js`
  - Cover deterministic Cookie overlay behavior.
- Create `scripts/test-qq-music-credential.js`
  - Cover request shape, response rotation, deadlines, and error
    classification without network access.
- Create `scripts/test-qq-music-account-refresh.js`
  - Cover refresh/retry, concurrent callers, stale results, timer behavior, and
    backoff.
- Modify `scripts/test-qq-music-account.js`
  - Replace the old "any auth error clears the account" assertions with the
    new confirmed-refresh-invalid policy.

No renderer, IPC, login-window, recommendation-service, or store-schema file
changes are required.

---

### Task 1: Cookie Overlay Helper

**Files:**
- Modify: `scripts/test-qq-music-auth.js`
- Modify: `src/main/modules/qqMusic/auth.ts`

- [ ] **Step 1: Write the failing Cookie overlay tests**

Add `mergeCookieUpdates` to the destructuring assignment in
`scripts/test-qq-music-auth.js`, then add these assertions after the existing
`mergeCookieValues` assertions:

```js
assert.strictEqual(
  mergeCookieUpdates(
    'uin=o123; qqmusic_key=old=value; keep=unchanged; malformed',
    {
      qqmusic_key: 'new=value=with=equals',
      qm_keyst: 'new=value=with=equals',
      empty: '',
      zero: 0,
      missing: undefined,
    },
  ),
  'uin=o123; qqmusic_key=new=value=with=equals; keep=unchanged; qm_keyst=new=value=with=equals',
)
assert.strictEqual(
  mergeCookieUpdates('duplicate=old; duplicate=latest; keep=yes', {
    duplicate: 'rotated',
  }),
  'duplicate=rotated; keep=yes',
)
assert.strictEqual(
  mergeCookieUpdates('uin=o123; keep=yes', {}),
  'uin=o123; keep=yes',
)
assert.strictEqual(
  mergeCookieUpdates(
    'psrf_qqaccess_token=access-old; psrf_qqrefresh_token=refresh-old; qqmusic_key=key-old',
    {
      psrf_qqaccess_token: '',
      psrf_qqrefresh_token: 0,
      qqmusic_key: null,
    },
  ),
  'psrf_qqaccess_token=access-old; psrf_qqrefresh_token=refresh-old; qqmusic_key=key-old',
)
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```powershell
node scripts/test-qq-music-auth.js
```

Expected: FAIL because `mergeCookieUpdates` is undefined.

- [ ] **Step 3: Implement the minimal Cookie overlay**

Add this export after `mergeCookieValues` in
`src/main/modules/qqMusic/auth.ts`:

```ts
type CookieUpdateValue = string | number | null | undefined

export const mergeCookieUpdates = (
  cookie: string,
  updates: Record<string, CookieUpdateValue>,
): string => {
  const cookies = new Map<string, string>()
  for (const item of cookie.split(';')) {
    const pair = getCookiePair(item)
    if (pair) cookies.set(pair.name, pair.value)
  }
  for (const [name, rawValue] of Object.entries(updates)) {
    const value = String(rawValue ?? '').trim()
    if (!name || !value || value == '0') continue
    cookies.set(name, value)
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}
```

This helper deliberately ignores empty and zero-like response values so a
partial QQ response cannot erase a usable stored credential.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run:

```powershell
node scripts/test-qq-music-auth.js
```

Expected: `QQ Music auth tests passed`.

Run:

```powershell
node scripts/test-qq-music-browser-auth.js
```

Expected: `QQ Music browser auth helper tests passed`.

- [ ] **Step 5: Commit the Cookie helper**

Run:

```powershell
git add -- src/main/modules/qqMusic/auth.ts scripts/test-qq-music-auth.js
git commit -m "feat: add QQ Music cookie credential overlay"
```

Expected: one commit containing only the helper and its tests.

---

### Task 2: Credential Refresh Client

**Files:**
- Create: `scripts/test-qq-music-credential.js`
- Create: `src/main/modules/qqMusic/credential.ts`

- [ ] **Step 1: Write the failing credential-client test**

Create `scripts/test-qq-music-credential.js` with this structure:

```js
const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const auth = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'),
)
const requestHelpers = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/request.ts'),
)
const credential = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/credential.ts'),
  {
    './auth': auth,
    './request': requestHelpers,
  },
)

const {
  createQQMusicCredentialService,
  getQQMusicCredentialRefreshDueAt,
  isQQMusicCredentialRefreshError,
} = credential

const baseCookie = [
  'uin=o123',
  'qqmusic_key=old-key',
  'qm_keyst=old-key',
  'psrf_qqopenid=openid-old',
  'psrf_qqunionid=union-old',
  'psrf_qqaccess_token=access-old',
  'psrf_qqrefresh_token=refresh-old',
  'psrf_access_token_expiresAt=12345',
  'psrf_musickey_createtime=100',
  'euin=encrypted-old',
  'refresh_key=refresh-key-old',
  'keep=value=with=equals',
].join('; ')

const response = payload => ({
  ok: true,
  status: 200,
  json: async() => payload,
})

const expectRefreshError = async(promise, kind) => {
  await assert.rejects(promise, error => {
    assert.strictEqual(isQQMusicCredentialRefreshError(error), true)
    assert.strictEqual(error.kind, kind)
    assert.doesNotMatch(String(error), /access-old|refresh-old|secret-upstream/)
    return true
  })
}

const main = async() => {
  let captured
  const service = createQQMusicCredentialService({
    fetchImpl: async(url, options) => {
      captured = { url: String(url), options }
      return response({
        code: 0,
        req_0: {
          code: 0,
          data: {
            openid: 'openid-new',
            unionid: 'union-new',
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            musickey: 'music=new=value',
            musickeyCreateTime: 200,
            expired_at: 54321,
            encryptUin: 'encrypted-new',
            refresh_key: 'refresh-key-new',
            login_type: 1,
            loginType: 2,
            musicid: 123,
          },
        },
      })
    },
  })

  const refreshed = await service.refresh(baseCookie)
  assert.strictEqual(
    captured.url,
    'https://u.y.qq.com/cgi-bin/musicu.fcg',
  )
  assert.strictEqual(captured.options.method, 'POST')
  assert.strictEqual(captured.options.headers.Cookie, baseCookie)
  assert.strictEqual(captured.options.headers.Origin, 'https://y.qq.com')
  assert.strictEqual(captured.options.headers.Referer, 'https://y.qq.com/')

  const body = JSON.parse(captured.options.body)
  assert.strictEqual(body.req_0.module, 'music.login.LoginServer')
  assert.strictEqual(body.req_0.method, 'Login')
  assert.strictEqual(body.req_0.param.appid, 100497308)
  assert.strictEqual(body.req_0.param.musicid, 123)
  assert.strictEqual(body.req_0.param.str_musicid, '123')
  assert.strictEqual(body.req_0.param.musickey, 'old-key')
  assert.strictEqual(body.req_0.param.access_token, 'access-old')
  assert.strictEqual(body.req_0.param.refresh_token, 'refresh-old')
  assert.strictEqual(body.req_0.param.openid, 'openid-old')
  assert.strictEqual(body.req_0.param.refresh_key, 'refresh-key-old')
  assert.strictEqual(body.req_0.param.forceRefreshToken, 0)
  assert.strictEqual(body.req_0.param.musickeyCreateTime, 100)
  assert.strictEqual(body.req_0.param.encryptUin, 'encrypted-old')
  assert.strictEqual(body.comm.psrf_qqaccess_token, 'access-old')
  assert.strictEqual(body.comm.psrf_qqopenid, 'openid-old')
  assert.strictEqual(body.comm.psrf_qqunionid, 'union-old')

  assert.strictEqual(auth.getCookieValue(refreshed, 'qqmusic_key'), 'music=new=value')
  assert.strictEqual(auth.getCookieValue(refreshed, 'qm_keyst'), 'music=new=value')
  assert.strictEqual(auth.getCookieValue(refreshed, 'psrf_qqopenid'), 'openid-new')
  assert.strictEqual(auth.getCookieValue(refreshed, 'psrf_qqunionid'), 'union-new')
  assert.strictEqual(auth.getCookieValue(refreshed, 'psrf_qqaccess_token'), 'access-new')
  assert.strictEqual(auth.getCookieValue(refreshed, 'psrf_qqrefresh_token'), 'refresh-new')
  assert.strictEqual(auth.getCookieValue(refreshed, 'psrf_musickey_createtime'), '200')
  assert.strictEqual(auth.getCookieValue(refreshed, 'psrf_access_token_expiresAt'), '54321')
  assert.strictEqual(auth.getCookieValue(refreshed, 'euin'), 'encrypted-new')
  assert.strictEqual(auth.getCookieValue(refreshed, 'refresh_key'), 'refresh-key-new')
  assert.strictEqual(auth.getCookieValue(refreshed, 'login_type'), '1')
  assert.strictEqual(auth.getCookieValue(refreshed, 'tmeLoginType'), '2')
  assert.strictEqual(auth.getCookieValue(refreshed, 'uin'), 'o123')
  assert.strictEqual(auth.getCookieValue(refreshed, 'keep'), 'value=with=equals')

  assert.strictEqual(
    getQQMusicCredentialRefreshDueAt(baseCookie),
    100 * 1000 + 20 * 60 * 60 * 1000,
  )
  assert.strictEqual(getQQMusicCredentialRefreshDueAt(''), null)
  assert.strictEqual(
    getQQMusicCredentialRefreshDueAt('psrf_musickey_createtime=invalid'),
    null,
  )
  assert.strictEqual(
    getQQMusicCredentialRefreshDueAt(
      'uin=o123; qqmusic_key=old; psrf_musickey_createtime=100',
    ),
    null,
  )

  let missingFieldCalls = 0
  const missingFieldService = createQQMusicCredentialService({
    fetchImpl: async() => {
      missingFieldCalls++
      return response({})
    },
  })
  await expectRefreshError(
    missingFieldService.refresh('uin=o123; qqmusic_key=secret-upstream'),
    'unavailable',
  )
  await expectRefreshError(
    missingFieldService.refresh(baseCookie.replace('uin=o123', 'uin=invalid')),
    'unavailable',
  )
  assert.strictEqual(missingFieldCalls, 0)

  for (const code of [1000, 104400, 104401]) {
    const invalidService = createQQMusicCredentialService({
      fetchImpl: async() => response({
        code: 0,
        req_0: { code, data: { message: 'secret-upstream' } },
      }),
    })
    await expectRefreshError(invalidService.refresh(baseCookie), 'invalid')
  }

  const topLevelAmbiguousService = createQQMusicCredentialService({
    fetchImpl: async() => response({
      code: 1000,
      req_0: { code: 0, data: { message: 'secret-upstream' } },
    }),
  })
  await expectRefreshError(
    topLevelAmbiguousService.refresh(baseCookie),
    'transient',
  )

  for (const payload of [
    { code: 104604, req_0: { code: 104604 } },
    { code: 0, req_0: { code: 20279 } },
    { code: 0, req_0: { code: 0, data: {} } },
    {
      code: 0,
      req_0: {
        code: 0,
        data: { musickey: 'new-key', musicid: 999 },
      },
    },
  ]) {
    const transientService = createQQMusicCredentialService({
      fetchImpl: async() => response(payload),
    })
    await expectRefreshError(transientService.refresh(baseCookie), 'transient')
  }

  const httpService = createQQMusicCredentialService({
    fetchImpl: async() => ({ ok: false, status: 429 }),
  })
  await expectRefreshError(httpService.refresh(baseCookie), 'transient')

  const malformedService = createQQMusicCredentialService({
    fetchImpl: async() => ({
      ok: true,
      status: 200,
      json: async() => {
        throw new Error('secret-upstream')
      },
    }),
  })
  await expectRefreshError(malformedService.refresh(baseCookie), 'transient')

  const networkService = createQQMusicCredentialService({
    fetchImpl: async() => {
      throw new Error('secret-upstream')
    },
  })
  await expectRefreshError(networkService.refresh(baseCookie), 'transient')

  const timeoutService = createQQMusicCredentialService({
    timeoutMs: 0,
    fetchImpl: async(_url, options) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(new Error('secret-upstream'))
        }, { once: true })
      })
    },
  })
  await expectRefreshError(timeoutService.refresh(baseCookie), 'transient')

  console.log('QQ Music credential refresh tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```powershell
node scripts/test-qq-music-credential.js
```

Expected: FAIL because
`src/main/modules/qqMusic/credential.ts` does not exist.

- [ ] **Step 3: Implement the credential client**

Create `src/main/modules/qqMusic/credential.ts` with these exports and
behavior:

```ts
import {
  getCookieValue,
  mergeCookieUpdates,
} from './auth'
import { createQQMusicFallbackGuid } from './request'

const REFRESH_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const REFRESH_AFTER_MS = 20 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000
const INVALID_CODES = new Set([1000, 104400, 104401])

export type QQMusicCredentialRefreshErrorKind =
  | 'invalid'
  | 'unavailable'
  | 'transient'

export class QQMusicCredentialRefreshError extends Error {
  readonly kind: QQMusicCredentialRefreshErrorKind

  constructor(kind: QQMusicCredentialRefreshErrorKind) {
    super(`QQ Music credential refresh ${kind}`)
    this.name = 'QQMusicCredentialRefreshError'
    this.kind = kind
  }
}

export const isQQMusicCredentialRefreshError = (
  error: unknown,
): error is QQMusicCredentialRefreshError => {
  const value = error as Partial<QQMusicCredentialRefreshError> | null
  return !!value &&
    value.name == 'QQMusicCredentialRefreshError' &&
    (value.kind == 'invalid' ||
      value.kind == 'unavailable' ||
      value.kind == 'transient')
}

export interface QQMusicCredentialService {
  refresh: (cookie: string) => Promise<string>
  getRefreshDueAt: (cookie: string) => number | null
}

interface QQMusicRefreshInput {
  currentUin: string
  currentQQMusicUin: string
  uin: string
  musicId: number
  musicKey: string
  openid: string
  accessToken: string
  refreshToken: string
}

const normalizeUin = (cookie: string): string => {
  return (
    getCookieValue(cookie, 'uin') ||
    getCookieValue(cookie, 'qqmusic_uin')
  ).replace(/^o/, '')
}

const getRefreshInput = (
  cookie: string,
): QQMusicRefreshInput | null => {
  const currentUin = getCookieValue(cookie, 'uin')
  const currentQQMusicUin = getCookieValue(cookie, 'qqmusic_uin')
  const uin = normalizeUin(cookie)
  const musicId = Number(uin)
  const musicKey =
    getCookieValue(cookie, 'qqmusic_key') ||
    getCookieValue(cookie, 'qm_keyst')
  const openid = getCookieValue(cookie, 'psrf_qqopenid')
  const accessToken = getCookieValue(cookie, 'psrf_qqaccess_token')
  const refreshToken = getCookieValue(cookie, 'psrf_qqrefresh_token')
  if (!uin ||
    !Number.isSafeInteger(musicId) ||
    musicId <= 0 ||
    !musicKey ||
    !openid ||
    !accessToken ||
    !refreshToken) return null
  return {
    currentUin,
    currentQQMusicUin,
    uin,
    musicId,
    musicKey,
    openid,
    accessToken,
    refreshToken,
  }
}

export const getQQMusicCredentialRefreshDueAt = (
  cookie: string,
): number | null => {
  if (!getRefreshInput(cookie)) return null
  const createdAt = Number(
    getCookieValue(cookie, 'psrf_musickey_createtime'),
  )
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return null
  return createdAt * 1000 + REFRESH_AFTER_MS
}

const getRotatedUin = (
  current: string,
  returned: unknown,
): string | undefined => {
  const value = String(returned ?? '').replace(/^o/, '')
  if (!value) return undefined
  return current.startsWith('o') ? `o${value}` : value
}

export const createQQMusicCredentialService = ({
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}: {
  fetchImpl?: typeof fetch
  timeoutMs?: number
} = {}): QQMusicCredentialService => {
  const refresh = async(cookie: string): Promise<string> => {
    const input = getRefreshInput(cookie)
    if (!input) {
      throw new QQMusicCredentialRefreshError('unavailable')
    }
    const {
      currentUin,
      currentQQMusicUin,
      uin,
      musicId,
      musicKey,
      openid,
      accessToken,
      refreshToken,
    } = input

    const expiresAt =
      Number(getCookieValue(cookie, 'psrf_access_token_expiresAt')) || 0
    const unionid = getCookieValue(cookie, 'psrf_qqunionid')
    const body = JSON.stringify({
      comm: {
        _channelid: '19',
        _os_version: '6.2.9200-2',
        authst: musicKey,
        ct: '19',
        cv: '2116',
        guid:
          getCookieValue(cookie, 'guid') ||
          getCookieValue(cookie, 'qqmusic_guid') ||
          createQQMusicFallbackGuid(uin),
        patch: '118',
        psrf_access_token_expiresAt: expiresAt,
        psrf_qqaccess_token: accessToken,
        psrf_qqopenid: openid,
        psrf_qqunionid: unionid,
        tmeAppID: 'qqmusic',
        tmeLoginType:
          Number(getCookieValue(cookie, 'tmeLoginType')) || 2,
        uin,
        wid: getCookieValue(cookie, 'wid') || '0',
      },
      req_0: {
        module: 'music.login.LoginServer',
        method: 'Login',
        param: {
          access_token: accessToken,
          appid: 100497308,
          expired_in: expiresAt,
          encryptUin: getCookieValue(cookie, 'euin'),
          forceRefreshToken: 0,
          musicid: musicId,
          musickey: musicKey,
          musickeyCreateTime:
            Number(
              getCookieValue(cookie, 'psrf_musickey_createtime'),
            ) || 0,
          onlyNeedAccessToken: 0,
          openid,
          refresh_key: getCookieValue(cookie, 'refresh_key'),
          refresh_token: refreshToken,
          str_musicid: uin,
          unionid,
        },
      },
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(REFRESH_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://y.qq.com',
          Referer: 'https://y.qq.com/',
          Cookie: cookie,
        },
        body,
      })
    } catch {
      throw new QQMusicCredentialRefreshError('transient')
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) {
      throw new QQMusicCredentialRefreshError('transient')
    }

    let payload: any
    try {
      payload = await response.json()
    } catch {
      throw new QQMusicCredentialRefreshError('transient')
    }
    const moduleResult = payload?.req_0
    if (INVALID_CODES.has(moduleResult?.code)) {
      throw new QQMusicCredentialRefreshError('invalid')
    }
    if (
      payload?.code != 0 ||
      moduleResult?.code != 0 ||
      !moduleResult?.data?.musickey
    ) {
      throw new QQMusicCredentialRefreshError('transient')
    }

    const data = moduleResult.data
    const returnedUin = data.str_musicid ?? data.musicid
    const rawReturnedUin = String(returnedUin ?? '').replace(/^o/, '')
    const normalizedReturnedUin = rawReturnedUin == '0' ? '' : rawReturnedUin
    if (normalizedReturnedUin && normalizedReturnedUin != uin) {
      throw new QQMusicCredentialRefreshError('transient')
    }
    return mergeCookieUpdates(cookie, {
      psrf_qqopenid: data.openid,
      psrf_qqunionid: data.unionid,
      psrf_qqaccess_token: data.access_token,
      psrf_qqrefresh_token: data.refresh_token,
      qqmusic_key: data.musickey,
      qm_keyst: data.musickey,
      psrf_musickey_createtime: data.musickeyCreateTime,
      psrf_access_token_expiresAt:
        data.expired_at ?? data.expired_in,
      euin: data.encryptUin,
      refresh_key: data.refresh_key,
      login_type: data.login_type,
      tmeLoginType: data.loginType,
      uin: currentUin
        ? getRotatedUin(currentUin, normalizedReturnedUin)
        : undefined,
      qqmusic_uin: currentQQMusicUin
        ? getRotatedUin(currentQQMusicUin, normalizedReturnedUin)
        : undefined,
    })
  }

  return {
    refresh,
    getRefreshDueAt: getQQMusicCredentialRefreshDueAt,
  }
}
```

Do not log caught errors or response bodies. The typed error message contains
only the fixed kind.

- [ ] **Step 4: Run the credential and Cookie tests to verify GREEN**

Run:

```powershell
node scripts/test-qq-music-credential.js
```

Expected: `QQ Music credential refresh tests passed`.

Run:

```powershell
node scripts/test-qq-music-auth.js
```

Expected: `QQ Music auth tests passed`.

- [ ] **Step 5: Commit the credential client**

Run:

```powershell
git add -- src/main/modules/qqMusic/credential.ts scripts/test-qq-music-credential.js
git commit -m "feat: add QQ Music credential refresh client"
```

Expected: one commit containing the internal client and its isolated tests.

---

### Task 3: Reactive Refresh, Retry, And Confirmed-Invalid Logout

**Files:**
- Create: `scripts/test-qq-music-account-refresh.js`
- Modify: `scripts/test-qq-music-account.js`
- Modify: `src/main/modules/qqMusic/index.ts`

- [ ] **Step 1: Write failing account-refresh tests**

Create `scripts/test-qq-music-account-refresh.js`. Load `index.ts` with mocked
module factories, as the existing account test does, and define these test
doubles:

```js
const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

class QQMusicAuthError extends Error {
  constructor(message = 'expired') {
    super(message)
    this.name = 'QQMusicAuthError'
  }
}

class QQMusicCredentialRefreshError extends Error {
  constructor(kind) {
    super(`QQ Music credential refresh ${kind}`)
    this.name = 'QQMusicCredentialRefreshError'
    this.kind = kind
  }
}

const isQQMusicAuthError = error =>
  error?.name === 'QQMusicAuthError'
const isQQMusicCredentialRefreshError = error =>
  error?.name === 'QQMusicCredentialRefreshError'

const indexModule = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/index.ts'),
  {
    '@common/constants': {
      DATA_KEYS: { qqMusicAccount: 'qqMusicAccount' },
      STORE_NAMES: { DATA: 'data' },
    },
    '@main/utils/store': () => {
      throw new Error('singleton store is not used in this test')
    },
    './login': {
      createQQMusicLoginService: () => {
        throw new Error('singleton login is not used in this test')
      },
    },
    './auth': {
      getQQMusicAccountUin: cookie => {
        const match = /(?:^|;\s*)(?:uin|qqmusic_uin)=([^;]+)/.exec(cookie)
        const key = /(?:^|;\s*)(?:qqmusic_key|qm_keyst)=([^;]+)/.exec(cookie)
        return match && key ? match[1] : ''
      },
    },
    './credential': {
      createQQMusicCredentialService: () => {
        throw new Error('singleton credential service is not used in this test')
      },
      isQQMusicCredentialRefreshError,
    },
    './song': {
      createQQMusicSongService: () => {
        throw new Error('singleton song service is not used in this test')
      },
      QQMusicAuthError,
      isQQMusicAuthError,
    },
    './dailyRecommend': {
      createQQMusicDailyRecommendService: () => {
        throw new Error('singleton daily service is not used in this test')
      },
    },
    './homeRecommend': {
      createQQMusicHomeRecommendService: () => {
        throw new Error('singleton home service is not used in this test')
      },
    },
    './playlistDetail': {
      createQQMusicPlaylistDetailService: () => {
        throw new Error('singleton playlist service is not used in this test')
      },
    },
  },
)
```

Use this account and factory:

```js
const accountA = {
  cookie: 'uin=oA; qqmusic_key=old-key',
  profile: { uin: 'oA', nickname: 'QQ Music account' },
  updatedAt: 10,
}
const accountB = {
  cookie: 'uin=oB; qqmusic_key=account-b',
  profile: { uin: 'oB', nickname: 'QQ Music account' },
  updatedAt: 20,
}

const createStore = initial => {
  const data = new Map([['qqMusicAccount', initial]])
  return {
    data,
    store: {
      get: key => data.get(key),
      set: (key, value) => data.set(key, value),
    },
  }
}

const createServices = request => ({
  loginService: {
    createLoginQr: async() => ({ key: 'qr', qrimg: 'data:image/png;base64,AA==' }),
    checkLoginQr: async() => ({ state: 'waiting', message: 'waiting' }),
  },
  songService: { getGuessLikeSongs: request },
  dailyRecommendService: { getDailyRecommendSongs: request },
  homeRecommendService: { getHomeRecommendation: request },
  playlistDetailService: { getPlaylistDetail: request },
})
```

Place the following cases inside `const main = async() => { ... }`:

```js
// Auth error -> one refresh -> one retry with the persisted Cookie.
{
  const { data, store } = createStore(accountA)
  let requestCalls = 0
  let refreshCalls = 0
  const request = async() => {
    requestCalls++
    if (requestCalls == 1) throw new QQMusicAuthError()
    assert.strictEqual(data.get('qqMusicAccount').cookie, 'uin=oA; qqmusic_key=new-key')
    return ['retried']
  }
  const service = indexModule.createQQMusicAccountService({
    store,
    ...createServices(request),
    credentialService: {
      refresh: async() => {
        refreshCalls++
        return 'uin=oA; qqmusic_key=new-key'
      },
      getRefreshDueAt: () => null,
    },
    now: () => 30,
    onRefreshDiagnostic: () => {},
  })
  assert.deepStrictEqual(await service.getGuessLikeSongs(), ['retried'])
  assert.strictEqual(requestCalls, 2)
  assert.strictEqual(refreshCalls, 1)
  assert.deepStrictEqual(data.get('qqMusicAccount'), {
    cookie: 'uin=oA; qqmusic_key=new-key',
    profile: accountA.profile,
    updatedAt: 30,
  })
}

// A retry that still reports auth failure is not refreshed again and does not
// clear the account.
{
  const { data, store } = createStore(accountA)
  let requestCalls = 0
  let refreshCalls = 0
  const request = async() => {
    requestCalls++
    throw new QQMusicAuthError()
  }
  const service = indexModule.createQQMusicAccountService({
    store,
    ...createServices(request),
    credentialService: {
      refresh: async() => {
        refreshCalls++
        return 'uin=oA; qqmusic_key=new-key'
      },
      getRefreshDueAt: () => null,
    },
    now: () => 31,
    onRefreshDiagnostic: () => {},
  })
  await assert.rejects(service.getGuessLikeSongs(), QQMusicAuthError)
  assert.strictEqual(requestCalls, 2)
  assert.strictEqual(refreshCalls, 1)
  assert.strictEqual(service.getAccountStatus().isLoggedIn, true)
  assert.strictEqual(data.get('qqMusicAccount').cookie, 'uin=oA; qqmusic_key=new-key')
}

// Concurrent failures share one refresh operation.
{
  const { store } = createStore(accountA)
  let refreshCalls = 0
  let refreshed = false
  let resolveRefresh
  const refreshPromise = new Promise(resolve => {
    resolveRefresh = () => {
      refreshed = true
      resolve('uin=oA; qqmusic_key=shared-new-key')
    }
  })
  const request = async() => {
    if (!refreshed) throw new QQMusicAuthError()
    return ['ok']
  }
  const service = indexModule.createQQMusicAccountService({
    store,
    ...createServices(request),
    credentialService: {
      refresh: async() => {
        refreshCalls++
        return refreshPromise
      },
      getRefreshDueAt: () => null,
    },
    now: () => 32,
    onRefreshDiagnostic: () => {},
  })
  const first = service.getGuessLikeSongs()
  const second = service.getDailyRecommendSongs()
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(refreshCalls, 1)
  resolveRefresh()
  assert.deepStrictEqual(await first, ['ok'])
  assert.deepStrictEqual(await second, ['ok'])
  assert.strictEqual(refreshCalls, 1)
}

// A late failure from the old Cookie reuses the already committed refresh
// instead of failing its stale snapshot or sending another refresh.
{
  const { store } = createStore(accountA)
  let refreshCalls = 0
  let songCalls = 0
  let dailyCalls = 0
  let rejectSong
  let rejectDaily
  const oldSongRequest = new Promise((_resolve, reject) => {
    rejectSong = reject
  })
  const oldDailyRequest = new Promise((_resolve, reject) => {
    rejectDaily = reject
  })
  const services = createServices(async() => ['unused'])
  services.songService.getGuessLikeSongs = async() => {
    songCalls++
    if (songCalls == 1) return oldSongRequest
    return ['song-retried']
  }
  services.dailyRecommendService.getDailyRecommendSongs = async() => {
    dailyCalls++
    if (dailyCalls == 1) return oldDailyRequest
    return ['daily-retried']
  }
  const service = indexModule.createQQMusicAccountService({
    store,
    ...services,
    credentialService: {
      refresh: async() => {
        refreshCalls++
        return 'uin=oA; qqmusic_key=late-new-key'
      },
      getRefreshDueAt: () => null,
    },
    now: () => 32,
    onRefreshDiagnostic: () => {},
  })
  const songRequest = service.getGuessLikeSongs()
  const dailyRequest = service.getDailyRecommendSongs()
  await new Promise(resolve => setImmediate(resolve))
  rejectSong(new QQMusicAuthError())
  assert.deepStrictEqual(await songRequest, ['song-retried'])
  rejectDaily(new QQMusicAuthError())
  assert.deepStrictEqual(await dailyRequest, ['daily-retried'])
  assert.strictEqual(refreshCalls, 1)
  assert.strictEqual(songCalls, 2)
  assert.strictEqual(dailyCalls, 2)
}

// Only an explicit invalid refresh clears the matching account.
for (const kind of ['invalid', 'unavailable', 'transient']) {
  const { data, store } = createStore(accountA)
  const diagnostics = []
  const service = indexModule.createQQMusicAccountService({
    store,
    ...createServices(async() => {
      throw new QQMusicAuthError()
    }),
    credentialService: {
      refresh: async() => {
        throw new QQMusicCredentialRefreshError(kind)
      },
      getRefreshDueAt: () => null,
    },
    now: () => 33,
    onRefreshDiagnostic: event => diagnostics.push(event),
  })
  await assert.rejects(service.getGuessLikeSongs(), QQMusicAuthError)
  assert.strictEqual(
    service.getAccountStatus().isLoggedIn,
    kind != 'invalid',
  )
  assert.strictEqual(
    data.get('qqMusicAccount').cookie,
    kind == 'invalid' ? '' : accountA.cookie,
  )
  assert.deepStrictEqual(diagnostics, [{
    trigger: 'auth-error',
    outcome: kind,
  }])
}

// A stale refresh result cannot overwrite a newer account.
{
  const { data, store } = createStore(accountA)
  let resolveRefresh
  const refreshPromise = new Promise(resolve => {
    resolveRefresh = resolve
  })
  const service = indexModule.createQQMusicAccountService({
    store,
    ...createServices(async() => {
      throw new QQMusicAuthError()
    }),
    credentialService: {
      refresh: async() => refreshPromise,
      getRefreshDueAt: () => null,
    },
    now: () => 34,
    onRefreshDiagnostic: () => {},
  })
  const pending = service.getGuessLikeSongs()
  await new Promise(resolve => setImmediate(resolve))
  data.set('qqMusicAccount', accountB)
  resolveRefresh('uin=oA; qqmusic_key=stale-new-key')
  await assert.rejects(pending, QQMusicAuthError)
  assert.deepStrictEqual(data.get('qqMusicAccount'), accountB)
}

// A stale invalid result also cannot clear a newer account.
{
  const { data, store } = createStore(accountA)
  let rejectRefresh
  const diagnostics = []
  const refreshPromise = new Promise((_resolve, reject) => {
    rejectRefresh = reject
  })
  const service = indexModule.createQQMusicAccountService({
    store,
    ...createServices(async() => {
      throw new QQMusicAuthError()
    }),
    credentialService: {
      refresh: async() => refreshPromise,
      getRefreshDueAt: () => null,
    },
    now: () => 35,
    onRefreshDiagnostic: event => diagnostics.push(event),
  })
  const pending = service.getGuessLikeSongs()
  await new Promise(resolve => setImmediate(resolve))
  data.set('qqMusicAccount', accountB)
  rejectRefresh(new QQMusicCredentialRefreshError('invalid'))
  await assert.rejects(pending, QQMusicAuthError)
  assert.deepStrictEqual(data.get('qqMusicAccount'), accountB)
  assert.deepStrictEqual(diagnostics, [{
    trigger: 'auth-error',
    outcome: 'stale',
  }])
}

// Logout while refresh is in flight stays logged out after the old result
// settles.
{
  const { data, store } = createStore(accountA)
  let resolveRefresh
  const refreshPromise = new Promise(resolve => {
    resolveRefresh = resolve
  })
  const service = indexModule.createQQMusicAccountService({
    store,
    ...createServices(async() => {
      throw new QQMusicAuthError()
    }),
    credentialService: {
      refresh: async() => refreshPromise,
      getRefreshDueAt: () => null,
    },
    now: () => 36,
    onRefreshDiagnostic: () => {},
  })
  const pending = service.getGuessLikeSongs()
  await new Promise(resolve => setImmediate(resolve))
  await service.logout()
  resolveRefresh('uin=oA; qqmusic_key=stale-after-logout')
  await assert.rejects(pending, QQMusicAuthError)
  assert.strictEqual(data.get('qqMusicAccount').cookie, '')
  assert.strictEqual(service.getAccountStatus().isLoggedIn, false)
}

// A real successful QR-login path wins over an older in-flight refresh.
{
  const { data, store } = createStore(accountA)
  let resolveRefresh
  const refreshPromise = new Promise(resolve => {
    resolveRefresh = resolve
  })
  const services = createServices(async() => {
    throw new QQMusicAuthError()
  })
  services.loginService.checkLoginQr = async() => ({
    state: 'success',
    message: 'success',
    cookie: 'uin=oB; qqmusic_key=account-b',
  })
  const service = indexModule.createQQMusicAccountService({
    store,
    ...services,
    credentialService: {
      refresh: async() => refreshPromise,
      getRefreshDueAt: () => null,
    },
    now: () => 37,
    onRefreshDiagnostic: () => {},
  })
  const pending = service.getGuessLikeSongs()
  await new Promise(resolve => setImmediate(resolve))
  await service.checkLoginQr('new-login')
  resolveRefresh('uin=oA; qqmusic_key=stale-after-login')
  await assert.rejects(pending, QQMusicAuthError)
  assert.strictEqual(data.get('qqMusicAccount').cookie, accountB.cookie)
  assert.strictEqual(data.get('qqMusicAccount').profile.uin, 'oB')
}
```

Finish the new script with:

```js
main().then(() => {
  console.log('QQ Music account refresh tests passed')
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
```

In `scripts/test-qq-music-account.js`, add this class and service below the
existing local `QQMusicAuthError`:

```js
class QQMusicCredentialRefreshError extends Error {
  constructor(kind) {
    super(`QQ Music credential refresh ${kind}`)
    this.name = 'QQMusicCredentialRefreshError'
    this.kind = kind
  }
}

const unavailableCredentialService = {
  refresh: async() => {
    throw new QQMusicCredentialRefreshError('unavailable')
  },
  getRefreshDueAt: () => null,
}
```

Add this entry to the `loadTsModule` mocks:

```js
    './credential': {
      createQQMusicCredentialService: () =>
        unavailableCredentialService,
      isQQMusicCredentialRefreshError: error =>
        error instanceof QQMusicCredentialRefreshError,
    },
```

Also add the existing local class to the `./song` mock so the later preflight
branch can construct the same error type:

```js
      QQMusicAuthError,
```

Inject the same service from `createFacade`:

```js
const createFacade = () => createQQMusicAccountService({
  store,
  loginService,
  songService,
  dailyRecommendService,
  homeRecommendService,
  playlistDetailService,
  credentialService: unavailableCredentialService,
  now: () => 123456,
  onRefreshDiagnostic: () => {},
})
```

Replace the first post-login auth-error expectation with:

```js
  songError = new QQMusicAuthError('expired')
  await assert.rejects(restarted.getGuessLikeSongs(), QQMusicAuthError)
  assert.strictEqual(restarted.getAccountStatus().isLoggedIn, true)
  assert.strictEqual(
    data.get('qqMusicAccount').cookie,
    'uin=o123; qqmusic_key=secret',
  )
```

For each existing daily, home, and playlist auth-error case using `accountB`,
replace the signed-out assertion with:

```js
  assert.strictEqual(raceFacade.getAccountStatus().isLoggedIn, true)
  assert.deepStrictEqual(data.get('qqMusicAccount'), accountB)
```

Keep the existing account-A/account-B race assertion unchanged.

- [ ] **Step 2: Run the tests to verify RED**

Run:

```powershell
node scripts/test-qq-music-account-refresh.js
```

Expected: FAIL because `createQQMusicAccountService` does not accept or use
`credentialService`.

Run:

```powershell
node scripts/test-qq-music-account.js
```

Expected: FAIL because the current service still clears accounts directly on
`QQMusicAuthError`.

- [ ] **Step 3: Add refresh coordination to the account service**

Update imports in `src/main/modules/qqMusic/index.ts`:

```ts
import {
  createQQMusicCredentialService,
  isQQMusicCredentialRefreshError,
  type QQMusicCredentialService,
  type QQMusicCredentialRefreshErrorKind,
} from './credential'
import {
  createQQMusicSongService,
  isQQMusicAuthError,
} from './song'
```

Add these internal types:

```ts
type QQMusicRefreshTrigger = 'scheduled' | 'preflight' | 'auth-error'
type QQMusicRefreshOutcome =
  | { status: 'success', account: QQMusicAccountData }
  | { status: QQMusicCredentialRefreshErrorKind | 'stale' }

type QQMusicRefreshDiagnostic = {
  trigger: QQMusicRefreshTrigger
  outcome: QQMusicRefreshOutcome['status']
}

const defaultRefreshDiagnostic = (
  event: QQMusicRefreshDiagnostic,
) => {
  console.warn('[QQ Music refresh diagnostic]', event)
}

const isSameAccount = (
  left: QQMusicAccountData,
  right: QQMusicAccountData,
) => {
  return left.cookie == right.cookie &&
    left.updatedAt == right.updatedAt
}
```

Add these dependencies to `createQQMusicAccountService`:

```ts
  credentialService,
  onRefreshDiagnostic = defaultRefreshDiagnostic,
```

and to its parameter type:

```ts
  credentialService: QQMusicCredentialService
  onRefreshDiagnostic?: (event: QQMusicRefreshDiagnostic) => void
```

Inside the factory, add one in-flight entry and replace the old
`runAuthenticatedRequest` implementation with this coordination:

```ts
  let lastSuccessfulRefresh: {
    source: QQMusicAccountData
    refreshed: QQMusicAccountData
  } | undefined
  let refreshInFlight: {
    account: QQMusicAccountData
    promise: Promise<QQMusicRefreshOutcome>
  } | undefined

  const clearMatchingAccount = (account: QQMusicAccountData) => {
    const current = getAccountData(store)
    if (!isSameAccount(current, account)) return false
    clearAccount()
    return true
  }

  const performRefresh = async(
    account: QQMusicAccountData,
    trigger: QQMusicRefreshTrigger,
  ): Promise<QQMusicRefreshOutcome> => {
    try {
      const cookie = await credentialService.refresh(account.cookie)
      const current = getAccountData(store)
      if (!isSameAccount(current, account)) {
        const outcome = { status: 'stale' as const }
        onRefreshDiagnostic({ trigger, outcome: outcome.status })
        return outcome
      }
      const refreshedAccount: QQMusicAccountData = {
        cookie,
        profile: current.profile,
        updatedAt: now(),
      }
      store.set(DATA_KEYS.qqMusicAccount, refreshedAccount)
      lastSuccessfulRefresh = {
        source: account,
        refreshed: refreshedAccount,
      }
      onRefreshDiagnostic({ trigger, outcome: 'success' })
      return { status: 'success', account: refreshedAccount }
    } catch (error) {
      if (!isSameAccount(getAccountData(store), account)) {
        const outcome = { status: 'stale' as const }
        onRefreshDiagnostic({ trigger, outcome: outcome.status })
        return outcome
      }
      const status: QQMusicCredentialRefreshErrorKind =
        isQQMusicCredentialRefreshError(error)
          ? error.kind
          : 'transient'
      if (status == 'invalid') clearMatchingAccount(account)
      onRefreshDiagnostic({ trigger, outcome: status })
      return { status }
    }
  }

  const refreshAccount = async(
    account: QQMusicAccountData,
    trigger: QQMusicRefreshTrigger,
  ): Promise<QQMusicRefreshOutcome> => {
    const active = refreshInFlight
    if (active) {
      const outcome = await active.promise
      if (isSameAccount(active.account, account)) return outcome
      if (!isSameAccount(getAccountData(store), account)) {
        return { status: 'stale' }
      }
      return refreshAccount(account, trigger)
    }

    const entry = {
      account,
      promise: performRefresh(account, trigger),
    }
    refreshInFlight = entry
    try {
      return await entry.promise
    } finally {
      if (refreshInFlight == entry) refreshInFlight = undefined
    }
  }

  const runAuthenticatedRequest = async<T>(
    request: () => Promise<T>,
  ): Promise<T> => {
    const account = getAccountData(store)
    try {
      return await request()
    } catch (error) {
      if (!isQQMusicAuthError(error)) throw error
      const current = getAccountData(store)
      if (!isSameAccount(current, account)) {
        if (lastSuccessfulRefresh &&
          isSameAccount(lastSuccessfulRefresh.source, account) &&
          isSameAccount(lastSuccessfulRefresh.refreshed, current)) {
          return request()
        }
        throw error
      }
      const outcome = await refreshAccount(account, 'auth-error')
      if (outcome.status != 'success') throw error
      return request()
    }
  }
```

Delete the old branch that clears directly on `QQMusicAuthError`.

Clear `lastSuccessfulRefresh` whenever `clearAccount()` runs and immediately
before persisting a successful QR login:

```ts
  const clearAccount = () => {
    lastSuccessfulRefresh = undefined
    store.set(DATA_KEYS.qqMusicAccount, emptyAccount(now()))
  }
```

```ts
    lastSuccessfulRefresh = undefined
    store.set(DATA_KEYS.qqMusicAccount, {
      cookie: result.cookie,
      profile,
      updatedAt: now(),
    } satisfies QQMusicAccountData)
```

In `getAccountService`, instantiate and inject the real credential service:

```ts
  const credentialService = createQQMusicCredentialService()
```

and:

```ts
    credentialService,
```

No refresh error object or upstream message is logged. Diagnostics contain
only the fixed trigger and outcome.

- [ ] **Step 4: Run account tests to verify GREEN**

Run:

```powershell
node scripts/test-qq-music-account-refresh.js
```

Expected: `QQ Music account refresh tests passed`.

Run:

```powershell
node scripts/test-qq-music-account.js
```

Expected: `QQ Music account tests passed`.

- [ ] **Step 5: Commit reactive refresh**

Run:

```powershell
git add -- src/main/modules/qqMusic/index.ts scripts/test-qq-music-account.js scripts/test-qq-music-account-refresh.js
git commit -m "fix: refresh QQ Music credentials before logout"
```

Expected: one commit containing the account coordinator and policy regression
tests.

---

### Task 4: Proactive Renewal And Transient Backoff

**Files:**
- Modify: `scripts/test-qq-music-account-refresh.js`
- Modify: `src/main/modules/qqMusic/index.ts`

- [ ] **Step 1: Add failing timer and preflight tests**

Append a deterministic scheduler helper to
`scripts/test-qq-music-account-refresh.js`:

```js
const createScheduler = () => {
  const timers = []
  return {
    timers,
    schedule: (callback, delay) => {
      const timer = {
        callback,
        delay,
        cancelled: false,
        unrefed: false,
        unref() {
          this.unrefed = true
        },
      }
      timers.push(timer)
      return timer
    },
    cancel: timer => {
      timer.cancelled = true
    },
  }
}
```

Add these cases to `main()`:

```js
// A due account refreshes before the first business request. If that business
// request fails, the same call does not issue a second refresh.
{
  const { data, store } = createStore(accountA)
  let refreshCalls = 0
  let requestCalls = 0
  const service = indexModule.createQQMusicAccountService({
    store,
    ...createServices(async() => {
      requestCalls++
      assert.strictEqual(
        data.get('qqMusicAccount').cookie,
        'uin=oA; qqmusic_key=preflight-new-key',
      )
      throw new QQMusicAuthError()
    }),
    credentialService: {
      refresh: async() => {
        refreshCalls++
        return 'uin=oA; qqmusic_key=preflight-new-key'
      },
      getRefreshDueAt: () => 40,
    },
    now: () => 40,
    schedule: () => ({ unref() {} }),
    cancelSchedule: () => {},
    onRefreshDiagnostic: () => {},
  })
  await assert.rejects(service.getGuessLikeSongs(), QQMusicAuthError)
  assert.strictEqual(refreshCalls, 1)
  assert.strictEqual(requestCalls, 1)
}

// A stale invalid preflight result cannot abort a request after a successful
// scan login replaces the old account.
{
  const { data, store } = createStore(accountA)
  const scheduler = createScheduler()
  let rejectRefresh
  let requestCalls = 0
  const refreshPromise = new Promise((_resolve, reject) => {
    rejectRefresh = reject
  })
  const services = createServices(async() => {
    requestCalls++
    assert.strictEqual(
      data.get('qqMusicAccount').cookie.includes('account-b'),
      true,
    )
    return ['account-b-result']
  })
  services.loginService.checkLoginQr = async() => ({
    state: 'success',
    message: 'success',
    cookie:
      'uin=oB; qqmusic_key=account-b; psrf_musickey_createtime=300',
  })
  const service = indexModule.createQQMusicAccountService({
    store,
    ...services,
    credentialService: {
      refresh: async() => refreshPromise,
      getRefreshDueAt: cookie =>
        cookie.includes('account-b') ? 900 : 40,
    },
    now: () => 40,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
    onRefreshDiagnostic: () => {},
  })
  const pending = service.getGuessLikeSongs()
  await new Promise(resolve => setImmediate(resolve))
  await service.checkLoginQr('new-login')
  rejectRefresh(new QQMusicCredentialRefreshError('invalid'))
  assert.deepStrictEqual(await pending, ['account-b-result'])
  assert.strictEqual(requestCalls, 1)
  assert.strictEqual(
    data.get('qqMusicAccount').cookie.includes('account-b'),
    true,
  )
}

// Service creation schedules the current account and unrefs the timer.
{
  const { store } = createStore(accountA)
  const scheduler = createScheduler()
  indexModule.createQQMusicAccountService({
    store,
    ...createServices(async() => ['ok']),
    credentialService: {
      refresh: async() => 'uin=oA; qqmusic_key=scheduled-new-key',
      getRefreshDueAt: () => 80,
    },
    now: () => 50,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
    onRefreshDiagnostic: () => {},
  })
  assert.strictEqual(scheduler.timers.length, 1)
  assert.strictEqual(scheduler.timers[0].delay, 30)
  assert.strictEqual(scheduler.timers[0].unrefed, true)
}

// A transient scheduled failure preserves the account and creates a one-hour
// retry rather than a zero-delay loop.
{
  const { store } = createStore(accountA)
  const scheduler = createScheduler()
  const service = indexModule.createQQMusicAccountService({
    store,
    ...createServices(async() => ['ok']),
    credentialService: {
      refresh: async() => {
        throw new QQMusicCredentialRefreshError('transient')
      },
      getRefreshDueAt: () => 50,
    },
    now: () => 50,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
    retryDelayMs: 60 * 60 * 1000,
    onRefreshDiagnostic: () => {},
  })
  assert.strictEqual(scheduler.timers[0].delay, 0)
  scheduler.timers[0].callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(service.getAccountStatus().isLoggedIn, true)
  const retry = scheduler.timers.at(-1)
  assert.strictEqual(retry.delay, 60 * 60 * 1000)
  assert.strictEqual(retry.unrefed, true)
}

// Successful scheduled refresh reschedules from the rotated Cookie.
{
  const { store } = createStore(accountA)
  const scheduler = createScheduler()
  const service = indexModule.createQQMusicAccountService({
    store,
    ...createServices(async() => ['ok']),
    credentialService: {
      refresh: async() =>
        'uin=oA; qqmusic_key=scheduled-new-key; psrf_musickey_createtime=200',
      getRefreshDueAt: cookie =>
        cookie.includes('scheduled-new-key') ? 500 : 100,
    },
    now: () => 100,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
    onRefreshDiagnostic: () => {},
  })
  scheduler.timers[0].callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(service.getAccountStatus().isLoggedIn, true)
  assert.strictEqual(scheduler.timers.at(-1).delay, 400)
}

// A successful refresh whose creation time did not move forward uses
// backoff instead of immediately refreshing again.
{
  const { store } = createStore(accountA)
  const scheduler = createScheduler()
  const service = indexModule.createQQMusicAccountService({
    store,
    ...createServices(async() => ['ok']),
    credentialService: {
      refresh: async() =>
        'uin=oA; qqmusic_key=nonadvancing; psrf_musickey_createtime=50',
      getRefreshDueAt: () => 50,
    },
    now: () => 50,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
    retryDelayMs: 60 * 60 * 1000,
    onRefreshDiagnostic: () => {},
  })
  scheduler.timers[0].callback()
  await new Promise(resolve => setImmediate(resolve))
  const retry = scheduler.timers.at(-1)
  assert.strictEqual(retry.delay, 60 * 60 * 1000)
  assert.strictEqual(retry.unrefed, true)
  assert.strictEqual(service.getAccountStatus().isLoggedIn, true)
}

// Logout cancels the current renewal timer.
{
  const { store } = createStore(accountA)
  const scheduler = createScheduler()
  const service = indexModule.createQQMusicAccountService({
    store,
    ...createServices(async() => ['ok']),
    credentialService: {
      refresh: async() => accountA.cookie,
      getRefreshDueAt: () => 100,
    },
    now: () => 50,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
    onRefreshDiagnostic: () => {},
  })
  const timer = scheduler.timers[0]
  await service.logout()
  assert.strictEqual(timer.cancelled, true)
  assert.strictEqual(service.getAccountStatus().isLoggedIn, false)
}

// A successful scan login schedules the new account, while a Cookie without
// creation time remains reactive-only.
{
  const { store } = createStore({
    cookie: '',
    profile: null,
    updatedAt: 0,
  })
  const scheduler = createScheduler()
  const services = createServices(async() => ['ok'])
  services.loginService.checkLoginQr = async() => ({
    state: 'success',
    message: 'success',
    cookie: 'uin=oC; qqmusic_key=login-key; psrf_musickey_createtime=300',
  })
  const service = indexModule.createQQMusicAccountService({
    store,
    ...services,
    credentialService: {
      refresh: async cookie => cookie,
      getRefreshDueAt: cookie =>
        cookie.includes('psrf_musickey_createtime') ? 900 : null,
    },
    now: () => 400,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
    onRefreshDiagnostic: () => {},
  })
  assert.strictEqual(scheduler.timers.length, 0)
  await service.checkLoginQr('qr')
  assert.strictEqual(scheduler.timers.length, 1)
  assert.strictEqual(scheduler.timers[0].delay, 500)
  assert.strictEqual(scheduler.timers[0].unrefed, true)
}

// A scan login that happens during an old reactive refresh cancels account A's
// timer, schedules account B, and cannot be disturbed by account A settling.
{
  const { data, store } = createStore(accountA)
  const scheduler = createScheduler()
  let resolveRefresh
  const refreshPromise = new Promise(resolve => {
    resolveRefresh = resolve
  })
  const services = createServices(async() => {
    throw new QQMusicAuthError()
  })
  services.loginService.checkLoginQr = async() => ({
    state: 'success',
    message: 'success',
    cookie: 'uin=oB; qqmusic_key=account-b; psrf_musickey_createtime=300',
  })
  const service = indexModule.createQQMusicAccountService({
    store,
    ...services,
    credentialService: {
      refresh: async() => refreshPromise,
      getRefreshDueAt: cookie =>
        cookie.includes('account-b') ? 900 : 800,
    },
    now: () => 400,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
    onRefreshDiagnostic: () => {},
  })
  const pending = service.getGuessLikeSongs()
  await new Promise(resolve => setImmediate(resolve))
  await service.checkLoginQr('new-login')
  assert.strictEqual(scheduler.timers.length, 2)
  assert.strictEqual(scheduler.timers[0].cancelled, true)
  assert.strictEqual(scheduler.timers[1].delay, 500)
  assert.strictEqual(scheduler.timers[1].cancelled, false)
  resolveRefresh('uin=oA; qqmusic_key=stale-account-a')
  await assert.rejects(pending, QQMusicAuthError)
  assert.strictEqual(scheduler.timers.length, 2)
  assert.strictEqual(scheduler.timers[1].cancelled, false)
  assert.strictEqual(data.get('qqMusicAccount').cookie.includes('account-b'), true)
}
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```powershell
node scripts/test-qq-music-account-refresh.js
```

Expected: FAIL because the account service does not schedule renewal or run
due refresh before a business request.

- [ ] **Step 3: Implement scheduling, backoff, and preflight**

Add these dependencies to `createQQMusicAccountService`:

```ts
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  retryDelayMs = 60 * 60 * 1000,
```

and parameter types:

```ts
  schedule?: typeof setTimeout
  cancelSchedule?: typeof clearTimeout
  retryDelayMs?: number
```

Inside the factory, add the timer and helper functions. Use function
declarations so scheduling and refresh coordination can call each other:

```ts
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  function cancelRefreshTimer() {
    if (!refreshTimer) return
    cancelSchedule(refreshTimer)
    refreshTimer = undefined
  }

  function scheduleAccountRefresh(
    account: QQMusicAccountData,
    delayOverride?: number,
  ) {
    cancelRefreshTimer()
    if (!account.cookie) return
    const dueAt = credentialService.getRefreshDueAt(account.cookie)
    if (dueAt == null) return
    const delay = delayOverride ?? Math.max(0, dueAt - now())
    refreshTimer = schedule(() => {
      refreshTimer = undefined
      void runScheduledRefresh(account)
    }, delay)
    ;(refreshTimer as ReturnType<typeof setTimeout> & {
      unref?: () => void
    }).unref?.()
  }

  function scheduleRefreshedAccount(account: QQMusicAccountData) {
    const dueAt = credentialService.getRefreshDueAt(account.cookie)
    scheduleAccountRefresh(
      account,
      dueAt != null && dueAt <= now() ? retryDelayMs : undefined,
    )
  }

  async function runScheduledRefresh(account: QQMusicAccountData) {
    if (!isSameAccount(getAccountData(store), account)) return
    const outcome = await refreshAccount(account, 'scheduled')
    if (outcome.status == 'success') {
      scheduleRefreshedAccount(outcome.account)
      return
    }
    if (outcome.status == 'transient' &&
      isSameAccount(getAccountData(store), account)) {
      scheduleAccountRefresh(account, retryDelayMs)
    }
  }
```

Change unconditional account clearing so logout and confirmed invalidation also
cancel the timer:

```ts
  const clearAccount = () => {
    cancelRefreshTimer()
    lastSuccessfulRefresh = undefined
    store.set(DATA_KEYS.qqMusicAccount, emptyAccount(now()))
  }
```

After successful QR login persistence, call:

```ts
    lastSuccessfulRefresh = undefined
    const account = {
      cookie: result.cookie,
      profile,
      updatedAt: now(),
    } satisfies QQMusicAccountData
    store.set(DATA_KEYS.qqMusicAccount, account)
    scheduleAccountRefresh(account)
```

Replace `runAuthenticatedRequest` with the preflight-aware version:

```ts
  const runAuthenticatedRequest = async<T>(
    request: () => Promise<T>,
  ): Promise<T> => {
    let account = getAccountData(store)
    let refreshAttempted = false
    const dueAt = credentialService.getRefreshDueAt(account.cookie)
    if (account.cookie && dueAt != null && dueAt <= now()) {
      refreshAttempted = true
      const outcome = await refreshAccount(account, 'preflight')
      if (outcome.status == 'success') {
        account = outcome.account
        scheduleRefreshedAccount(account)
      } else if (outcome.status == 'stale') {
        account = getAccountData(store)
        if (!account.cookie) throw new QQMusicAuthError()
        refreshAttempted = false
      } else if (outcome.status == 'transient' &&
        isSameAccount(getAccountData(store), account)) {
        scheduleAccountRefresh(account, retryDelayMs)
      } else if (outcome.status == 'invalid') {
        throw new QQMusicAuthError()
      }
    }

    try {
      return await request()
    } catch (error) {
      if (!isQQMusicAuthError(error) || refreshAttempted) throw error
      const current = getAccountData(store)
      if (!isSameAccount(current, account)) {
        if (lastSuccessfulRefresh &&
          isSameAccount(lastSuccessfulRefresh.source, account) &&
          isSameAccount(lastSuccessfulRefresh.refreshed, current)) {
          return request()
        }
        throw error
      }
      const outcome = await refreshAccount(account, 'auth-error')
      if (outcome.status == 'success') {
        scheduleRefreshedAccount(outcome.account)
        return request()
      }
      if (outcome.status == 'transient' &&
        isSameAccount(getAccountData(store), account)) {
        scheduleAccountRefresh(account, retryDelayMs)
      }
      throw error
    }
  }
```

Import `QQMusicAuthError` from `./song` for the preflight-invalid branch.

Immediately before returning the service facade, initialize the timer from the
persisted account:

```ts
  scheduleAccountRefresh(getAccountData(store))
```

Missing timestamps produce no timer. Every later authenticated request still
uses reactive refresh on `QQMusicAuthError`.

`scheduleRefreshedAccount` deliberately applies the one-hour backoff when a
successful response preserves an already-due creation time. This accepts the
rotated credential without creating a zero-delay refresh loop.

- [ ] **Step 4: Run all refresh-focused tests to verify GREEN**

Run:

```powershell
node scripts/test-qq-music-account-refresh.js
```

Expected: `QQ Music account refresh tests passed`.

Run:

```powershell
node scripts/test-qq-music-account.js
```

Expected: `QQ Music account tests passed`.

Run:

```powershell
node scripts/test-qq-music-credential.js
```

Expected: `QQ Music credential refresh tests passed`.

- [ ] **Step 5: Commit proactive renewal**

Run:

```powershell
git add -- src/main/modules/qqMusic/index.ts scripts/test-qq-music-account-refresh.js
git commit -m "feat: schedule QQ Music credential renewal"
```

Expected: one commit containing proactive scheduling, backoff, and their
deterministic tests.

---

### Task 5: Full Verification And Runtime Smoke Test

**Files:**
- Verify: `src/main/modules/qqMusic/auth.ts`
- Verify: `src/main/modules/qqMusic/credential.ts`
- Verify: `src/main/modules/qqMusic/index.ts`
- Verify: all `scripts/test-qq-music-*.js`

- [ ] **Step 1: Run all QQ Music regression scripts**

Run:

```powershell
Get-ChildItem -Path scripts -Filter 'test-qq-music-*.js' |
  Sort-Object Name |
  ForEach-Object {
    node $_.FullName
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
```

Expected: every QQ Music script exits `0`, including:

```text
QQ Music auth tests passed
QQ Music credential refresh tests passed
QQ Music account refresh tests passed
QQ Music account tests passed
```

- [ ] **Step 2: Run focused lint**

Run:

```powershell
npx eslint src/main/modules/qqMusic/auth.ts src/main/modules/qqMusic/credential.ts src/main/modules/qqMusic/index.ts
```

Expected: exit code `0` with no lint errors.

- [ ] **Step 3: Build the main-process production bundle**

Run:

```powershell
npm run build:main
```

Expected: webpack exits `0` and produces the main-process bundle without
TypeScript errors.

- [ ] **Step 4: Check the final diff and secret hygiene**

Run:

```powershell
git diff --check
```

Expected: no output and exit code `0`.

Run:

```powershell
rg -n "console\.(log|warn|error).*cookie|console\.(log|warn|error).*token|response\.body|JSON\.stringify\(payload\)" src/main/modules/qqMusic/auth.ts src/main/modules/qqMusic/credential.ts src/main/modules/qqMusic/index.ts
```

Expected: no new diagnostic prints containing Cookie, token, payload, or
response-body data. Fixed enum diagnostics are allowed.

- [ ] **Step 5: Launch the application for a non-destructive live smoke test**

Run:

```powershell
npm run dev
```

Expected:

- Electron launches normally.
- The current QQ account remains shown as logged in.
- Opening the QQ recommendation page loads home, daily, guess-like, and
  brush-mode content without clearing the account.
- Opening a recommendation playlist still loads its detail.
- Logs contain only fixed refresh diagnostic enums and never credential
  values.

Do not force a live refresh by editing the user's stored timestamp or sending
an unpersisted standalone refresh request. The automated client and
account-service tests exercise rotation atomically; a natural due refresh will
use the same persisted path.

- [ ] **Step 6: Record final repository state**

Run:

```powershell
git status --short --branch
```

Expected: no uncommitted implementation changes. The branch contains the
design commit, plan commit, and the four focused implementation commits from
Tasks 1 through 4.
