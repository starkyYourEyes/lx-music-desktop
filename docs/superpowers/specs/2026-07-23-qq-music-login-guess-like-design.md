# QQ Music Login and Guess You Like Design

## Goal

Add QQ Music QR login, persistent account state, and account-specific "猜你喜欢" recommendations to the desktop app. QQ Music and NetEase accounts remain independent and may both stay logged in. The existing top-left avatar becomes the shared account entry point.

## Confirmed Behavior

- Clicking the top-left avatar opens a compact account menu with separate QQ Music and NetEase rows.
- QQ Music and NetEase can be logged in at the same time. Logging in or out of one provider does not change the other provider.
- QQ Music uses QR login based on the MIT-licensed `sansenjian/qq-music-api` implementation.
- A successful QQ login persists across application restarts, matching the current NetEase account lifecycle.
- Closing the application does not clear the QQ Music Cookie.
- Explicitly choosing "退出 QQ 音乐账号" clears the locally stored QQ Music account and Cookie.
- A normal network failure does not clear a stored account. A response that explicitly proves the credentials are invalid marks the account expired and clears the invalid Cookie.
- QQ Music "猜你喜欢" appears near the beginning of the existing recommendation home page and coexists with NetEase content.
- When logged in, the section supports playing one song, playing the complete section, local favorites, and requesting a fresh batch.
- When logged out, the section displays a QQ login entry by default.
- A recommendation setting lets the user choose between showing the logged-out entry and hiding the entire section. The default is to show it.
- The top-level avatar continues to show the NetEase avatar when one is available. Otherwise it shows the current LX default avatar. QQ login does not force a new top-level avatar.

## Non-Goals

- No manual Cookie input, display, copy, import, or export UI.
- No local Koa service or background QQ Music API server.
- No full dependency on `@sansenjian/qq-music-api`.
- No merging of QQ and NetEase credentials, profiles, recommendations, or logout actions.
- No synchronization of QQ credentials through the app sync system.
- No remote QQ Music favorite operation. The heart action in the recommendation section changes the app's local favorite list only.
- No redesign of the recommendation page or left navigation.

## Reference and License

The implementation references:

- Repository: `https://github.com/sansenjian/qq-music-api`
- Reference commit: `90b80c99257b343ed7acfe3006131a51de36b2b5`
- License: MIT
- Relevant source modules:
  - `src/services/apis/user/getQQLoginQr.ts`
  - `src/services/apis/user/checkQQLoginQr.ts`
  - `src/services/apis/recommend/getDailyRecommend.ts`
  - `src/services/apis/recommend/getPersonalRecommend.ts`
  - `src/util/loginUtils.ts`

Only the required login algorithms, Cookie handling, and request construction are adapted into this Electron application. The dependency itself is not added to `package.json` because its Koa/Axios service surface is unnecessary and increases Electron packaging risk.

Add `licenses/qq-music-api-MIT.txt` containing the upstream MIT notice. Adapted modules must include a short source comment with the repository and reference commit.

The current upstream branch exposes daily recommendation and private FM APIs, but it does not expose the historical radio request with QQ Music radio ID 99 as a dedicated route. The exact "猜你喜欢" request is therefore implemented directly with the same `musicu.fcg` request style:

```ts
{
  comm: {
    ct: 24,
    cv: 0,
  },
  songlist: {
    module: 'mb_track_radio_svr',
    method: 'get_radio_track',
    param: {
      id: 99,
      firstplay: 1,
      num: 15,
    },
  },
}
```

This endpoint requires a valid QQ Music Cookie for personalized results.

## Existing Architecture

The existing NetEase implementation provides the local pattern:

```text
renderer account store
-> typed renderer IPC helper
-> main-process renderer event handler
-> main-process NetEase module
-> data.json account record and upstream API
```

The top-left account popover currently handles only NetEase. The recommendation page and `useRecommendData` are NetEase-specific. The new QQ feature should follow the account pattern without turning the NetEase recommendation aggregate into a provider-neutral type.

