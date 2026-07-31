# Playback Source Fallback Design

## Goal

Allow users to keep one primary playback API source and configure an ordered list of fallback playback API sources. When the primary source cannot produce a URL that the media element can load, playback automatically tries the fallback sources without changing the user's primary-source setting.

The feature applies to online audio URL resolution only. It does not change how lyrics, covers, or downloads select their data source.

## Terminology

- A **music platform** is a catalog source such as `kw`, `kg`, `tx`, `wy`, or `mg`. The existing cross-platform matcher finds equivalent song records on these platforms.
- A **playback API source** is the built-in or imported custom source selected in settings. It normally accepts a platform song record and returns an audio URL; a custom source may also expose the existing `local` action for missing-file recovery.
- The **primary source** is the existing `common.apiSource` selection.
- A **fallback source** is a user-selected playback API source tried after the preceding source has exhausted its candidates or encountered a source-level failure.

Fallback is source-first, not platform-first. For example, with primary source A and fallback source B, the attempt order is:

```text
A: original platform -> matched platform candidates
B: original platform -> the same matched platform candidates
```

## Confirmed Behavior

- When at least one playback API source is installed, the user selects one primary source and may select zero or more ordered fallback sources. An installation with no usable source keeps the existing no-source behavior and has an empty fallback list.
- The fallback list starts empty for new and upgraded installations.
- Importing a source, changing the primary source, or upgrading the app never adds a fallback automatically.
- The primary source cannot be added to the fallback list.
- Selecting a new primary source removes the same source from the fallback list if present.
- The previous primary source is not added to the fallback list.
- Fallback is scoped to one resolution session. A fallback success does not become the session-wide or persisted primary source, and a different song starts from the configured primary source again.
- A validated cached URL may be reused when the same song is played again. Cache reuse does not change the primary-source setting.
- Primary-source priority is stronger than requested-quality priority. Existing per-candidate quality selection runs within the current source before the next source is considered.
- Rate limiting and server-busy responses immediately advance the fallback flow. There is no 2-6 second delayed retry.
- Each playback API source gets at most 10 seconds for its complete attempt, including source initialization, URL requests, cross-platform candidates, and pre-play media validation. Explicit failures advance immediately.
- The complete source chain is not retried after all configured sources fail.
- A fallback success is silent. The UI reports an error only after the complete chain fails.
- The next-song preloader uses the same fallback flow as foreground playback.
- A local track whose file is unavailable uses the fallback flow when the existing local-track recovery logic resolves an online playback URL.
- WebDAV playback does not use playback API fallback.
- A URL that fails before `canplay` advances the active fallback flow. `canplay` is the commit boundary; an error after that event remains under the existing primary-only player refresh/error behavior in this phase.
- Settings are snapshotted when a resolution session starts. Editing source settings does not restart or mutate an in-flight session.

## Non-Goals

- Parallel source requests are not implemented in this phase.
- There is no automatic source reordering, health score, circuit breaker, or remembered preferred fallback.
- There is no fallback-source selection for downloads, lyrics, covers, or WebDAV.
- There is no user-facing notification or persistent player badge for a successful fallback.
- Mid-stream recovery from a different source is not implemented.
- Song matching quality and ranking are not changed.

## Configuration Model

Keep the current primary-source field and add two settings:

```ts
interface AppSetting {
  'common.apiSource': string
  'common.apiFallbackSources': string[]
  'common.apiFallbackMode': 'serial' | 'parallel'
}
```

Defaults:

```ts
{
  'common.apiFallbackSources': [],
  'common.apiFallbackMode': 'serial',
}
```

`parallel` is reserved for the later settings option requested for a future phase. The application must coerce any unsupported value, including a manually imported `parallel` value, to `serial` in this phase and must not display an unavailable parallel option.

Apply one shared normalizer when settings are loaded or changed and when the available source list changes. The normalizer must:

