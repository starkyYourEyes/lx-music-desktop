# Local Storage Architecture Design

**Date:** 2026-07-29

**Status:** Approved direction; implementation pending written-spec review

## Problem

The desktop application currently treats `data.json` as a serialized snapshot
of unrelated application concerns. The observed profile contains 15 top-level
keys and is about 528 KiB. It combines:

- low-frequency catalog preferences;
- device-local navigation and playback-resume state;
- search and recent-play history;
- listening-time aggregates;
- playlist metadata;
- QQ Music and NetEase account profiles and plaintext Cookies;
- two updater remnants that are no longer referenced by source code.

`recentPlayList` contains 520 complete music objects and accounts for about 98%
of the compact JSON payload. `Store.set()` serializes and replaces the complete
store for every key update. Playback resume is throttled to two seconds,
listening statistics to five seconds, and recent playback to one second. A
small progress update can therefore rewrite the full file repeatedly.

The existing SQLite database is already the application's structured data
store. It runs through a dedicated worker, uses one connection, and enables
WAL. It is about 47.9 MiB in the observed profile, of which approximately
41.1 MiB is lyric data and 2.85 MiB is cached music URLs. It currently mixes
durable data and reconstructable cache data.

Sensitive data is not limited to `data.json`. `config_v2.json` contains the
WebDAV username and password. Sync client/server keys are also stored in JSON.
The current "all data" export contains only settings and playlists, and the
`.slxmc` container is gzip-compressed JSON rather than encrypted data. It can
therefore export a plaintext WebDAV password while omitting other durable user
data.

The goal is not to copy Spotify's distributed infrastructure. The goal is to
adopt the same useful boundaries on a scale appropriate for a local desktop
player: device state, durable business data, playback facts, projections,
credentials, caches, and temporary files must have different ownership and
lifecycle rules.

## Goals

1. Remove all active reads and writes from `data.json`.
2. Keep one authoritative application database by extending `lx.data.db`.
3. Store playback facts at a useful semantic level and derive recent playback
   and listening statistics from them.
4. Eliminate whole-file write amplification from playback progress and
   listening-time updates.
5. Isolate all confirmed credentials behind Electron `safeStorage`.
6. Move reconstructable structured data out of the authoritative database and
   into an independently clearable cache database.
7. Give settings, local state, user history, caches, credentials, backups, and
   temporary files explicit retention and export rules.
8. Make migrations idempotent, transactional, verifiable, and recoverable
   without silently replacing the application database with an empty one.
9. Replace arbitrary `get_data` and `save_data` IPC access with typed,
   validated operations.
10. Preserve existing user-visible data and behavior unless this design
    explicitly defines a correction.

## Non-Goals

- Renaming `lx.data.db` to `app.db` only for cosmetic consistency.
- Building a message queue, CQRS framework, telemetry backend, data warehouse,
  recommendation model, or distributed event-delivery system.
- Synchronizing playback history across devices in this project.
- Adding `event_outbox` without a real server-side consumer.
- Adding a new audio-cache or offline-download feature.
- Adding new history/statistics consent controls or a private-mode UI. The
  storage contract supports these policies, but this project does not invent
  their product surface.
- Treating downloaded media or resumable partial downloads as disposable
  cache data.
- Persisting private-playback activity for possible future use.
- Inventing timestamps, playback sessions, or events for legacy aggregate
  data that does not contain those facts.
- Rewriting unrelated stores such as hotkeys, themes, or User API behavior,
  except where their storage classification affects backup or cache clearing.

## Architecture Decision

### Authoritative Database

Extend the existing `lx.data.db` and treat it as the one authoritative
application database. This reuses the current worker, WAL connection, backup
point, and transaction boundary. Playback facts and their projections can be
committed atomically.

A new `app.db` would require moving the existing 47.9 MiB database, reconnecting
every module, and temporarily doubling disk use. Once complete, it would have
the same failure domain as an extended `lx.data.db`. A separate `activity.db`
would add a second durable schema, migration lifecycle, backup lifecycle, and
cross-database consistency problem without meaningful throughput benefit.

The only additional SQLite database is `cache.db`. It is explicitly
non-authoritative and may be deleted and recreated after corruption or at the
user's request.

### Playback Fact Model Adaptation

The factual playback layer is the combination of `playback_sessions` and
`playback_events`, not `playback_events` alone. A session is the compact,
checkpointed fact for how much of one track was actually played. Its child
events preserve semantic transitions such as pause, seek, skip, natural end,
and error.

This deliberately adapts the reference event-stream model for a single local
process. Periodic progress is persisted by idempotently updating the current
session rather than appending a progress event every 15 seconds. Recent and
listening tables are projections of the combined fact layer. A future sync
consumer may add an outbox or exported progress events, but that is not part of
this design.

### Physical Layout

Installed builds use separate profile, cache, runtime, and temporary roots:

```text
<profileRoot>/
  config_v2.json
  lx.data.db
  credentials.v1.json
  assets/
    theme-images/
  user-api/
  backups/

<cacheRoot>/
  cache.db
  artwork/
  audio/

<runtimeRoot>/
  session-data/

<tempRoot>/<application-id>/<run-id>/
```

