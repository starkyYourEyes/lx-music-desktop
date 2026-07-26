# QQ Music Guess-Like API Selector Design

## Goal

Use the QQ Music desktop-client radio API as the default source for "Guess You Like", keep the existing web radio API available, and let users select either implementation in Settings.

## Confirmed Behavior

- Settings exposes two explicit choices: new API and legacy API.
- New installations and existing installations without the setting use the new API.
- Selecting an API strictly uses that API. A failed new request does not silently fall back to the legacy API, and vice versa.
- Changing the setting invalidates the current QQ Guess You Like queue before the next load or continuation request, so one queue never mixes tracks returned by different APIs.
- QQ Daily 30, QQ account login, recommendation cards, playlist detail navigation, and playback controls are unchanged.

## Request Contracts

### New API

The new path sends a signed `POST` request to `https://u6.y.qq.com/cgi-bin/musics.fcg`.

- Request key: `music.radioProxy.MbTrackRadioSvr.get_radio_track`
- Module: `music.radioProxy.MbTrackRadioSvr`
- Method: `get_radio_track`
- Radio ID: `99`
- Response tracks: `<request-key>.data.tracks`
- Initial and continuation requests both use the selected new endpoint; continuation remains a separate call so the existing continuous queue can append another personalized batch.
- The `sign` query parameter is generated from the exact serialized body using the same accepted QQ signing algorithm already used by Daily 30.
- Authentication and device fields are derived from the persisted QQ cookie. Missing stable device identifiers use deterministic per-account fallbacks.

### Legacy API

The legacy path remains the current `POST https://u.y.qq.com/cgi-bin/musicu.fcg` request.

- Module: `mb_track_radio_svr`
- Method: `get_radio_track`
- Radio ID: `99`
- Initial request: `firstplay: 1`
- Continuation request: `firstplay: 0`
- Response tracks: `songlist.data.tracks`

## Settings And IPC

Add `recommend.qqGuessLikeApiVersion` to the application setting type with values `'new' | 'legacy'` and default `'new'`. The recommendation settings page renders two existing `base-checkbox` radio-style controls so the setting matches the rest of the application.

The renderer includes the current setting value in every Guess You Like IPC request. Main-process types and handlers pass the value through unchanged to the QQ song service. The service chooses exactly one request implementation based on that value.

## Queue Isolation

The renderer queue stores an API-version snapshot alongside its account snapshot. Before initial load, entry, or continuation, it compares the current setting with the queue snapshot. A mismatch resets the queue generation and starts a new source session. Late responses from the previous API fail the existing generation check and cannot mutate the new queue.

## Errors And Privacy

- Login expiry remains an authentication error and preserves the current account invalidation behavior.
- HTTP failures, timeout, response code failures, and malformed responses produce a generic request failure without including cookies, keys, tokens, request bodies, signatures, UINs, GUIDs, or raw payloads.
- No automatic cross-API fallback occurs.

## Testing

- Main service tests prove the new API is the default, the body and response path match the desktop contract, the exact body hash forms the signature suffix, and selecting legacy preserves the existing request.
- Renderer queue tests prove the setting value is sent for both initial and continuation calls and that a version change rejects stale work and starts a fresh queue.
- Settings wiring tests prove the type, default, localized labels, and two controls exist.
- Existing QQ account, IPC, Daily 30, continuous playback, recommendation page, and production type checks remain green.

## Acceptance Criteria

1. The new QQ desktop-client API is used by default for Guess You Like.
2. Users can select new or legacy in Settings, and the selection persists.
3. The selected implementation is used without hidden fallback.
4. Changing versions cannot append one API's results to the other API's active queue.
5. Existing QQ continuous playback and non-Guess-Like features continue to work.
