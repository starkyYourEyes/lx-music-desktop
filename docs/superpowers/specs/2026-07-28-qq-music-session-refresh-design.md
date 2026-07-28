# QQ Music Session Refresh Design

## Goal

Keep a QQ Music account usable after its initial browser-backed login and stop
recommendation API failures from incorrectly deleting the saved account.

The application must rotate QQ Music credentials before they become stale,
refresh and retry once when an authenticated request reports an authentication
failure, and clear the account only when the credential refresh endpoint
explicitly confirms that the credentials are invalid.

## Background

QQ Music login currently saves a flattened Cookie string in the account store.
The temporary Electron login session is destroyed after login, and production
code never uses the saved `psrf_qqrefresh_token`. The Cookie is therefore a
static snapshot.

The QQ recommendation page starts several authenticated requests in parallel.
Each service converts a top-level or module-level `code == 1000` response into
`QQMusicAuthError`. `runAuthenticatedRequest` currently treats that error as
proof that the whole account expired and immediately replaces the saved
account with an empty account.

This creates two independent problems:

1. QQ Music credentials are never renewed.
2. A single endpoint-specific `code == 1000` can erase an otherwise valid
   account.

The old response from the reported incident is no longer available because
the user logged in again. The design therefore addresses the confirmed unsafe
behavior without claiming that every QQ Music `1000` response has one meaning.

## External Implementation Survey

QQ Music does not publish a supported third-party refresh API. The following
projects implement the private protocol:

- `L-1124/QQMusicApi` exposes Python
  `LoginApi.refresh_credential()`. It calls
  `music.login.LoginServer/Login`, returns a structured credential, and
  distinguishes authentication expiry codes from other login errors. The
  package is GPL-3.0.
- `liuran001/MusicBot-Go` implements manual renewal, scheduled renewal,
  single-client Cookie persistence, and complete token rotation. The project
  is GPL-3.0.
- `tlyanyu/multiPlatformMusicApi` contains a Node.js
  `refreshQQMusicCookies()` helper with the complete request and response
  fields. It is not an npm package. Its `package.json` declares MIT, but the
  repository has no LICENSE file.
- `Cat-bl/bl-chat-plugin` contains a Node.js `refreshQQMusicToken()` helper and
  has an MIT LICENSE, but the helper is coupled to the plugin's configuration
  and persistence model.
- `jsososo/QQMusicApi` publishes `/user/refresh`, but the published npm package
  is old and updates only the Music Key rather than rotating all credentials.
  Its repository is GPL-3.0.
- `sansenjian/qq-music-api` is an active TypeScript package with an MIT
  license, but it implements only initial QR login and documents manual Cookie
  replacement after expiry.

There is no maintained, standalone TypeScript/npm dependency that provides the
required complete refresh behavior. The implementation will use an internal
TypeScript client based on the independently observed wire contract. It will
not copy GPL source or introduce a Python, Go, Express, or bot runtime.

The refresh timing used by third-party projects ranges from 12 hours to nearly
three days. Those values are heuristics, not a Tencent guarantee. This design
uses a conservative 20-hour renewal target plus reactive refresh and retry.

## Scope

### In Scope

- Refresh QQ login credentials through the QQ Music login service.
- Merge every rotated credential into the existing Cookie.
- Persist refreshed credentials without changing the account profile.
- Proactively refresh while the application is running.
- Refresh and retry once after an authenticated request reports
  `QQMusicAuthError`.
- Coalesce concurrent refresh attempts.
- Preserve the account on transient, rate-limit, malformed-response, and
  endpoint-specific failures.
- Prevent an old refresh result from overwriting a newer login or logout.
- Add sanitized diagnostics and focused automated tests.

### Non-Goals

- Do not change the browser-backed QR login flow.
- Do not retain or reuse the temporary Electron login session.
- Do not add a new runtime dependency or external refresh service.
- Do not change QQ recommendation layouts or public renderer IPC contracts.
- Do not promise renewal while the application is not running.
- Do not expose a manual refresh control in the UI.
- Do not treat third-party refresh intervals as an official QQ Music contract.

## Architecture

Add a credential refresh service under the existing QQ Music main-process
module:

```text
authenticated QQ request
-> account service refresh coordinator
-> optional due refresh
-> recommendation service
-> QQMusicAuthError
-> forced refresh through music.login.LoginServer/Login
-> atomically persist rotated Cookie
-> retry the original request once
```

The account service remains the owner of account state and logout decisions.
The credential service owns only Cookie validation, refresh request
construction, response validation, and Cookie merging.

The refresh service is injected into `createQQMusicAccountService`, following
the existing injected login and recommendation service pattern. Network and
clock functions remain injectable so the behavior can be tested without real
credentials or network access.

## Credential Refresh Service

Create `src/main/modules/qqMusic/credential.ts` with a factory equivalent to:

```ts
interface QQMusicCredentialService {
  refresh: (cookie: string) => Promise<string>
  getRefreshDueAt: (cookie: string) => number | null
}
```

The exact public names may follow local conventions, but the boundary must
remain limited to an input Cookie and a newly merged output Cookie.

### Required Input