On Windows, `<profileRoot>` remains under the application's roaming profile.
`<cacheRoot>` and `<runtimeRoot>` use local, non-roaming locations.
`<runtimeRoot>/session-data` becomes Electron's `sessionData` root before a
session or window is created. `<tempRoot>` uses the operating system temporary
directory.

Portable builds use explicit subdirectories instead of mixing every artifact
under one `userData` directory:

```text
portable/
  profile/
  cache/
  runtime/
  temp/
  backups/
```

The existing names `config_v2.json` and `lx.data.db` remain. Their names are not
the architectural boundary, and renaming them provides no functional value.

Electron `sessionData` points to `<runtimeRoot>/session-data`, not to the cache
root. It can contain Cookies, LocalStorage, IndexedDB, and other persistent
session state in addition to caches. Cache clearing uses Electron APIs for
named cache categories and never recursively deletes the session-data root.

## Data Classification

### Legacy `data.json` Mapping

| Legacy key | Destination | Classification | Portable export default |
| --- | --- | --- | --- |
| `leaderboardSetting` | `config_v2.json` | low-frequency preference | include |
| `songListSetting` | `config_v2.json` | low-frequency preference | include |
| `searchSetting` | `config_v2.json` | low-frequency preference | include |
| `viewPrevState` | `local_state` | resettable device state | exclude |
| `playInfo` | `playback_resume_state` | resettable device state | exclude |
| `listScrollPosition` | `local_state` | resettable device state | exclude |
| `listPrevSelectId` | `local_state` | resettable device state | exclude |
| `listUpdateInfo` | `playlist_metadata` | durable playlist metadata | include with playlists |
| `searchHistoryList` | `search_history` | user-managed history | optional, off by default |
| `recentPlayList` | `recent_tracks` legacy baseline | derived history | optional, off by default |
| `listeningTimeStats` | listening projection baselines | durable aggregate | include by default |
| account profiles | `account_profiles` | refreshable local metadata | exclude by default |
| account Cookies | credential vault | secret | always exclude |
| `ignoreVersion` | none | obsolete | exclude |
| `lastStartInfo` | none | obsolete | exclude |

`listUpdateInfo` is not UI-only state. It contains update policy and playlist
profile fields such as description and cover information, so it remains with
the playlist domain.

### Existing SQLite Mapping

The current database remains authoritative for:

- playlists, playlist ordering, and playlist music metadata;
- dislike rules;
- edited lyrics;
- download task intent and resumable task metadata;
- new playback facts and projections;
- search history, playlist metadata, account profiles, and local state.

The following data moves to `cache.db`:

- raw provider lyrics;
- expiring music URLs;
- alternate-source lookup results.

The existing lyric table contains both `raw` and `edited` rows. Migration must
split it by row type. Edited lyrics are user-created content and must never be
deleted by a cache-clear operation.

Completed downloads remain in the user-selected download directory. Partial
download files and their task rows are operational recovery data; they are
removed only by cancel/remove-download actions that name them explicitly.

Custom theme images and User API scripts are durable assets, not cache. Theme
editor staging files move out of `theme_images/temp` and into the per-run
temporary root.

## Authoritative Database Schema

The following definitions describe the required ownership and constraints.
Exact SQL belongs in the implementation plan, but implementations must not
weaken these constraints.

### Migration Metadata

`schema_migrations`

- `version INTEGER PRIMARY KEY`
- `name TEXT NOT NULL`
- `checksum TEXT NOT NULL`
- `applied_at_ms INTEGER NOT NULL`

`migration_markers`

- `name TEXT PRIMARY KEY`
- `source_sha256 TEXT NOT NULL`
- `completed_at_ms INTEGER NOT NULL`
- `details_json TEXT NOT NULL`, validated against a versioned marker schema

The existing string version in `db_info` is bridged during the first migration.
The new integer migration sequence is canonical afterward.

### Track Snapshots

`track_snapshots`

- `track_id INTEGER PRIMARY KEY`
- `source TEXT NOT NULL`
- `source_track_id TEXT NOT NULL`
- `name TEXT NOT NULL`
- `singer TEXT NOT NULL`
- `duration_ms INTEGER`
- `playable_payload_json TEXT`
- `updated_at_ms INTEGER NOT NULL`
- `UNIQUE(source, source_track_id)`

Identity and display fields are sufficient for legacy listening statistics,
which do not contain a complete playable `MusicInfo` object.
`playable_payload_json` is nullable and is populated only when a validated,
cloneable playable snapshot is available, such as an imported recent item or a
new playback. It must not contain credentials, lyrics, room identifiers,
transient player state, or expiring provider stream URLs. A canonical WebDAV
locator or local-file locator is durable track identity and is allowed; it is
not the same data class as an expiring provider stream URL.

### Playback Sessions

`playback_sessions` is the compact factual record for one track playback. A
long playback that crosses local midnight is split into two linked segments so
daily totals are reproducible without guessing how time was distributed.