1. Preserve the user's order.
2. Remove duplicate fallback IDs after their first occurrence.
3. Remove the current primary ID.
4. Remove IDs that no longer exist in the installed built-in/custom source registry.
5. Never insert a source.

A registered source that is temporarily unavailable or failed remains configured. Runtime failure is not evidence that the user wants the source removed.

Do not remove IDs while the source registry is still loading. Registry-based cleanup runs only after the installed built-in and custom source lists are authoritative, or directly in the explicit source-deletion transaction. This prevents startup timing from clearing valid user choices.

## Architecture

### Source-Aware API Adapter

URL resolution must stop relying on one globally selected source. Introduce a source-aware adapter contract whose calls include an explicit playback API source ID:

```ts
interface PlaybackSourceAdapter {
  getCapabilities(apiId: string): Promise<PlaybackSourceCapabilities>
  getMusicUrl(request: {
    apiId: string
    requestId: string
    musicInfo: LX.Music.MusicInfoOnline
    quality: LX.Quality
    signal: AbortSignal
  }): Promise<string>
  getLocalMusicUrl?(request: {
    apiId: string
    requestId: string
    musicInfo: LX.Music.MusicInfoLocal
    signal: AbortSignal
  }): Promise<string>
}
```

The adapter and broker normalize failures before they reach the resolver:

```ts
type PlaybackSourceFailureScope = 'candidate' | 'source' | 'session'
type PlaybackSourceFailureKind =
  | 'unsupported'
  | 'emptyUrl'
  | 'request'
  | 'initialization'
  | 'runtimeCrash'
  | 'rateLimit'
  | 'serverBusy'
  | 'sourceChanged'
  | 'timeout'
  | 'cancelled'

interface PlaybackSourceError extends Error {
  scope: PlaybackSourceFailureScope
  kind: PlaybackSourceFailureKind
  apiId?: string
  platform?: LX.OnlineSource
  cause?: unknown
}
```

The broker maps initialization, lifecycle, crash, and IPC cancellation failures. The source adapter maps current API errors, including legacy localized/message constants, into stable kinds at its boundary. The resolver branches only on `scope` and `kind`, never on an error message. An unknown adapter exception defaults to candidate-scoped `request`; a session abort signal always normalizes to session-scoped `cancelled`.

Built-in and custom sources may use different implementations behind this contract. The caller must not change `common.apiSource` to route a request.

Capabilities must be stored by API source ID rather than only as one global `qualityList`. Filtering a candidate for platform and quality support therefore uses the capabilities of the source currently being attempted.

Every custom-source action must use explicit `apiId` and `requestId` routing, not only `musicUrl`. Call-site policy remains separate from routing:

- foreground playback, preloading, and missing-local-file audio recovery use `PlaybackResolveSession` and may select fallback API sources;
- downloads continue to use only the primary API source, including their existing optional music-platform switching behavior;
- lyric and cover calls continue to use their current built-in path or the primary custom source where the existing local-track path invokes one;
- source management and initialization target the explicitly named source.

Replace the global `apiInitPromise`, `userApi.apis`, and `qualityList` assumptions with per-API-ID state. Compatibility selectors may expose the current primary source's state to non-playback call sites during migration, but they must never make fallback calls depend on or mutate the global primary selection.

### Main-Process Custom Source Broker

Replace the single custom-source runtime with a broker backed by a map keyed by API source ID:

```text
apiId -> runtime instance
```

Each runtime owns its hidden execution window, initialization state, generation ID, pending-request table, and an in-memory Electron session partition derived from a safe hash of the API source ID. Source runtimes must not share the current single `userApiPartition`: clearing or recreating one source must not clear cookies, storage, authentication state, or cache used by another live source. Runtimes are created lazily on first use and are reused across songs. Merely adding a source to the fallback list does not eagerly create a window.

