# QQ Music Home Recommend Debug Design

## Goal

Add the QQ Music homepage recommendation request represented by
`sansenjian/qq-music-api`'s `GET /getRecommend` endpoint to the existing QQ
Music integration. After a QQ account is signed in, request the raw upstream
payload once and print it to the renderer developer console for inspection.

This is a diagnostic integration. It does not add a visible JSON panel or use
the response to render production recommendation sections yet.

## Architecture

Keep the request inside the Electron main process, alongside the existing QQ
Music login and Guess You Like services. Reuse the persisted account Cookie
through the account-service boundary and expose the result through a dedicated
renderer IPC event.

The renderer must not receive or log the stored Cookie. It receives only the
QQ Music response payload.

## Upstream Request

Send one POST request to `https://u.y.qq.com/cgi-bin/musicu.fcg` with the same
batch modules used by `GET /getRecommend`:

- `category`: hot playlist categories.
- `recomPlaylist`: homepage recommended playlists.
- `playlist`: category `8`, page `1`, limit `40`.
- `new_song`: new songs of type `5`.
- `new_album`: area `1`, first `10` albums.
- `new_album_tag`: album area metadata.
- `toplist`: all charts.
- `focus`: homepage focus banners.

Use the existing QQ account Cookie and derived login UIN in the main-process
request. Apply the same timeout and HTTP/status validation conventions as the
Guess You Like request. Authentication failures must use the existing
`QQMusicAuthError` path so an expired account is cleared consistently.

The service returns the raw parsed JSON object without normalizing nested QQ
Music fields.

## IPC And Triggering

Add a dedicated `qq_music_get_home_recommend` IPC event and renderer helper.
The QQ recommendation page calls it after account initialization confirms a
signed-in account and after a login succeeds.

The page tracks the account key for which the diagnostic request was made so
normal reactive updates do not repeat the request. Switching accounts permits
one new request for the new account. Failed requests may be retried after the
page is re-entered or the account state changes.

## Console Output

On success, write one structured renderer log entry:

```ts
console.log('[QQ Music getRecommend]', response)
```

On failure, write a warning without credentials:

```ts
console.warn('[QQ Music getRecommend] request failed', error)
```

No Cookie, request headers, QR-login artifacts, or raw account UIN may be
included in either log entry.

## Error Handling

- Missing login state rejects with `QQMusicAuthError` before sending a request.
- HTTP failures and invalid QQ response status reject with descriptive errors.
- QQ authentication-expiry status uses `QQMusicAuthError` and the existing
  compare-and-clear account logic.
- Diagnostic failure must not block or replace the existing Guess You Like
  loading flow or display an error on the QQ recommendation page.

## Verification

- Add a focused service test that inspects the outgoing batch request and
  verifies the raw response is returned unchanged.
- Add IPC wiring assertions for the event, main handler, and renderer helper.
- Add page wiring assertions for the signed-in trigger and credential-free
  Console output.
- Run focused QQ Music tests, TypeScript checks, lint on changed source files,
  and affected production builds.
- Start the development application, complete or reuse QQ Music login, open
  developer tools, and inspect the real `[QQ Music getRecommend]` payload.