- `session_id INTEGER PRIMARY KEY`
- `session_uuid TEXT NOT NULL UNIQUE`
- `playback_group_uuid TEXT NOT NULL`
- `segment_no INTEGER NOT NULL`
- `track_id INTEGER NOT NULL REFERENCES track_snapshots(track_id)`
- `local_day TEXT NOT NULL`, formatted as `YYYY-MM-DD`
- `utc_offset_minutes INTEGER NOT NULL`
- `context_type TEXT`
- `context_id TEXT`
- `start_reason TEXT NOT NULL`
- `end_reason TEXT`
- `started_at_ms INTEGER NOT NULL`
- `ended_at_ms INTEGER`
- `start_position_ms INTEGER NOT NULL`
- `last_position_ms INTEGER NOT NULL`
- `duration_ms INTEGER`
- `played_ms INTEGER NOT NULL DEFAULT 0`
- `active_ms INTEGER NOT NULL DEFAULT 0`
- `cumulative_played_ms INTEGER NOT NULL DEFAULT 0`
- `cumulative_active_ms INTEGER NOT NULL DEFAULT 0`
- `checkpoint_seq INTEGER NOT NULL DEFAULT 0`
- `state TEXT NOT NULL`
- `recent_allowed INTEGER NOT NULL`
- `stats_allowed INTEGER NOT NULL`
- `created_at_ms INTEGER NOT NULL`
- `UNIQUE(playback_group_uuid, segment_no)`

Allowed stored states are `playing`, `paused`, `closed`, and `interrupted`.
Pending playback exists only in recorder memory.
An interrupted prior-process row keeps its persisted values and a null
`end_reason`; startup does not fabricate a skip or natural-end fact.

`played_ms` is media timeline progress excluding explicit and system seeks. It
preserves the semantics used by the imported legacy aggregate. `active_ms` is
monotonic wall-clock time while media is
actually playing, excluding pause and buffering. Both are stored as integer
milliseconds. The current listening-time UI continues to use `played_ms`;
`active_ms` is retained for future reporting without redefining old data.

The cumulative columns and checkpoint sequence are scoped to the stable
`playback_group_uuid`, even when a new day or statistics-clear boundary creates
a new segment. A newly opened segment copies the last acknowledged cumulative
counters and sequence as its delta baseline while its own `played_ms` and
`active_ms` start at zero.

### Semantic Playback Events

`playback_events` records meaningful transitions, not periodic progress ticks:

- `event_id INTEGER PRIMARY KEY`
- `session_id INTEGER NOT NULL REFERENCES playback_sessions(session_id) ON DELETE CASCADE`
- `sequence_no INTEGER NOT NULL`
- `event_type TEXT NOT NULL`
- `occurred_at_ms INTEGER NOT NULL`
- `position_ms INTEGER NOT NULL`
- `reason TEXT`
- `details_json TEXT`
- `UNIQUE(session_id, sequence_no)`

Allowed event types are:

- `play_start`
- `pause`
- `resume`
- `seek`
- `skip`
- `play_end`
- `error`

Reason and detail payloads use versioned discriminated unions:

- start: `select`, `next`, `previous`, `auto`, `restore`, `remote`, or the
  internal continuation reasons `day_boundary` and `statistics_clear`;
- pause/resume: `user`, `device`, `remote`, or `recovery`;
- seek origin: `bar`, `hotkey`, `media_session`, `lyric`, `party`, `restore`,
  or `buffer_recovery`, with `from_ms` and `to_ms`;
- skip: `next`, `previous`, `select`, `dislike`, `stop`, `error`,
  `load_timeout`, `buffer_timeout`, or `queue_removed`, plus an `automatic`
  boolean;
- error: stage, nullable code, recoverability, and attempt number.

Session `end_reason` uses the skip reasons above, `natural_end`,
`day_boundary`, `statistics_clear`, or null for an interrupted process. The two
boundary reasons are internal segmentation facts and are never displayed as
skips.

A short play followed by an explicit next action remains a factual skip. The
collector does not discard it or infer a different event from a duration
threshold.

### Playback Projections

`recent_tracks`

- `track_id INTEGER PRIMARY KEY REFERENCES track_snapshots(track_id)`
- `recency_seq INTEGER NOT NULL UNIQUE`
- `last_session_id INTEGER REFERENCES playback_sessions(session_id) ON DELETE SET NULL`
- `last_played_at_ms INTEGER`
- `legacy_rank INTEGER`
- `updated_at_ms INTEGER NOT NULL`

It contains at most 520 unique tracks and is queried by `recency_seq DESC`. A
legacy row receives `recency_seq = -legacy_rank`, preserving its source order;
new rows receive a positive sequence allocated in the projection transaction.
A row is created or moved to the top on
the first real `playing` transition, not when a track is merely selected. A
failed URL load therefore does not appear in recent playback. Legacy rows use
`legacy_rank` and a null timestamp rather than an invented time.

`listening_daily`

- `local_day TEXT PRIMARY KEY`
- `baseline_played_ms INTEGER NOT NULL DEFAULT 0`
- `live_played_ms INTEGER NOT NULL DEFAULT 0`
- `baseline_active_ms INTEGER NOT NULL DEFAULT 0`
- `live_active_ms INTEGER NOT NULL DEFAULT 0`
- `updated_at_ms INTEGER NOT NULL`

`listening_tracks`

- `track_id INTEGER PRIMARY KEY REFERENCES track_snapshots(track_id)`
- the same baseline/live played and active millisecond columns;
- `last_played_at_ms INTEGER`;
- `updated_at_ms INTEGER NOT NULL`.

`activity_totals`