## Recommended Architecture

Add a QQ Music account module parallel to the NetEase module:

```text
Aside account menu / QQ login panel / QQ recommendation section
-> QQ renderer store and typed IPC helpers
-> QQ renderer event handlers
-> QQ main-process account and recommendation module
-> QQ upstream APIs and main-process-only account storage
```

Keep QQ recommendation state in a focused QQ composable instead of adding QQ fields to `LX.Netease.HomeRecommendation`. The recommendation page combines the two rendered sections, but their loading and account rules remain separate.

## Security Boundary

The Electron main process owns all QQ authentication material:

- QR response `qrsig`
- `ptqrtoken`
- intermediate QQ OAuth Cookies
- final QQ Music Cookie
- OAuth redirect URLs that may contain authorization codes

The renderer receives only:

- a QR image Data URL
- an opaque application-generated login session ID
- a normalized login status and message
- a non-sensitive account summary
- normalized QQ Music song objects

The renderer never receives `qrsig`, OAuth Cookies, the final Cookie, or raw upstream response headers.

The main process keeps QR sessions in an in-memory map keyed by a random opaque ID. Each entry contains the upstream QR material and an expiry timestamp. Closing the panel stops renderer polling. Expired entries are removed by access-time checks and a short cleanup timer.

Logs and thrown IPC errors must redact Cookie headers, `qrsig`, OAuth authorization codes, and complete redirect locations. No debug logging from the referenced implementation is copied unchanged.

## Account Storage

Add `DATA_KEYS.qqMusicAccount` to the existing data store. The stored record follows the current NetEase lifecycle:

```ts
interface QQMusicAccountData {
  cookie: string
  profile: LX.QQMusic.Profile | null
  updatedAt: number
}
```

The profile contains only values needed by the UI, such as QQ `uin` and a display name. A profile lookup failure falls back to a generic "QQ 音乐账号" label; it does not expose the Cookie or block recommendation loading when the Cookie is otherwise valid.

Storage rules:

- QR success writes the complete merged QQ Music Cookie and account summary.
- Application shutdown does nothing to the stored record.
- Startup restores the record and returns the cached profile immediately when it is recent.
- A stale profile may be revalidated in the background.
- Transport failures preserve the stored record and last valid status.
- Explicit upstream authentication failure clears the invalid record.
- Explicit user logout clears the QQ record locally. A remote logout endpoint is not required.

QQ and NetEase use separate keys in the same main-process data store.

## Main-Process QQ Module

Create a focused main-process module with five public operations:

```ts
getAccountStatus(): Promise<LX.QQMusic.AccountStatus>
createLoginQr(): Promise<LX.QQMusic.LoginQr>
checkLoginQr(key: string): Promise<LX.QQMusic.LoginQrCheck>
logout(): Promise<void>
getGuessLikeSongs(): Promise<LX.Music.MusicInfo_tx[]>
```

### QR Creation

`createLoginQr` requests the QQ QR image and extracts `qrsig`. It calculates `ptqrtoken` using the referenced `hash33` algorithm, stores both values in a main-process QR session, and returns only the opaque session key and image.

### QR Polling and OAuth

`checkLoginQr` resolves the opaque session and maps QQ responses to stable application states:

- `waiting`: QR has not been scanned.
- `scanned`: scanned and waiting for mobile confirmation.
- `expired`: QR is invalid or the local session expired.
- `success`: QQ OAuth and QQ Music login completed.

On success, the module follows the referenced OAuth chain, collects all `Set-Cookie` values, deduplicates them by Cookie name, builds the final QQ Music Cookie, saves the account, and removes the QR session.

Cookie parsing must preserve values containing `=` and handle multiple `Set-Cookie` headers. Prefer the structured `Headers.getSetCookie()` API when available, with a tested fallback for the Electron runtime.

### Guess You Like Request

`getGuessLikeSongs` reads the stored Cookie and calls `https://u.y.qq.com/cgi-bin/musicu.fcg` with radio ID 99. It treats an absent account as a typed not-logged-in error.