Every renderer-to-runtime request carries both `apiId` and `requestId`. The broker also binds each runtime generation to its `webContents.id`. Initialization messages, request responses, and update-alert messages are attributed from the trusted IPC sender binding; a payload-supplied API ID cannot select or impersonate another runtime. A response is accepted only when sender binding, API ID, request ID, and runtime generation all match. This allows foreground playback and next-song preloading to call the same or different sources concurrently without responses crossing sessions.

Runtime lifecycle rules:

- Updating a custom source disposes only that source's runtime. Its next request initializes the new script.
- Deleting a custom source disposes its runtime and rejects only its pending requests.
- Removing an installed source from both primary and fallback configuration marks its runtime for disposal after active snapshotted sessions and non-playback requests release it. The settings change itself does not interrupt those requests.
- A crashed runtime rejects its own pending requests, is removed from the pool, and may be initialized again on a future request.
- Proxy and other shared environment updates are broadcast to every live runtime.
- App shutdown disposes all runtimes.
- A timeout or cancellation ignores late responses. A lazy initialization may finish for later use, but it cannot complete the expired resolution attempt.

The broker isolates request routing and lifecycle. It does not choose source order or persist playback settings.

### Playback Resolution Session

Create a `PlaybackResolveSession` in the renderer music core. A session owns:

- the song identity;
- a settings snapshot containing `[primary, ...fallbacks]`;
- requested quality and existing downgrade policy;
- one lazily created online candidate promise, or the ordered lazy candidate batches used by local-file recovery;
- one independent `SourceAttempt` for each snapshotted API source;
- attempted URL metadata used to resume after a media load failure;
- cancellation state.

Each `SourceAttempt` owns its API source ID, source rank, platform-candidate cursor, selected candidate quality, attempt failures, and 10-second deadline. The first-phase `SerialSourceExecutor` activates one `SourceAttempt` at a time. Source order and candidate discovery therefore do not depend on one global mutable source cursor.

A `PlaybackResolutionCoordinator` owns sessions by stable song identity. The player action layer consumes the foreground session, while next-song preloading may create a session that can later be promoted to foreground playback. Switching songs, stopping playback, force-refreshing, or replacing a preload candidate cancels any session that is not being promoted, and late results are ignored by identity and request ID.

## Resolution Flow

### 1. Cache Lookup

When not force-refreshing, look up the original song's cached URLs in the existing allowed playback-quality order, starting at the requested quality and moving downward. Store a newly resolved URL under its actual resolved quality. Playback may therefore reuse a validated lower-quality fallback URL for the same song without pretending that it has the requested quality. Download lookups remain exact-quality and do not adopt this playback-only lookup policy.

New URLs are persisted only after media validation. Existing rows created by older versions are treated as provisional cache candidates: validate them before use and remove them if validation fails.

The session records the exact cache key selected by lookup: original song ID plus actual quality. Add a single-key URL-cache delete operation through the renderer IPC, main process, and database worker. If a cached URL fails media validation, immediately tombstone that exact key in renderer memory and delete the database row before allowing a later ordinary lookup to use it. Bypassing the row for only the current request is insufficient.

A cache candidate has its own 10-second media-validation deadline because no `SourceAttempt` is active yet. If it does not reach `canplay` before that deadline, treat it as failed, tombstone and delete its exact key, then start the primary `SourceAttempt`. Cache validation consumes no API source's 10-second budget. Foreground and preload cache validation use the same rule.

A force refresh tombstones and deletes every playback cache key for the original song in the requested-quality-and-lower lookup set, creates a new session, and starts again from the configured primary source. It does not clear unrelated songs or higher qualities outside that set.

At `canplay`, publish the validated URL to an in-memory cache under its actual quality so a concurrent consumer can reuse it immediately, then upsert the database row. Playback need not wait for disk I/O, but the session retains its commit promise until the write settles. A failed persistence write is logged and does not turn an already validated playback into a source failure.

### 2. Candidate Discovery

Use the existing song matcher and its existing ranking. For an online track, the original song record remains the first platform candidate. Cross-platform search runs at most once per resolution session and its result or in-flight promise is reused by every playback API source.