- singleton primary key constrained to `1`;
- the same baseline/live played and active millisecond columns;
- `updated_at_ms INTEGER NOT NULL`.

Baseline columns preserve imported legacy aggregates and compacted historical
sessions. Live columns are reproducible from retained playback sessions. This
avoids claiming that projections remain fully reconstructable after their raw
retention window has passed. Legacy data has no wall-clock active-time fact, so
its imported `baseline_active_ms` is zero and is marked unknown in migration
details rather than inferred from `played_ms`.

`projection_state`

- `name TEXT PRIMARY KEY`
- `version INTEGER NOT NULL`
- `last_session_id INTEGER`
- `visible_after_ms INTEGER`
- `updated_at_ms INTEGER NOT NULL`

Projection rules are versioned. A later product decision such as "recent only
after five seconds" or "valid play after 30 seconds" changes a projection
version; it does not change or filter fact collection.

### Other Migrated State

`search_history` preserves the current maximum of 15 terms and exact
case-sensitive de-duplication behavior. It stores a monotonic recency sequence,
optional last-used time, and use count. Imported terms retain list order and do
not receive invented timestamps.

`playlist_metadata` stores each playlist's auto-update flag, last update time,
and validated profile JSON.

`account_profiles` stores non-secret provider profile snapshots and update
times. It is cleared with logout and excluded from default portable exports.

`playback_resume_state` is a singleton typed row containing track identity,
list identity, index hint, position, duration, and update time. Restore resolves
the track identity first and uses the list index only as a hint, preventing a
changed list from resuming the wrong track.

`local_state` is limited to registered, versioned device-state keys. Each key
has a dedicated validator and size limit. Arbitrary renderer-provided keys and
untyped values are not accepted.

## Playback Recorder

### State Machine

1. `musicToggled` creates an in-memory pending playback identity. It does not
   write `play_start` or update recent playback.
2. The first native `playing` transition creates the track snapshot and
   playback session, appends `play_start`, and updates `recent_tracks` in one
   transaction.
3. `pause` first checkpoints progress and then appends `pause`. Duplicate
   pause transitions are ignored.
4. The next native `playing` appends `resume`; duplicate playing transitions
   are ignored.
5. A seek checkpoints progress before the position change, appends a typed
   seek event, and resets sampling baselines. Restore, party synchronization,
   and buffering recovery are explicit system origins and do not contribute a
   position jump to `played_ms`.
6. A native `ended` transition checkpoints, appends `play_end`, and closes the
   session. A following automatic-next call cannot also classify it as skip.
7. Next, previous, select-another-track, dislike, stop, removal, and final
   error recovery checkpoint and append an explicit `skip` before closing.
8. Recoverable errors after playback has started append `error` but keep the
   session open. A final abandoned error adds a skip with reason `error`.
   Recoverable failures before the first `playing` transition stay in
   sanitized diagnostics. If all pre-play retries fail, the recorder creates
   one zero-duration closed session, appends its final `error`, and does not
   update recent playback or listening statistics.
9. Single-track repeat closes the prior session with `play_end` and creates a
   new session for the repeated playback.
10. At local midnight, the recorder closes the segment with
    `end_reason=day_boundary` and opens a continuation with
    `start_reason=day_boundary`, the same `playback_group_uuid`, and the next
    `segment_no`. This split is not a skip or a second user-initiated play.
11. Clearing statistics uses the same rotation protocol with
    `statistics_clear`, after checkpointing the exact pre-clear cumulative
    counters. Recent playback remains unchanged.

The existing boolean passed to automatic next is not a sufficient transition
reason because it is shared by natural end, timeout, and recovery paths. Player
commands must carry a typed transition reason through to the recorder.

### Checkpoint Protocol

The renderer sends a checkpoint every 15 seconds while playing and immediately
before pause, seek, skip, end, error, playback-rate change, renderer teardown,
and application shutdown:

```ts
interface PlaybackCheckpointV1 {
  playbackGroupUuid: string
  checkpointSeq: number
  cumulativePlayedMs: number
  cumulativeActiveMs: number
  positionMs: number
  durationMs: number | null
  occurredAtMs: number
}
```

`playbackGroupUuid` is stable for one user-visible track playback, including
internal day and statistics-clear segments. `checkpointSeq` and both
cumulative counters increase across the full group and do not reset when the
worker opens a new segment.

The renderer retains an unacknowledged checkpoint until the worker confirms
it. The worker resolves the group's current open segment and accepts the
checkpoint only when `checkpointSeq` is greater than the stored sequence and
cumulative counters do not move backward. Duplicate and out-of-order requests
return the last acknowledgement without applying another delta.

```ts
interface PlaybackCheckpointAckV1 {
  playbackGroupUuid: string
  sessionUuid: string
  segmentNo: number
  checkpointSeq: number
  cumulativePlayedMs: number
  cumulativeActiveMs: number
}
```

When a day or clear boundary rotates the segment, the same transaction creates
the next `sessionUuid`, copies the acknowledged cumulative baseline and
sequence into it, and returns that identity in the acknowledgement. The
renderer continues sending the stable group UUID, so a lost boundary
acknowledgement cannot make later checkpoints target a closed segment or count
the preceding segment again.

One `BEGIN IMMEDIATE` transaction:

