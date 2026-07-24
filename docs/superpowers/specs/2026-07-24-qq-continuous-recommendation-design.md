# QQ Music Continuous Recommendation Design

## Goal

Turn QQ Music "Guess You Like" playback from a single static batch into a continuous personalized radio queue. Playback should request and append another QQ Music batch before the current queue ends, continue working after the user leaves the QQ recommendation page, and preserve the existing QQ account and temporary-list isolation guarantees.

This design extends the QQ recommendation page design. It supersedes only that design's statement that playlist playback behavior remains unchanged.

## Confirmed Behavior

- The first activation starts with the current personalized QQ Music recommendation batch.
- While the QQ queue is active, reaching two or fewer songs after the current song triggers a continuation request.
- New songs are appended to the active temporary list without restarting or changing the current song.
- Songs already present anywhere in the current QQ recommendation session are not appended again.
- Leaving the QQ recommendation page does not stop queue replenishment.
- At most one continuation request may be active at a time.
- A continuation failure keeps the current queue intact. Later track changes or the final track boundary retry the request.
- If continuation still fails at the end of the queue, the existing player mode remains authoritative. For example, list-loop mode may wrap the current queue while a later boundary provides another retry opportunity.
- QQ account changes, explicit QQ logout, switching away from the QQ temporary list, or starting a new QQ recommendation session invalidates stale continuation work.
- A late response created for an old account or queue generation cannot append songs or replace the current temporary list.

## QQ Request Semantics

The main-process QQ song service continues to call `https://u.y.qq.com/cgi-bin/musicu.fcg` with `mb_track_radio_svr.get_radio_track` and radio ID `99`.

- Initial batch: `firstplay: 1`
- Continuation batch: `firstplay: 0`
- Requested batch size: `num: 15`

The renderer-to-main IPC operation accepts whether the request is an initial or continuation request. The main process converts that boolean into the numeric `firstplay` field. Existing callers that omit the option retain initial-batch behavior for compatibility.

QQ Music may return fewer than 15 usable tracks. Normalization and queue deduplication therefore treat an empty or all-duplicate continuation response as a non-destructive no-op rather than replacing the queue.

## Architecture

### Global Queue State

Move QQ recommendation queue ownership out of the route-scoped playback composable into a renderer store module parallel to the existing NetEase private FM store.

The module owns:

- the accumulated normalized queue;
- whether QQ continuous recommendation mode is active;
- the owning QQ account key;
- a monotonically increasing generation used to reject stale work;
- the active initial or continuation promise;
- synchronization of the accumulated queue into `LIST_IDS.TEMP` using `tx__qq_guess_like` as the temporary-list metadata ID.

Queue actions receive or snapshot the current QQ account key at their public boundary. The QQ account store resets the queue when its committed account identity changes or logout succeeds. This avoids an import cycle while ensuring logout works even when the QQ recommendation route is not mounted.

### Page Integration

The QQ recommendation page remains responsible for presentation, login controls, and card activation. Its data and playback composables become adapters over the global queue:

1. Page/account initialization prepares the initial batch for card artwork and text.
2. Card activation enters QQ continuous recommendation mode, installs the accumulated queue into the temporary list, clears stale played-list state, and starts at index zero.
3. Pause and resume continue to operate on the active QQ temporary list without fetching another initial batch.
4. Route unmount removes only page listeners. It does not reset the global QQ queue or disable continuous playback.

### Player Integration

The global player invokes the QQ queue guard in the same two places used by private FM:

- after the current play item changes, to prefetch when two or fewer queue items remain;
- on media end, before selecting the next item, so a just-in-time continuation can be appended before `playNext(true)` resolves the next index.

The guard returns immediately unless all of the following are true:

- QQ continuous recommendation mode is active;
- the player uses `LIST_IDS.TEMP`;
- `tempListMeta.id` is `tx__qq_guess_like`;
- the current QQ account key matches the queue owner;
- the current track belongs to the accumulated queue;
- two or fewer tracks remain after the current track.

Switching to any other list disables QQ continuous mode but does not alter that other list.

## Continuation Flow

1. Snapshot the account key and queue generation.
2. Reuse the current in-flight continuation promise when one exists for that snapshot.
3. Request a continuation batch with `firstplay: 0`.
4. Normalize the response in the main process as today.
5. In the renderer, reject the response if account, generation, player list, or temporary-list ownership changed.
6. Filter songs whose IDs already exist in the session queue.
7. Append novel songs to the queue.
8. Rewrite the QQ temporary list with the accumulated queue while preserving the current song by ID.
9. Clear the in-flight marker in `finally`, allowing a later retry after failure or an all-duplicate response.

## Error Handling

- Authentication expiry keeps the existing main-process behavior: clear only the invalid QQ account and propagate a safe failure.
- Network, timeout, malformed-response, empty-batch, and all-duplicate results never erase the current queue.
- Background continuation errors are logged without exposing Cookie, UIN request data, OAuth codes, or raw QQ response bodies.
- A failed prefetch does not display a blocking page error after playback has already started.
- Initial-load failure remains visible on the QQ recommendation card and remains retryable through card activation.

## Alternatives Rejected

### Route-Scoped Continuation

Keeping continuation inside `QQRecommend` would require the page to remain mounted. Navigation to another page would silently stop replenishment while audio continues, so this does not satisfy continuous playback.

### Replace the Queue at End

Replacing the entire temporary list after the last track is simpler, but it creates an audible request boundary, risks restarting at index zero, and makes late-response races more destructive.

### Timer-Based Polling

Periodic polling would request recommendations when the user is paused or far from the queue end. Track-boundary prefetch is deterministic and uses less network traffic.

## Testing

Follow the repository's Node script test pattern and write each behavior test before its implementation.

Main-process tests cover:

- omitted request options use `firstplay: 1`;
- continuation requests use `firstplay: 0`;
- the requested batch size remains 15;
- authentication expiry and malformed responses retain their current behavior.

Renderer queue tests cover:

- entering QQ mode installs and starts the initial queue;
- two remaining tracks trigger exactly one continuation request;
- more than two remaining tracks do not request a continuation;
- concurrent guard calls share one request;
- novel songs append in response order;
- duplicate and all-duplicate responses do not corrupt the queue;
- a failed request preserves the queue and a later boundary retries;
- route unmount does not disable continuous mode;
- leaving the QQ temporary list disables continuous mode;
- account change, logout, and generation change reject stale responses;
- a continuation appended during the media-ended path is visible before next-track selection.

Regression verification covers the existing QQ login, account persistence, QQ recommendation page, playback card, URL-provider behavior, focused ESLint checks, and main/renderer production builds.

## Acceptance Criteria

1. Starting QQ "Guess You Like" can continue beyond the first server batch without manual refresh.
2. The next batch is normally available before the current queue reaches its final track.
3. Continuous recommendation keeps working after navigation away from the QQ recommendation page.
4. A transient continuation failure does not clear or replace playable songs and is retried at a later boundary.
5. No song ID repeats within one active QQ recommendation session unless QQ returns no novel songs and the player's configured loop mode wraps the existing queue after repeated request failure.
6. Stale responses from a previous account, queue generation, or temporary-list owner cannot mutate the active queue.
7. Existing QQ login persistence, explicit logout behavior, and NetEase playback behavior remain unchanged.