For missing-file local recovery, preserve the current lazy variant order: original metadata, parsed `name - singer`, reversed parsed names, parsed filename, reversed parsed filename, then filename-as-name where applicable. Discover one variant batch only after the previous batch fails. Cache each batch's matched candidates in the session so every API source reuses the same result without repeating search. Preserve current per-batch ranking and platform filtering; do not flatten, reorder, or deduplicate candidates across different metadata variants. Within each API source, try its optional direct `local` action before consuming the ordered online candidate batches.

Matching remains lazy: it starts when the original-platform attempt first requires fallback. Time spent awaiting the shared matching promise counts against the active source's 10-second deadline. The promise may finish while a later source is active and is then reused, but an earlier source whose deadline expired is not revisited. The hard source deadline takes precedence over waiting for matching to finish.

Source-specific capability filtering happens after matching. One source may skip a candidate that another source supports without rerunning the search.

### 3. Serial Source Attempt

For each source in the snapshot:

1. Start one 10-second source deadline.
2. Obtain that source's capabilities.
3. For an online track, try the original song platform if supported. For missing-file local recovery, try this source's optional direct `local` action.
4. Try the shared matched online-platform candidates in existing rank order.
5. For each candidate, use the existing quality selector to choose the highest eligible quality at or below the requested quality for this source and song.
6. Yield each non-empty URL to media validation.
7. On validation failure, continue from the next untried platform candidate in the same session.
8. Move to the next playback API source only when this source is exhausted or its deadline expires.

Failure advancement is explicit:

- Candidate-level failure advances to the next platform candidate inside the same `SourceAttempt`: unsupported platform or quality, empty URL, ordinary URL request error, and pre-`canplay` media validation failure.
- Source-level failure ends the current `SourceAttempt` and activates the next API source: source initialization failure, source update/deletion invalidation, runtime crash, rate limit, server-busy response, and the cumulative 10-second source deadline.
- Session-level cancellation ends the complete flow without trying another source: song replacement, stop, force-refresh replacement, app shutdown, or explicit cancellation.

The source deadline is cumulative; it does not reset for each platform candidate or returned URL. Candidate-level failures advance immediately, and source-level failures do not consume the remaining candidates of that API source.

### 4. Media Validation And Commit

Foreground playback validates the yielded URL through the real media element. Next-song preloading validates it through the existing muted preload media element. `canplay` marks the URL as usable.

While a foreground candidate is awaiting `canplay`, the player enters an explicit candidate-validation state bound to the resolution session and yielded attempt. In this state, media `canplay`, `error`, and deadline events are routed exclusively to the resolver. The existing player error path must not also stop playback, refresh the URL twice, start its 25-second loading watchdog, emit a user-visible error, or schedule automatic skip. A source-produced URL uses the active source's remaining 10-second deadline; a cached URL uses its independent 10-second cache-validation deadline.

Before `canplay`, a media error, invalid response, or candidate-level failure resumes the same `PlaybackResolveSession`. A source deadline advances to the next `SourceAttempt`. Neither path restarts from the primary source or repeats an already failed source/platform candidate. This phase preserves the existing one-quality-per-candidate behavior; it does not add lower-quality retries after a URL request or media validation failure.

After validation:

- persist the URL under the original song and resolved quality using the existing cache boundary;
- leave candidate-validation state and close the resolution session as successful;
- continue playback or retain the successful preload result;
- do not modify `common.apiSource` or the fallback order.

`canplay` is the single commit boundary for both foreground and preload validation. Once it fires, the fallback session is complete and any later media error uses the existing player error handling, whether or not a `playing` event has fired yet.

The existing automatic URL refresh after a post-commit media error uses a `primaryOnly` resolution policy: it may retain the current music-platform matching behavior inside the configured primary API source, but it must not start the API fallback chain or restore progress from another API source. This is distinct from an explicit user force refresh, which starts a new full fallback session from the primary source. Replace the current ambiguous refresh boolean with an explicit refresh reason/policy so these paths cannot be confused.