1. calculates the difference between new and stored cumulative counters;
2. updates the open playback session;
3. increments daily, track, and total projections;
4. appends any accompanying semantic transition;
5. commits before returning the acknowledgement.

Playback sampling uses `performance.now()` for active time and media position
for played time. It validates media movement against elapsed time and playback
rate. Explicit seeks and buffering recovery reset the baseline. This fixes the
current undercount when background time updates arrive more than two seconds
apart while still excluding jumps.

The 15-second interval bounds crash loss without producing one database row per
checkpoint. The open session row is updated in place; only semantic events are
appended.

### Consent and Private Playback

History and statistics choices are latched onto a playback session when it
starts:

- history enabled, statistics enabled: store facts and update both projections;
- history enabled, statistics disabled: store only fields needed for history
  and do not update statistics;
- history disabled, statistics enabled: retain statistics facts but do not
  update recent playback;
- both disabled: persist only ordinary resume state, not playback activity;
- private playback: keep activity and resume state in memory only.

Consent is a collection constraint, not a projection rule. Changing a product
threshold may be applied to existing facts; disabled/private collection must
not be reconstructed later.

## Retention and Clearing

Retain terminal `closed` and `interrupted` playback sessions for the shorter
of:

- 12 months; or
- the newest 100,000 terminal playback sessions, counting both `closed` and
  `interrupted` rows.

Cleanup runs in bounded batches while idle. Before deleting a session, its
contribution moves from each projection's live columns to baseline columns in
the same transaction. Semantic events cascade with the deleted session.
Compaction ignores sessions that are disallowed by the relevant consent flag
or older than that projection's clear cutoff. Recent playback remains a
durable 520-row materialized view.

No startup `VACUUM` is performed. Deleted pages are reused. An explicit offline
compaction may run only when the free-page ratio exceeds 25%, the application
is idle, and sufficient temporary disk space is available.

User actions have distinct semantics:

- **Clear recent playback, keep statistics:** clear `recent_tracks` and set its
  `visible_after_ms` cutoff. Retained old facts cannot repopulate the list.
- **Clear listening statistics, keep recent playback:** first checkpoint every
  active statistics-enabled playback group, close its current segment with the
  internal reason `statistics_clear`, open a continuation segment using the
  acknowledged cumulative counters as its zero-delta baseline, then zero
  listening baselines/live totals and set the statistics cutoff in the same
  transaction. Compaction can therefore move only post-clear segment
  contributions into a baseline.
- **Delete all playback activity:** clear playback resume state, sessions,
  events, recent playback, listening projections, and projection cutoffs in
  one transaction. Then delete activity-only track snapshots that have no
  remaining foreign-key reference. This is the privacy operation that removes
  identifiable playback content.
- **Reset device state:** clear resume/navigation/scroll state only.
- **Clear cache:** clear cache database/files and Chromium cache only.

UI labels must state when recent playback is cleared while aggregate statistics
are retained. "Delete all playback activity" is the privacy operation that
removes raw local playback facts and the resume pointer to the last track.

## Credential Vault

`credentials.v1.json` is a versioned envelope whose entries contain only
base64-encoded ciphertext, an entry version, and an update time. Every secret
payload is independently encrypted by Electron `safeStorage.encryptString()`.
The file is written atomically and receives user-only permissions where the
platform supports them.

Confirmed vault entries include:

- NetEase Cookie;
- QQ Music Cookie;
- WebDAV username and password;
- sync client key;
- sync server device/user key material.

Provider profile information remains in `account_profiles`. Secret values stay
in the main process and are not returned by account-status IPC calls.

There is no plaintext fallback. If encryption is unavailable, or Linux selects
`basic_text`, persistent login is disabled for that session and the UI reports
that credentials cannot be saved securely. A portable directory moved to a
different operating-system user or machine normally cannot decrypt the vault;
the application requests login again.

Portable credential export is not part of this project. If added later, it
must use a user-provided passphrase, a memory-hard KDF, and authenticated
encryption. It must not use an application-embedded key or reuse `safeStorage`
ciphertext as a cross-device format.

Logout removes the provider's vault entry and profile in one logical operation.
A vault failure affects only the associated account and must not reset the
application database.

## Cache Database and Files

`cache.db` uses a separate connection in the existing database worker and has
its own schema version. Its tables are:

- `raw_lyrics`, keyed by provider and track identity, with last-access time;
- `music_urls`, keyed by provider, account scope, track, and quality, with a
  mandatory expiry time;
- `other_sources`, keyed by original track and candidate source, with
  last-access and expiry times.

Initial policies are:

- provider expiry wins for music URLs; otherwise use 15 minutes and cap the
  table at 5,000 entries;
- raw lyrics use a 100 MiB or 20,000-track cap and evict entries not accessed
  for 180 days;
- alternate-source mappings expire after 30 days and use a 50 MiB cap;
- account-scoped music URLs are removed on logout;
- source-scoped URL entries are removed when that source is disabled.

Old music URLs have no trustworthy creation or expiry time and are discarded
during migration. Every valid raw lyric row is migrated to preserve offline
behavior. Old alternate-source results are discarded; they are reconstructable
and lack trustworthy cache-age metadata.
Music URLs can act as bearer values even though they are disposable. The cache
root receives user-only permissions where supported, and URL values are never
logged or exported.

