# QQ Music Recommendation Feedback Design

**Date:** 2026-07-29

**Status:** Approved direction; implementation pending written-spec review

## Problem

LX Music adds a NetEase track to the signed-in NetEase account when any
renderer entry point adds that track to the local Love list. QQ Music tracks
do not receive the same account-side update. Adding a QQ track to the local
Love list therefore leaves the signed-in QQ Music account's "I Like" list
unchanged.

QQ Music's Daily 30 playback also lacks the two recommendation feedback
actions exposed by the QQ Music desktop client:

- add the current track to "I Like" and increase related recommendations;
- dislike the current track and reduce related recommendations.

The existing QQ Music account service already owns login state, credential
refresh, authenticated retry, recommendation loading, and Daily 30 playback.
The implementation must extend those boundaries instead of creating another
credential path.

## Capture Evidence

The Fiddler capture `qm4.saz` recorded the QQ Music desktop client while a user
performed the relevant actions. The capture remains outside the repository
because it contains account credentials.

The business requests appeared in this order:

| Context | Module and method | Business parameters | Result |
| --- | --- | --- | --- |
| Daily 30, add heart | `music.musicasset.PlaylistDetailWrite/AddSonglist` | `dirId=201`, account TID, song ID and type | `retCode=0` |
| Daily 30, remove heart | `music.musicasset.PlaylistDetailWrite/DelSonglist` | `dirId=201`, account TID, song ID and type | `retCode=0` |
| Daily 30, add heart again | `music.musicasset.PlaylistDetailWrite/AddSonglist` | same fields | `retCode=0` |
| Daily 30, crossed heart | `music.feedback.FeedbackBlack/AddDislike` | current song ID | `Retcode=0` |
| Ordinary QQ playlist, add heart | `music.musicasset.PlaylistDetailWrite/AddSonglist` | `dirId=201`, account TID, song ID and type | `retCode=0` |

The client sent playback, exposure, and listening reports near these actions.
It did not send another positive recommendation business request. QQ Music
uses the "I Like" write as the positive recommendation signal.

The capture also confirms that the crossed-heart action uses
`music.feedback.FeedbackBlack`, not
`music.recommend.UserProfileSettingSvr`.

The reference `QQMusicApi` repository exposes the same operations. Its
`like_song` method calls `AddSonglist` with `dirId=201`, and its authenticated
round-trip test uses `tid=0`. The account-specific TID from the capture must
not be stored in LX Music or copied into requests for another account.

## Goals

1. Sync every QQ Music track added to the local Love list to the signed-in QQ
   Music account's "I Like" list.
2. Apply the same global entry-point rule used by the existing NetEase sync.
3. Add the crossed-heart action while LX Music plays the signed-in account's
   QQ Daily 30 queue.
4. Send both writes through the existing QQ Music credential refresh and
   authenticated retry path.
5. Keep local favorites usable when QQ Music is signed out or its write fails.
6. Skip a disliked Daily 30 track after QQ Music accepts the feedback.

## Non-Goals

- Syncing local uncollect operations to QQ Music with `DelSonglist`.
- Adding QQ account sync to the LX global dislike-rule list.
- Replaying QQ Music analytics, exposure, play-history, or listening reports.
- Hard-coding the account TID found in the capture.
- Synchronizing existing local favorites in bulk.
- Adding settings for enabling or disabling account-side favorite sync.
- Adding positive or negative feedback controls to ordinary QQ playlists.

## Design

### 1. QQ Music Feedback Service

A focused main-process module will implement the two authenticated writes:

```ts
interface QQMusicFeedbackService {
  likeMusic: (musicInfo: LX.Music.MusicInfo_tx) => Promise<void>
  dislikeMusic: (musicInfo: LX.Music.MusicInfo_tx) => Promise<void>
}
```

`likeMusic` sends one QQ Music module request:

```json
{
  "module": "music.musicasset.PlaylistDetailWrite",
  "method": "AddSonglist",
  "param": {
    "dirId": 201,
    "tid": 0,
    "bFmtUtf8": true,
    "v_songInfo": [
      {
        "songId": 123,
        "songType": 0
      }
    ]
  }
}
```

`dislikeMusic` follows the captured desktop request:

```json
{
  "module": "music.feedback.FeedbackBlack",
  "method": "AddDislike",
  "param": {
    "Songs": [
      {
        "ID": "123"
      }
    ]
  }
}
```

The service will use the current desktop-style QQ Music common request fields,
cookie, timeout handling, and sanitized error messages. It will accept
`fetchImpl` and timeout dependencies so tests can exercise the real request
construction without making network calls.

The service will require a numeric QQ song ID. It will resolve the ID from
`musicInfo.meta.id` first, then accept a numeric `musicInfo.meta.songId` from
older QQ SDK records. It will use `musicInfo.meta.songType` when present and
fall back to `0`. Missing numeric IDs will reject before any request is sent.

`normalizeQQMusicTracks` will retain the upstream track type in the QQ music
metadata. The shared QQ music metadata type will add an optional
`songType?: number` field so existing stored records remain compatible.

The service will accept a response only when the global code, module code, and
operation result code all equal zero. QQ authentication codes will raise the
existing `QQMusicAuthError`; network, malformed-response, and business errors
will use a generic message that excludes request headers, cookies, and
credentials.

### 2. Account-Service Ownership

`createQQMusicAccountService` will receive the feedback service beside the
song, Daily 30, home recommendation, and playlist-detail services.

The account service will expose:

```ts
likeMusic(musicInfo: LX.Music.MusicInfo_tx): Promise<void>
dislikeMusic(musicInfo: LX.Music.MusicInfo_tx): Promise<void>
```