The QQ login refresh request requires:

- `uin` or `qqmusic_uin`
- `qqmusic_key` or `qm_keyst`
- `psrf_qqopenid`
- `psrf_qqaccess_token`
- `psrf_qqrefresh_token`

It also forwards these values when present:

- `psrf_qqunionid`
- `psrf_access_token_expiresAt`
- `psrf_musickey_createtime`
- `euin`
- `guid` or the existing deterministic fallback GUID
- `wid`
- refresh-key fields returned by QQ Music

Missing required values produce a sanitized `unavailable` refresh error. They
must not be logged and do not by themselves authorize account deletion.

### Request Contract

Send one POST request to:

```text
https://u.y.qq.com/cgi-bin/musicu.fcg
```

The JSON payload uses:

```text
module: music.login.LoginServer
method: Login
```

The login parameters include QQ Music app ID `100497308`, access token,
refresh token, Music Key, UIN/music ID, open ID, union ID when available,
expiry metadata, and `forceRefreshToken: 0`.

The `comm` object follows the existing desktop QQ request identity and includes
the current Music Key and PSRF fields. The request has a ten-second deadline,
uses the existing QQ Music desktop origin and referer, and sends the current
Cookie.

The implementation must not retry the refresh endpoint internally. A caller
may schedule a later refresh after a transient failure, but one logical refresh
attempt sends at most one network request.

### Response Contract

A successful response requires both the top-level code and the named module
code to be zero, plus a non-empty returned Music Key.

Merge non-empty response fields into the original Cookie:

- `refresh_token` -> `psrf_qqrefresh_token`
- `access_token` -> `psrf_qqaccess_token`
- `openid` -> `psrf_qqopenid`
- `unionid` -> `psrf_qqunionid`
- `musickey` -> both `qqmusic_key` and `qm_keyst`
- `musickeyCreateTime` -> `psrf_musickey_createtime`
- access-token expiry -> `psrf_access_token_expiresAt`
- returned music ID -> existing UIN aliases when present
- `encryptUin` -> `euin`
- returned refresh-key and login-type fields when present

All unrelated Cookie pairs are preserved. Empty, missing, or zero-like
response fields must not overwrite a usable existing value.

Cookie parsing and merging extend the helpers in `qqMusic/auth.ts`. Tests must
cover values containing `=`, duplicate names, malformed pairs, and the
preservation of unrelated cookies.

## Refresh Error Classification

The credential service returns sanitized typed failures:

```ts
type QQMusicCredentialRefreshErrorKind =
  | 'invalid'
  | 'unavailable'
  | 'transient'
```

- `invalid`: the refresh module explicitly returns authentication code `1000`,
  `104400`, or `104401`.
- `unavailable`: the saved Cookie does not contain the fields required to
  attempt refresh.
- `transient`: timeout, network failure, non-2xx HTTP response, parse failure,
  rate limiting, account/device restrictions, or any unrecognized response.

Only `invalid` permits automatic account clearing. Upstream messages, response
bodies, Cookies, tokens, and complete request URLs never cross this error
boundary.

## Account-Service Integration

`createQQMusicAccountService` owns one in-flight refresh promise and one
scheduled-renewal timer.

### Single-Flight Refresh

When several recommendation requests fail together, the first request starts
refresh and the others await the same promise. No second refresh may start
until the first settles. This prevents rotating refresh tokens from being used
concurrently and prevents an older response from overwriting a newer response.

Every refresh captures the account Cookie and `updatedAt` before its network
request. It persists the merged Cookie only if both values still match the
current store entry. A scan login, logout, or another committed refresh makes
the older result stale. A stale result is discarded.

On successful persistence:

- keep the existing profile;
- replace only the Cookie;
- set `updatedAt` to the current clock;
- schedule the next proactive refresh from the new Music Key creation time.

### Authenticated Request Policy

For each authenticated request:

1. If renewal is due, await the shared refresh attempt.
2. If due refresh succeeds, execute the request with the persisted new Cookie.
3. If due refresh is transient or unavailable, still try the request with the
   current Cookie.
4. If the request succeeds, return normally.
5. If it throws `QQMusicAuthError` and this call has not already attempted
   refresh, force one shared refresh.
6. If that forced refresh succeeds, invoke the original request callback once
   more.
7. If preflight refresh was already attempted, do not immediately send a
   second refresh request. A business request that failed after successful
   preflight already used the refreshed Cookie; a transient or unavailable
   preflight failure uses the normal scheduled backoff.
8. Return the retry result or propagate its error. Never retry a second time.

A `QQMusicAuthError` from a recommendation endpoint is evidence that refresh
may be needed, not proof that the account is invalid. If refresh is transient
or unavailable, preserve the account and propagate a safe request error. If a
request still returns `QQMusicAuthError` after successful refresh, preserve the
account because the successful login refresh is stronger evidence than the
business endpoint's ambiguous `1000`.

If the refresh endpoint returns an `invalid` error, clear the account only
when the captured Cookie and `updatedAt` still match the current account.

### Proactive Renewal

Use `psrf_musickey_createtime` as a Unix-second timestamp. Renewal is due 20
hours after that timestamp.