"Clear all cache" performs an orchestrated operation:

1. close the cache database connection;
2. delete and recreate `cache.db` and its WAL/SHM files;
3. clear the application's persistent Chromium session cache, CacheStorage,
   and code cache;
4. remove cache-owned artwork/audio files;
5. reopen the cache database;
6. broadcast invalidation to renderer and worker in-memory maps.

It must not touch `lx.data.db`, `config_v2.json`, the credential vault, edited
lyrics, themes, User API scripts, downloads, partial downloads, or backups.
Cache database corruption follows the same recreate path without affecting
durable data.

Per-run temporary directories are removed at normal exit and scavenged at the
next startup. Scavenging only targets resolved directories under the dedicated
application temporary root and never follows paths outside it.

## Settings and IPC Boundaries

`config_v2.json` remains a small, human-readable, low-frequency settings file.
It receives the three catalog preference objects from `data.json` and removes
all WebDAV credential values after vault migration. Settings are validated
against the existing typed defaults before replacement.

The JSON writer is hardened for all remaining stores:

- serialize once;
- write a same-directory temporary file;
- flush the temporary file;
- atomically replace the destination;
- retain a previously parsed and validated backup;
- remove stale owned temporary files at startup;
- serialize concurrent writes and coalesce superseded setting snapshots.

The current generic `get_data(path)` and `save_data({path,data})` IPC contract
is removed after migration. Replacement services expose narrow methods for:

- settings preferences;
- local state;
- search history;
- playlist metadata;
- playback checkpoints and transitions;
- recent-play and listening-stat queries;
- account status/profile operations;
- credential set/remove operations owned by main-process account services.

Every request validates its discriminated union, scalar ranges, string lengths,
JSON size, and allowed enum values before reaching storage. The renderer cannot
select arbitrary keys or write unbounded `any` values.

## Database Safety and Recovery

The database must be hardened before new domains migrate into it.

The current verifier compares normalized `sqlite_master.sql` text against the
table declarations. It can reject compatible schema text while omitting
database integrity and foreign-key checks. The current startup recovery then
moves the complete database aside and initializes an empty one. That behavior
is not acceptable once more durable data is consolidated.

The replacement policy is:

1. Set `foreign_keys=ON` and keep the single-writer worker/WAL model.
2. Run ordered migrations inside explicit transactions.
3. Before a schema migration, create a consistent SQLite online backup. Do not
   copy or rename a live database independently of its WAL.
4. Validate the supported schema version, required tables, columns, indexes,
   and foreign keys after migration.
5. Run `PRAGMA quick_check` after a migration or detected unclean shutdown and
   `PRAGMA foreign_key_check` after schema/data migration.
6. Reserve full `integrity_check` for explicit diagnostics and recovery.
7. If validation fails, leave the original database and backup intact and
   enter a read-only recovery flow. Never create an empty replacement
   automatically.
8. Record clean shutdown only after the playback/session flush and database
   close complete.

Normal backups use the SQLite online backup API. Renaming the database, WAL,
and SHM is only a corruption-isolation operation after the connection is
closed; it is not a normal backup mechanism.

The filesystem threat model rejects stable symbolic links, non-regular
database targets, competing creators, and path replacements that remain
visible across the guarded SQLite open. It does not claim to resist a
same-user malicious process that performs an ABA path replacement entirely
inside the native `sqlite3_open_v2` call. The bundled `better-sqlite3` API does
not expose `SQLITE_OPEN_NOFOLLOW`, so that syscall-level guarantee would
require native dependency support. This same-user ABA attacker is excluded
from the current desktop application threat model.

## Backup and Export

Two backup products have different purposes.

### Operational Snapshot

An operational snapshot is a same-profile recovery artifact created with the
SQLite backup API plus atomic copies of settings and durable assets. It may
include OS-bound credential ciphertext when explicitly requested, is marked
sensitive, and uses a short rolling retention. It is not portable across
machines.

### Portable Logical Export

The versioned logical export contains by default:

- secret-free settings;
- playlists and playlist profiles;
- dislike rules;
- edited lyrics;
- listening aggregate baselines and live totals;
- sound-effect presets;
- custom themes and referenced durable images.

Optional, off-by-default sections include search history and recent playback.
User API scripts are a separate explicit option because they are executable
content; imported scripts remain disabled until the user confirms them.

The export always excludes:

- credentials and account Cookies;
- account profile cache;
- playback resume and UI state;
- cache, runtime session data, Chromium storage, and temporary files;
- raw playback sessions/events unless a future dedicated history export is
  designed;
- music URLs;
- downloaded media and partial downloads;
- sync snapshots and pending transport data.

Compression is not encryption. The export UI must not imply that `.slxmc`
protects secrets. Import validates the container version and every section
before changing live state.

## Migration

Migration is an allowlisted, idempotent operation with no long-term dual write.
The migration coordinator runs after the application acquires its single-
instance lock and before renderer windows, account services, sync services, or
legacy data writers start.

Every migrated domain follows the same cutover contract:

1. keep its legacy writer inactive for the current startup;
2. derive and validate a target from the legacy source;
3. persist the target and a target-specific source hash;
4. read the target back and verify counts or values;
5. activate only the new reader and writer;
6. remove or redact the legacy value only after a successful startup.