Both methods will call the existing `runAuthenticatedRequest`. This preserves
credential preflight refresh, one retry after an authentication failure,
refresh deduplication, and account clearing for invalid credentials.

`likeMusic` will return without a request when no QQ account is signed in.
This matches the NetEase favorite-sync behavior and keeps local collection
independent from account state. Daily 30 requires a signed-in account.
`dislikeMusic` will reject if that account disappears before the request.

The singleton service assembly will construct one feedback service with the
same `getCookie` callback used by the existing QQ Music services.

### 3. IPC Boundary

Two main-window IPC handlers will expose the account-service methods:

```ts
qq_music_like_music
qq_music_dislike_music
```

Renderer helpers will clone music records before invoking those handlers. The
main process will reject non-QQ records even if a renderer calls an IPC helper
with the wrong source.

### 4. Global Love-List Sync

The renderer list action remains the single boundary for local favorites.
After `addListMusicsAction` adds records to `LIST_IDS.LOVE`, it will split the
added records by source:

- `wy` records keep the existing NetEase account sync;
- `tx` records invoke the new QQ Music account sync;
- other sources stay local.

The QQ sync will clone records before IPC and send independent writes for each
QQ track. It will run in the background by default, matching the NetEase path.
Remote failure will log a sanitized warning and will not remove the local
favorite or reject the completed local list update.

The existing NetEase-only wait and skip options remain unchanged. The QQ path
will add matching internal options only where a test or existing import flow
needs deterministic waiting. This work will not rename the public options or
refactor unrelated list behavior.

Local uncollect continues to remove the LX Music record only. The capture
proves that `DelSonglist` exists, but the agreed scope follows the current
NetEase one-way add behavior.

### 5. Daily 30 Negative Feedback

The modern play bar already places the local Love button next to the current
track. While the active temporary list belongs to the signed-in account's QQ
Daily 30 session, the same control group will show a crossed-heart button next
to it. Other queues will not show that button.

The button will use a familiar crossed-heart icon, an accessible label that
describes reducing related recommendations, and a pending state that prevents
duplicate requests. It will not add visible instructional text.

On click, the renderer will capture the current QQ music record and the active
Daily 30 generation, then await `qq_music_dislike_music`. If the request
succeeds and the account, generation, and current track still match, the
Daily 30 store will remove the rejected track from its cached queue and the
temporary playback list, then continue with the next available track. A stale
response from an older account, queue generation, or track will not mutate the
current session.

A failed request will keep the track and playback state unchanged. The button
will leave its pending state and log a sanitized warning. The action will not
write an LX Music dislike rule, because that rule filters matching names and
singers across sources rather than recording QQ recommendation feedback.

### 6. Concurrency and Account Changes

Favorite sync tasks capture cloneable track data and enter the account service
at invocation time. The account service's existing generation and
same-account checks protect credential refresh from overwriting a newer login.

Daily 30 negative feedback adds renderer-side identity checks because the user
can change tracks or accounts while the write is in flight. The renderer will
discard stale success results instead of removing a track from the new queue.
The pending flag is scoped to the submitted track, so a track change does not
disable feedback for the new current track.

## Error Handling

The main process will classify QQ authentication response codes with the
existing `QQMusicAuthError`. The account service may refresh credentials and
retry once. It will propagate the final failure without including cookies,
request bodies, or account identifiers.

The global favorite path treats remote sync as a side effect. Local list data
is authoritative for LX Music and stays committed after a remote failure.

The Daily 30 dislike path waits for QQ Music before it changes the queue. A
network or business failure leaves the user on the current track, which avoids
showing a successful negative action that the account did not record.

## Test Strategy

Implementation will follow red-green-refactor.

### Feedback Service

Tests will prove that:

- `likeMusic` sends `AddSonglist` with `dirId=201`, `tid=0`, the numeric song
  ID, and the stored or default song type;
- `dislikeMusic` sends `AddDislike` with the captured `Songs` shape;
- both methods use the current account cookie without exposing it in errors;
- missing cookies raise an authentication error and missing numeric song IDs
  fail before fetch;
- global, module, and operation result failures reject;
- QQ authentication codes use `QQMusicAuthError`;
- timeouts abort and produce sanitized errors.

### Account and IPC

Tests will prove that:

- both feedback methods pass through `runAuthenticatedRequest`;
- due credentials refresh before the write;
- one authentication failure refreshes and retries once;
- invalid credentials clear only the matching account;
- no signed-in account makes background favorite sync a no-op;
- IPC names, handlers, and renderer helpers route cloneable QQ records.

### Renderer Behavior

Tests will prove that:

- adding mixed-source records to Love invokes NetEase sync for `wy`, QQ sync
  for `tx`, and no account write for other sources;
- QQ sync failure does not roll back the local Love entry;
- the crossed-heart button appears only for the active signed-in QQ Daily 30
  queue;
- duplicate clicks produce one request;
- accepted feedback removes the matching track and advances playback;
- failed or stale feedback does not remove a track or advance playback;
- the negative action does not add an LX Music dislike rule.

Existing QQ login, credential refresh, Daily 30, home recommendation, list,
player, and lint checks remain part of the regression suite.

## Verification

Focused Node test scripts will cover the feedback service, account retry, IPC,
global favorite sync, and Daily 30 renderer behavior. The implementation will
then run the existing QQ Music suites, TypeScript build checks used by the
project, and `npm run lint`.

The capture file will never enter source control. Tests will use synthetic
cookies, account IDs, song IDs, and responses.

## Delivery

The implementation should produce reviewable commits for the authenticated QQ
feedback service and renderer integration. Each production change must follow
a failing focused test. No package dependency is required.