### 5. Complete Failure

When every source is exhausted, emit one final playback-resolution error. Do not rerun the chain. Preserve the existing `player.autoSkipOnError` behavior after that final error.

Internally retain the attempt failures for diagnostics, but do not show one toast or status transition per source.

## Settings UI

Keep the existing primary-source selector. Add an ordered fallback-source section directly below it.

- The initial list is empty.
- An Add control lists installed sources that are neither the primary source nor already selected; a temporary initialization failure does not hide a source.
- Adding a source is always an explicit user action.
- Each selected source has move-up, move-down, and remove controls.
- The persisted array order is the attempt order.
- An empty list is valid, and there is no artificial item limit.
- Changing the primary source immediately removes an equal fallback ID.
- The old primary remains unselected.

Deleting an imported source removes its fallback entry. If the deleted source is primary, preserve the existing behavior for selecting another available primary, then run the same fallback normalizer.

Do not display a fallback-mode control in this phase. A later parallel implementation can add a serial/parallel control without changing the ordered list format.

## Preload Handoff

The `PlaybackResolutionCoordinator` registers the next-song preload session by stable song identity.

- If the preload has already reached `canplay`, foreground playback consumes its validated in-memory result directly and does not resolve API sources again.
- If the same session is still resolving when that song becomes current, promote the session to foreground ownership. Detach the muted preload validator and continue its current cursor through the real player instead of creating a second session.
- If the next-song identity changes, a force refresh is requested, or the preload belongs to another song, cancel it and create the appropriate foreground session.
- A settings change alone does not invalidate an existing preload session because that session already owns its configuration snapshot.
- Publishing the in-memory validated result happens before the asynchronous database upsert, so foreground handoff cannot race the persistent cache write.

Promotion preserves the source and candidate cursors and the remaining source deadline. It never restarts the chain or extends the active source's 10-second budget.

## Concurrency And Race Handling

- Foreground playback and preloading use independent request IDs; a matching preload session is promoted rather than duplicated.
- A settings change affects only sessions created after the change.
- A source update or deletion may fail that source's active request; the session then advances normally.
- Changing songs or stopping cancels pending API calls and media validation where supported. Late callbacks must pass song identity, session ID, request ID, and runtime generation checks.
- A successful preload URL is validated and cached through the same commit path as foreground playback.
- A stale preload result cannot replace or cache data for a different next-song candidate.

## Diagnostics

Record structured debug information for each failed attempt:

- resolution session ID and song identity;
- playback API source ID;
- music platform and requested/resolved quality;
- elapsed time;
- failure category such as unsupported, initialization, request, empty URL, media validation, timeout, cancellation, or runtime crash.

Do not log raw authenticated URLs, source script contents, or tokens. Cancellation is a normal control-flow event and must not produce a user-visible error.

## Future Parallel Mode

Keep source ordering, shared candidate discovery, source-aware broker calls, media validation, and cache commit independent from the `SerialSourceExecutor`. Each source already has an independent `SourceAttempt`, so a later executor can schedule more than one attempt without changing settings or IPC request identity.

This phase guarantees configuration compatibility and source-isolated request state only. The future parallel phase must separately define its concurrency limit, winner and tie-breaking rules, and whether it validates multiple URLs with separate muted media elements. It may replace the executor and validation scheduler. This phase does not implement parallel requests or expose `parallel` in settings.

## Test Plan

### Configuration Tests

- New and upgraded settings default to an empty fallback list and `serial` mode.
- Unsupported or manually imported `parallel` mode is coerced to `serial` in this phase.
- Loading settings never inserts fallback sources.
- Duplicate IDs and the primary ID are removed while order is preserved.
- Changing primary removes the new primary from fallbacks and does not add the old primary.
- Importing a source does not add it; deleting a source removes it.
- Loading an initially empty, non-authoritative source registry does not clear saved fallbacks.
- A temporary initialization failure does not mutate configuration.