SQLite transactions do not claim to cover JSON or vault file replacements.
Each destination has its own idempotent marker. A cross-artifact completion
marker is written only after every target marker and read-back check succeeds.
On retry, a valid target with a matching source hash is reused; a missing or
invalid target is rebuilt from the still-present legacy source.

### Phase 0: Safety Foundation

1. Add transactional schema migrations and migration checksums.
2. Replace destructive verifier recovery with quick/FK checks and read-only
   recovery.
3. Add online database backup and atomic JSON/vault writers.
4. Add typed storage services and IPC alongside the legacy IPC without
   switching callers.
5. Add the startup migration coordinator and prevent business modules from
   starting until it reports success, recovery mode, or a user-visible error.

### Phase 1: Credential Isolation

1. Acquire a single-instance migration lock.
2. Read confirmed credential fields from account, settings, and sync stores.
3. Encrypt each entry and atomically write the vault.
4. Read and decrypt every written entry and compare it to the source.
5. Import account profile snapshots into `account_profiles` and verify them.
6. Switch QQ Music, NetEase, WebDAV, sync client, and sync server call sites to
   vault-backed main-process services for both reads and writes.
7. Start those services only after the new reader/writer smoke checks pass.
8. Only after verification, remove plaintext values from active stores.
9. Do not retain a plaintext migration backup. The old source remains the
   recovery source until the encrypted write is verified.

Secure deletion cannot be guaranteed on SSDs. Migration removes references and
future plaintext writes; it must not promise physical overwrite of previously
allocated blocks.

### Phase 2: Non-Activity `data.json` Cutover

1. Read and validate `data.json`. Compute a separate canonical SHA-256 for each
   target domain rather than one hash for a file that legacy activity writers
   may still update before Phase 3.
2. Build `config_v2.json.next` containing the three migrated catalog
   preferences, fsync it, parse it, and verify the preference values.
3. In one database transaction, import and verify local state, playlist
   metadata, and search history, and write separate migration markers for those
   database targets.
4. Atomically replace `config_v2.json` with the staged settings file and verify
   its resulting SHA-256. Then write the settings target marker. If the process
   fails between the replacement and marker write, retry recognizes the valid
   target hash and writes the missing marker instead of applying values twice.
5. Switch settings preferences, local state, playlist metadata, and search
   history callers to their typed readers and writers before creating the
   renderer window.
6. Leave recent playback and listening statistics in `data.json` under their
   legacy writers until the atomic activity cutover in Phase 3. Do not archive
   `data.json` yet.

### Phase 3: Playback Recorder Cutover

1. Freeze the four legacy activity writes: resume state, recent playback,
   listening statistics, and their generic IPC endpoints.
2. Read the frozen recent and listening values, validate them, and compute an
   activity-source hash.
3. In one database transaction, import the 520 recent items as a legacy
   projection baseline preserving order and import rounded integer-millisecond
   listening baselines. Timestamps and session references remain null.
   Preserve the recorded total independently if it differs from daily or track
   sums, and record the mismatch.
4. Do not create playback sessions or semantic events for legacy recent or
   listening data. Write the activity source hash and verification counts in
   the same database transaction.
5. Read back recent order, critical counts, and aggregate totals.
6. Introduce typed transition reasons and seek origins.
7. Start the new recorder behind a development-only comparison flag.
8. Compare new aggregate deltas against the existing in-memory calculation
   without persisting both models.
9. Switch playback resume, recent, and listening callers to typed database
   services before allowing playback.
10. Remove the two-second `playInfo` JSON write, five-second statistics JSON
    write, recent-list JSON write, and all remaining generic data IPC callers.
    A runtime assertion must show that no registered `DATA_KEYS` caller remains.
11. Move unknown legacy keys into an encrypted quarantine entry. Quarantined
    payloads are never active data; report their names without logging values.
12. Write the cross-artifact completion marker only after settings, database,
    vault, typed-reader, and typed-writer checks all pass.

After one successful application startup using only new readers and writers,
replace `data.json` with a redacted migration artifact containing no Cookies or
other credentials. New code never writes it. No dual write is maintained.

### Phase 4: Cache Separation

1. Create and verify `cache.db` before changing cache readers.
2. Copy raw lyric rows to cache and verify counts/content hashes.
3. Keep edited lyric rows in the authoritative database.
4. Drop old music URLs instead of migrating them.
5. Discard legacy alternate-source rows and allow normal lookups to repopulate
   the cache.
6. Switch readers, then remove only successfully migrated cache rows from the
   authoritative database in a later cleanup migration.
7. Point Chromium `sessionData` at the runtime root and move theme-editor
   temporary files to the temporary root before creating sessions or windows.
   Do not copy the old session-data tree through the cache migration; migrate
   only explicitly required persistent browser state through Electron-owned
   APIs.

### Phase 5: Backup and Legacy Cleanup

1. Replace the current "all data" payload with the versioned logical export.
2. Redact credentials from settings-only export and import.
3. Add cache, device-state, recent, statistics, and all-activity clear actions
   with the distinct semantics defined above.
4. Remove legacy IPC registration and stale known `data.json` constants.
5. Retain one rolling pre-migration operational database snapshot for the
   documented rollback period; cache data is never part of rollback.