The response normalizer produces existing `LX.Music.MusicInfo_tx` objects:

- stable `id` in the form `tx_<song MID>`
- `source: 'tx'`
- song name and formatted singer list
- formatted duration
- QQ song ID, song MID, media MID, album ID, album name, and artwork URL
- available quality metadata in the existing `meta.qualitys` and `meta._qualitys` shape

Malformed entries without a usable song MID or name are discarded. Duplicate song MIDs are removed while preserving upstream order.

## IPC Contract

Add QQ-specific names beside the current NetEase IPC names:

```text
qq_music_get_account_status
qq_music_login_qr_create
qq_music_login_qr_check
qq_music_logout
qq_music_get_guess_like_songs
```

Add corresponding typed wrappers in `src/renderer/utils/ipc.ts` and register a QQ renderer event module in the main window event index.

The IPC response types must not contain a Cookie field. A security regression test scans both type contracts and representative runtime results for credential fields.

## Renderer Account State

Add a QQ renderer store parallel to `src/renderer/store/netease.ts`:

- `accountStatus`
- `profile`
- `isLoggedIn`
- `isInitingQQMusicAccount`
- `isQQMusicAccountInited`
- `initQQMusicAccount`
- `setQQMusicAccountStatus`
- `logoutQQMusicAccount`

QQ and NetEase account initialization runs in parallel when the main layout mounts. Each provider has an independent initialization promise and failure state.

## Account Menu and Login Panel

Keep the existing 60px top-left avatar and popover position. Replace the single NetEase action with two provider rows:

- provider identity
- logged-in account label or "未登录"
- provider-specific login or logout action

The provider row action closes the popover before opening the login panel or performing logout. Both providers may display "已登录" simultaneously.

Generalize the existing recommendation login panel so its title, instruction, QR image, status, and refresh action are provider-specific. NetEase continues to say to scan with the NetEase app. QQ says to scan with mobile QQ and confirm on the phone.

Login remains hosted by the recommendation view to match the existing NetEase flow. From any current page, the account action navigates to `/recommend` with a provider-specific login query (`login=qq` or `login=netease`). The recommendation route watcher consumes and removes that query after opening the correct modal. A window event may update an already-mounted recommendation view immediately, but the route query is the reliable fallback and prevents an event from being lost during navigation.

QQ polling uses the same two-second cadence as NetEase. Closing the modal or leaving the owning view cancels the renderer timer. An expired QR stops polling until the user requests a new image.

## Recommendation Section

Add a QQ-specific recommendation composable that owns:

- current songs
- loading and refresh states
- last load error
- an in-memory cache keyed by QQ account identity
- initial load, forced refresh, login success, logout, and account expiry behavior

Render the section near the beginning of the recommendation home flow, after existing special cards and before the NetEase song and playlist sections.

Logged-in rendering reuses the existing song-grid presentation. The title is "猜你喜欢" with a small QQ Music source label. The section exposes:

- play or pause the complete section
- play or pause one song
- add or remove a song from the app's local favorite list
- request a new batch

Add a dedicated temporary list ID for QQ "猜你喜欢" playback. Extend the existing song-section playback helper so it can operate on this third list without duplicating player logic.

Include QQ songs in the recommendation love-status aggregate. The existing favorite-list implementation is source-neutral, so no QQ remote-like API is called.

Logged-out rendering follows the setting:

- `true`: show a compact section with "登录 QQ 音乐后获取猜你喜欢" and a login action.
- `false`: do not render the section.

The login action opens the QQ QR panel directly.

## Settings

Add a boolean setting:

```ts
'recommend.qqGuessLikeLoggedOutVisible': true
```

Wire it through the default settings, application setting type, three locale files, and `SettingRecommend.vue`. Use the existing binary setting control style. The setting affects only the logged-out placeholder; an authenticated QQ recommendation section is always shown.

## Cache and Refresh Rules