### Runtime Broker Tests

- Requests route by API source ID and request ID.
- IPC responses and initialization are rejected when the sender `webContents.id` or runtime generation does not match the bound source.
- Runtimes initialize lazily and are reused.
- Updating, deleting, or crashing one runtime does not reject another runtime's requests.
- Removing a source from configuration waits for active snapshot references before disposing its runtime.
- Clearing one runtime's session partition does not clear another source's cookies, storage, authentication cache, or network cache.
- Concurrent playback and preload requests cannot consume each other's responses.
- Late responses from timed-out requests or old runtime generations are ignored.
- Download, lyric, and cover paths remain bound to the primary source and do not enter the API fallback chain.
- Broker and adapter failures normalize to stable scope/kind values; resolver behavior does not depend on localized error messages.
- An unknown adapter exception defaults to candidate-scoped ordinary request failure, while an abort signal becomes session cancellation.

### Resolver Tests

- The attempt order is primary source first, then ordered fallbacks.
- Each source exhausts original and matched platforms before the next source starts unless a defined source-level failure ends it early.
- Cross-platform matching runs once per session.
- Missing-file local recovery tries each source's direct `local` action, lazily discovers metadata/filename variant batches in existing order, and reuses each batch without cross-batch reordering.
- Candidate filtering uses per-source platform and quality capabilities.
- Existing per-candidate quality selection happens before source fallback, without adding extra quality retries.
- Ordinary request, empty-URL, and media-validation failures advance to the next candidate in the same source.
- Initialization, source-update/deletion, runtime-crash, rate-limit, server-busy, and source-timeout failures advance to the next API source.
- Cancellation ends the session without trying another source or displaying an error.
- A source's total work is capped at 10 seconds with fake timers.
- A settings change does not mutate an existing session snapshot.
- All-source failure emits one error and does not rerun the chain.
- Online recovery for a missing local file uses the chain; WebDAV does not.

### Cache And Media Tests

- A URL is persisted only after `canplay`.
- A cached URL is reused for the same song while valid, including a lower actual quality selected by a fallback source.
- Download cache lookups remain exact-quality.
- A failed cached URL tombstones and deletes its exact song/actual-quality key and cannot be returned by a later ordinary lookup.
- A cached URL that neither reaches `canplay` nor errors is invalidated after its independent 10-second deadline, then starts the primary source without consuming its budget.
- Foreground and preload cache validation use the same independent deadline.
- A pre-`canplay` error resumes after the failed attempt without restarting the chain.
- Candidate-validation state suppresses the old double-refresh, 25-second watchdog, duplicate error, and automatic-skip paths.
- An error after the `canplay` commit boundary uses existing player handling instead of source fallback.
- Automatic post-commit URL refresh is primary-only; explicit user force refresh starts a new full fallback session.
- Force refresh invalidates the requested-and-lower playback cache keys and starts a new session from primary.
- A validated in-memory result is visible before its database upsert finishes, and a failed upsert does not fail playback.
- A matching completed preload result is consumed directly; an in-flight preload session is promoted without resetting cursors or deadlines.

### UI Tests

- The fallback list starts empty and changes only through explicit user actions.
- The Add control excludes the primary and already selected sources without hiding a temporarily failed installed source.
- Move and remove controls persist the correct order.
- Selecting a fallback as primary removes it from the list.
- A successful fallback produces no user notification.

### Integration Tests

Use deterministic fake playback API sources and media validation events for:

- primary failure followed by first-fallback success;
- multiple fallback failures followed by later success;
- a returned URL that fails media validation before the next candidate succeeds;
- foreground playback and next-song preload running concurrently;
- a preload session promoted while its URL is still being validated;
- settings edited during resolution;
- source deletion or runtime crash during resolution;
- complete chain failure with automatic skip enabled and disabled.

Tests must not depend on real music platforms or live network behavior.