Each phase is independently releasable only after its acceptance tests pass.
Credential isolation and database recovery hardening precede activity and
cache migrations.

## Failure Handling

- A duplicate or out-of-order checkpoint is acknowledged without applying a
  second delta.
- A failed playback transaction leaves session and projections unchanged; the
  renderer retries the unacknowledged transition.
- Renderer shutdown waits for a bounded final checkpoint acknowledgement. A
  timeout is logged without blocking exit indefinitely; the previous 15-second
  checkpoint bounds loss.
- A stale open playback session is marked interrupted on the next startup with
  no invented end event or additional duration.
- A corrupt cache database is deleted and recreated.
- An undecryptable credential entry logs out only that provider and preserves
  the ciphertext for explicit recovery diagnostics until the user logs in or
  removes it.
- An authoritative database migration failure rolls back its transaction and
  preserves the pre-migration online backup.
- An authoritative database integrity failure enters recovery mode and never
  triggers automatic empty-database creation.
- A cache-clear failure reports the specific cache component that could not be
  cleared and does not broaden deletion targets.

Logs must never include Cookies, WebDAV credentials, sync keys, music URLs,
credential ciphertext, complete account payloads, or playback `details_json`.

## Test Strategy

### Unit Tests

- Validate every legacy key mapping and encrypt/quarantine unknown keys.
- Verify legacy recent ordering and the 520-row limit.
- Verify listening seconds-to-milliseconds conversion, including fractional
  seconds and inconsistent total/daily/song aggregates.
- Exercise the recorder state machine for start, pause/resume, seek, repeat,
  natural end, manual skip, automatic error skip, load failure, stop, and
  midnight continuation.
- Verify media progress, wall time, playback rate, background throttling,
  buffering, restore seek, party seek, and buffer recovery accounting.
- Verify duplicate, missing, and out-of-order checkpoint sequences.
- Verify each clear operation and its projection cutoff, including an active
  session that spans a statistics-clear boundary.
- Verify that legacy statistics create identity/display-only track rows while
  recent WebDAV items preserve canonical playable locators.
- Verify cache ownership rules, TTLs, quotas, and account/source invalidation.
- Verify vault read/write/delete and safeStorage-unavailable behavior without
  placing secrets in test output.
- Verify all portable export inclusion and exclusion rules.

### Integration Tests

- Inject a crash/failure before and after each migration transaction and vault
  cutover step, then rerun migration to prove idempotence.
- Verify that playback session, semantic event, and all affected projections
  commit or roll back together.
- Kill the renderer between checkpoints and verify that no more than the last
  interval is lost or double-counted.
- Cross local midnight and daylight-saving transitions while playing.
- Corrupt `data.json`, `cache.db`, a credential entry, and a database schema in
  isolation and verify their separate recovery paths.
- Verify SQLite online backup while WAL contains committed frames.
- Verify that cache clearing preserves edited lyrics, playlists, settings,
  credentials, themes, User API scripts, and downloads.
- Verify that cache clearing uses Electron APIs and does not recursively delete
  the runtime session-data root.
- Verify that arbitrary legacy `get_data`/`save_data` keys are rejected after
  cutover.
- Inspect the profile and portable logical export for known credential markers
  and prove that no confirmed secret remains in plaintext.

### Regression Verification

- Existing playlist, dislike, edited lyric, download, account, recent-play,
  search-history, and listening-time views continue to load.
- A successful legacy migration reproduces recent order, daily listening
  values, per-track listening values, and total listening value to within one
  millisecond after conversion.
- Existing settings and playlist import formats remain readable, but imported
  credential fields are ignored and never written to settings.

## Acceptance Criteria

1. No active code reads or writes `data.json` after a completed migration.
2. Playback progress does not rewrite any full JSON store.
3. A checkpoint and all associated listening projections are atomic and
   idempotent.
4. A load failure does not enter recent playback; a real short play and
   explicit skip remain recorded facts.
5. Pause, buffering, seek, restore, party sync, and buffer recovery cannot
   inflate listening time.
6. A normal crash loses at most one 15-second playback interval and cannot
   double-count acknowledged time.
7. QQ Music, NetEase, WebDAV, and confirmed sync secrets do not appear in
   plaintext profile JSON or default exports.
8. `safeStorage` unavailability never causes a plaintext fallback.
9. Clearing all cache leaves every durable and user-created artifact intact.
10. Clearing recent playback, statistics, all playback activity, and device
    state produces the distinct documented results.
11. Legacy recent order and listening aggregate values survive migration
    without fabricated events or timestamps.
12. Database migration failure rolls back and preserves a consistent backup;
    validation failure never initializes an empty authoritative database.
13. The default portable export is complete for the documented durable
    sections and excludes every documented secret, cache, and local-state
    section.
14. Re-running any interrupted migration is safe and does not duplicate rows,
    projection contributions, or credentials.

## Delivery Boundaries

This architecture is delivered in five implementation milestones matching the
migration phases. Each milestone requires its own detailed implementation plan
and verification checkpoint. The recovery and credential foundations must ship
before playback facts or cache separation depend on them.

The final legacy cleanup milestone may remove code paths and constants only
after at least one successful startup has used the new stores and the rollback
artifact has been verified.