- Cache only normalized songs in renderer memory; do not persist recommendation payloads to disk.
- Key the cache by QQ account identity so switching accounts cannot display another account's recommendations.
- Initial page entry uses the current account cache when available.
- Login success bypasses the logged-out state and immediately loads personalized songs.
- Explicit refresh bypasses the memory cache and calls the upstream endpoint again.
- Logout or explicit account expiry removes the active QQ song cache and applies the logged-out visibility setting.
- A refresh failure keeps the last successful songs visible.

## Error Handling

### Login

- QR creation failure shows a retryable error in the modal.
- Pending and scanned states keep polling.
- Expiry stops polling and asks for a new QR.
- Transient polling failures keep the session and retry while it remains valid.
- Repeated or terminal OAuth failures stop polling and show a safe error without upstream URLs or credentials.

### Account Restore

- A network timeout does not convert a cached account into logged out.
- An explicit invalid-session response clears only the QQ account.
- NetEase state and recommendations remain unchanged after every QQ failure.

### Recommendations

- Loading without a QQ account returns a typed not-logged-in result and shows the configured logged-out state.
- A transient upstream error keeps cached songs and exposes refresh retry.
- A successful empty response shows an empty-state message rather than stale songs.
- Malformed individual songs are skipped; a malformed complete response is treated as a load error.

All QQ requests use bounded timeouts and abort their underlying fetch when possible.

## Testing Strategy

Implementation follows test-first development using the repository's existing Node test-script pattern.

### Main-Process Unit Tests

- `hash33` and QQ `g_tk` calculations match fixed vectors.
- multiple `Set-Cookie` headers merge by Cookie name without truncating values.
- QR sessions expose only opaque IDs and expire correctly.
- waiting, scanned, expired, and success upstream responses map to stable application states.
- login success persists the account; application restart restores it.
- transient validation failure preserves the account.
- explicit invalid credentials and explicit logout clear only the QQ account.
- song normalization creates valid `MusicInfo_tx` objects, removes malformed entries, and deduplicates song MIDs.

### Security Tests

- QQ IPC payloads contain no Cookie, `qrsig`, `ptqrtoken`, authorization code, or raw redirect URL.
- representative error and logging paths redact sensitive values.
- renderer modules do not import or read the main-process account store.
- QQ credentials are not added to settings, sync payloads, or renderer state.

### Renderer and Wiring Tests

- the account menu exposes independent QQ and NetEase actions and statuses.
- QQ login polling stops on close, expiry, success, and component disposal.
- login success refreshes account state and loads recommendations.
- the logged-out visibility setting defaults to true and supports both branches.
- the authenticated section supports play-all, single-song play, local favorites, and refresh.
- QQ and NetEase recommendation failures remain isolated.
- IPC names, typed wrappers, main handlers, types, defaults, and locale keys are all wired.

### Verification

- run focused QQ feature test scripts
- run the project TypeScript/build check
- run lint on touched files
- run existing recommendation, storage, and security regression scripts that overlap the change
- launch the Electron development build and manually verify account menu layout, QR states, recommendation rendering, playback, local favorites, settings, and application restart

The real personalized response cannot be fully automated without a user-owned QQ login. Final manual acceptance therefore requires scanning a QR in the running application and confirming that radio ID 99 returns account-specific songs.

## Acceptance Criteria

1. The avatar menu can show QQ Music and NetEase logged in simultaneously.
2. QQ QR login succeeds without exposing authentication material to the renderer.
3. Closing and reopening the application preserves QQ login.
4. Explicit QQ logout clears QQ state without changing NetEase state.
5. A logged-in QQ account receives normalized, playable "猜你喜欢" songs from radio ID 99.
6. The section can play all, play one, refresh, and change the app's local favorite list.
7. Logged-out users see the login entry by default and can hide it in recommendation settings.
8. Network and QQ API errors remain recoverable and do not remove valid cached data or NetEase content.
9. The upstream MIT notice and source attribution ship with the application.