- Schedule the timer when the account service first loads a valid account.
- Reschedule after scan login and successful refresh.
- Cancel the timer on logout or confirmed invalidation.
- If the application resumes after the due time, run refresh immediately.
- After a transient scheduled failure, preserve the account and retry after
  one hour.
- If the timestamp or required refresh fields are missing, rely on reactive
  refresh and do not create a tight retry loop.
- The timer must not keep the Node/Electron process alive by itself.

This schedule improves continuity while the application is open. After a long
period with the application closed, the first authenticated request still
attempts refresh before the business request when the stored timestamp is due.

## Diagnostics And Security

Diagnostics use fixed fields only:

- trigger: `scheduled`, `preflight`, or `auth-error`
- outcome: `success`, `invalid`, `unavailable`, `transient`, or `stale`
- optional HTTP status class or fixed response-code category

Diagnostics must not contain:

- Cookie strings or individual token values
- QR or OAuth secrets
- response bodies or upstream messages
- full URLs with query parameters
- request payloads

The persistent store remains the only credential owner. Renderer IPC continues
to expose only login status and profile data.

## Module Changes

### `src/main/modules/qqMusic/credential.ts`

- Build and execute the refresh request.
- Parse and validate refresh responses.
- Classify failures.
- Merge rotated values into the existing Cookie.
- Calculate the 20-hour renewal deadline.

### `src/main/modules/qqMusic/auth.ts`

- Extend Cookie merging helpers so an existing Cookie can be overlaid with
  rotated values without losing unrelated pairs.
- Keep secret redaction behavior and add coverage for refresh diagnostics.

### `src/main/modules/qqMusic/index.ts`

- Inject the credential service.
- Add the single-flight refresh coordinator.
- Add proactive scheduling and retry backoff.
- Change `runAuthenticatedRequest` to refresh and retry once.
- Restrict automatic account clearing to confirmed invalid refresh results.
- Preserve the existing stale-account comparison around every store update.

### Existing Recommendation Services

Keep their current `QQMusicAuthError` signaling contract. They continue to read
the Cookie dynamically through `getCookie`, so a retried callback automatically
uses the newly persisted Cookie.

No renderer or IPC contract changes are required.

## Testing Strategy

Implementation follows test-driven development and the repository's focused
Node-script test pattern.

### Credential Service Tests

- Required fields produce the expected refresh payload without exposing their
  values in errors or diagnostics.
- A valid response rotates all supported fields.
- Unrelated cookies and values containing `=` survive the merge.
- Empty response fields do not erase existing values.
- Top-level and module-level success are both required.
- Codes `1000`, `104400`, and `104401` classify as `invalid`.
- Rate limits, unknown codes, HTTP failures, timeouts, and malformed JSON
  classify as `transient`.
- Missing required fields classify as `unavailable` without network access.
- Renewal becomes due at the 20-hour boundary.

### Account Service Tests

- One auth error refreshes and retries the request once.
- A successful retry returns its result.
- A failed retry is not attempted again and does not clear the account.
- One business call sends at most one refresh request even when both preflight
  and the business endpoint fail.
- Concurrent recommendation failures share one refresh request.
- Successful refresh preserves the profile and persists the rotated Cookie.
- Transient and unavailable refresh failures preserve the account.
- Confirmed invalid refresh clears only the matching account snapshot.
- A refresh result cannot overwrite a newer scan login or logout.
- Due refresh runs before the business request.
- A transient scheduled failure uses the one-hour backoff.
- Successful refresh reschedules from the new creation timestamp.
- Logout cancels the scheduled timer.

### Regression Verification

- Run all focused QQ Music login, browser-auth, recommendation, playlist,
  renderer-account, IPC, and security-boundary scripts.
- Run focused ESLint on touched TypeScript files.
- Run the main-process production build.
- Start the development application and verify:
  - the current QQ account remains logged in;
  - QQ home, daily, guess-like, brush-mode, and playlist-detail requests work;
  - concurrent recommendation loading performs at most one refresh;
  - no credential value appears in logs.

A real refresh verification may rotate the user's current credentials. It must
be performed only after atomic persistence is implemented, and the result must
be written to the account store before any subsequent authenticated request.

## Acceptance Criteria

1. QQ Music credentials are proactively refreshed while the application runs.
2. The first authenticated request after an overdue restart attempts refresh
   before calling the business endpoint.
3. Every successful refresh persists all returned rotating credentials while
   preserving unrelated Cookie pairs and the account profile.
4. Concurrent recommendation requests cause at most one refresh request.
5. An authenticated request is retried at most once after successful refresh.
6. A recommendation endpoint's `code == 1000` cannot directly clear the
   account.
7. Only refresh codes `1000`, `104400`, or `104401` may automatically clear the
   matching saved account.
8. Transient, unavailable, rate-limited, and ambiguous failures preserve the
   account.
9. A stale refresh cannot overwrite a newer login or logout.
10. No credential, Cookie, response body, or OAuth secret is written to logs or
    exposed through renderer IPC.
11. Existing browser-backed QQ login and recommendation behavior continue to
    pass their focused regression tests.
