# Playback Activity and Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace JSON-based resume, recent-play, and listening-time writes with a semantic playback recorder whose idempotent checkpoints atomically update facts and projections in `lx.data.db`.

**Architecture:** The renderer owns a pure recorder state machine and samples media/monotonic clocks; the database worker owns track snapshots, session segments, semantic events, resume state, recent projection, and listening projections. One stable `playbackGroupUuid` and cumulative checkpoint protocol spans midnight/statistics-clear segments so retries cannot double-count.

**Tech Stack:** TypeScript, Vue 3 renderer state, HTMLMediaElement events, `performance.now()`, Electron IPC, Comlink, `better-sqlite3`, `node:test`, and the existing listening-time utility as a temporary comparison/import baseline.

## Global Constraints

- This plan requires completed Phase 2, authoritative schema version `5`, the vault, migration markers, and typed state services.
- The factual layer is `playback_sessions` plus `playback_events`; projections are not the sole source of truth.
- Periodic progress updates a session row and projections; it never appends a progress event.
- Append events only for `play_start`, `pause`, `resume`, `seek`, `skip`, `play_end`, and `error`.
- `musicToggled` creates pending in-memory identity only. First native `playing` creates the session/event and promotes recent playback.
- A failed pre-play load creates one zero-duration closed failure session only after retries are exhausted; it never enters recent or listening projections.
- Use one stable `playbackGroupUuid` and strictly increasing cumulative counters/checkpoint sequence across internal segments.
- Duplicate or out-of-order checkpoints acknowledge the last committed state without changing facts or projections.
- Store integer milliseconds. Convert legacy seconds with `Math.round(seconds * 1000)` and preserve inconsistent total/daily/song aggregates independently.
- `played_ms` excludes explicit/system seeks; `active_ms` uses monotonic wall time only while actually playing and excludes pause/buffering.
- A short real play followed by an explicit action remains a factual skip; do not infer validity from a duration threshold.
- At local midnight and statistics clear, close/open linked segments without recording a user-visible skip.
- Retain terminal closed/interrupted sessions for the shorter of 12 months or newest 100,000 terminal sessions; compact live contributions into baselines before deletion.
- Do not add playback-history sync, telemetry, `event_outbox`, consent UI, or private-mode UI. Implement policy inputs with current defaults enabled so future UI cannot require a storage redesign.
- A canonical WebDAV/local locator may remain in a playable snapshot; expiring provider stream URLs, credentials, lyrics, room IDs, and transient player state may not.
- Keep current user changes in `src/common/utils/listeningTime.ts` and `build-config/listening-time.test.js`, plus every other unrelated change listed in the roadmap or appearing later. Use the fractional-second behavior as input; never revert or silently stage user work.

## File Structure

- Create `src/common/storage/playback.ts`: all versioned commands, reasons, facts, acks, and query DTOs.
- Create `src/common/storage/playbackValidation.ts`: strict field/payload validation and playable-snapshot sanitization.
- Create authoritative migration `0006_playback_activity.ts`.
- Create `src/main/worker/dbService/modules/playback/`: statements, repository, projections, retention, and clear operations.
- Create `src/main/migration/legacyData/activity.ts`: frozen Phase 3 import, quarantine, and cross-artifact marker.
- Create `src/renderer/core/playbackRecorder/`: pure reducer, sampler, command delivery, retry, and boundary scheduler.
- Create `src/renderer/core/useApp/usePlayer/usePlaybackRecorder.ts`: player-event integration.
- Create `src/main/modules/winMain/rendererEvent/playback.ts` and `src/renderer/utils/playback.ts`: typed IPC.
- Modify player actions/events to carry explicit transition reasons and seek origins.
- Replace recent/listening/resume JSON stores with query-backed renderer state.
- Add retention/clear services and a development-only comparison mode.

---

### Task 1: Lock the Existing Fractional Listening-Time Baseline

**Files:**
- Existing user file, do not edit/stage: `src/common/utils/listeningTime.ts`
- Existing user file, do not edit/stage: `build-config/listening-time.test.js`
- Create: `src/common/storage/legacyListening.ts`
- Create: `build-config/storage/legacy-listening-conversion.test.js`

**Interfaces:**
- Consumes: `normalizeListeningTimeStats()` with fractional seconds preserved.
- Produces: `convertLegacyListeningStats()` with exact integer-millisecond baselines and mismatch metadata.
- Guarantees: existing user changes become an explicit Phase 3 input instead of an unrelated accidental diff.

- [ ] **Step 1: Verify the user-owned baseline before changing storage code**

Run:

```powershell
node --test build-config/listening-time.test.js
git diff -- src/common/utils/listeningTime.ts
```

Expected: two tests pass; the diff removes `Math.floor()` from normalization and accumulation. Do not stage either file.

- [ ] **Step 2: Write failing millisecond conversion tests**

```js
it('rounds fractional seconds to the nearest millisecond', () => {
  const result = convertLegacyListeningStats({
    totalSeconds: 1.2346,
    daily: { '2026-07-29': 0.3335 },
    songs: {
      'test:one': { id: 'one', source: 'test', name: 'One', singer: 'Singer', seconds: 0.9004 },
    },
    updatedAt: 9,
  })
  assert.equal(result.totalPlayedMs, 1235)
  assert.equal(result.daily[0].baselinePlayedMs, 334)
  assert.equal(result.tracks[0].baselinePlayedMs, 900)
})

it('preserves inconsistent aggregates instead of reconciling them', () => {
  const result = convertLegacyListeningStats({
    totalSeconds: 100,
    daily: { '2026-07-29': 80 },
    songs: { 'x:1': { id: '1', source: 'x', name: 'N', singer: 'S', seconds: 70 } },
  })
  assert.deepEqual(result.mismatch, { totalVsDailyMs: 20000, totalVsTracksMs: 30000 })
})
```

- [ ] **Step 3: Run and verify RED**

```powershell
node --test build-config/storage/legacy-listening-conversion.test.js
```

Expected: FAIL because the converter is missing.

- [ ] **Step 4: Implement the converter**

```ts
export interface LegacyListeningImportV1 {
  totalPlayedMs: number
  daily: Array<{ localDay: string; baselinePlayedMs: number }>
  tracks: Array<{
    source: string
    sourceTrackId: string
    name: string
    singer: string
    baselinePlayedMs: number
  }>
  mismatch: { totalVsDailyMs: number; totalVsTracksMs: number }
  baselineActiveTimeKnown: false
}

const secondsToMs = (seconds: unknown): number =>
  Math.max(0, Math.round((Number(seconds) || 0) * 1000))
```

Validate `YYYY-MM-DD` calendar dates and bounded track strings. Do not derive timestamps, active time, sessions, or events. Set every legacy active baseline to zero and expose `baselineActiveTimeKnown:false` for marker details.

- [ ] **Step 5: Verify GREEN and commit only the new files**

```powershell
node --test build-config/listening-time.test.js build-config/storage/legacy-listening-conversion.test.js
git add src/common/storage/legacyListening.ts build-config/storage/legacy-listening-conversion.test.js
git commit -m "feat: normalize legacy listening baselines"
```

### Task 2: Define Playback Commands, Reasons, and Sanitizers

**Files:**
- Create: `src/common/storage/playback.ts`
- Create: `src/common/storage/playbackValidation.ts`
- Create: `build-config/storage/playback-contracts.test.js`

**Interfaces:**
- Consumes: existing `LX.Music.MusicInfo` values at the renderer boundary.
- Produces: shared versioned DTOs used unchanged by renderer, IPC, and worker.
- Guarantees: explicit command intent replaces ambiguous booleans.

- [ ] **Step 1: Write reason, range, and playable-payload tests**

```js
it('rejects an untyped skip and a backward cumulative checkpoint', () => {
  assert.throws(() => parsePlaybackFact({ version: 1, type: 'skip', reason: 'auto' }))
  assert.throws(() => validateCheckpointAfter(previous, { ...previous, checkpointSeq: 2, cumulativePlayedMs: 9 }))
})

it('removes expiring and private fields but preserves a WebDAV locator', () => {
  const result = sanitizePlayableTrack({
    id: 'track', source: 'webdav', name: 'Name', singer: 'Singer',
    meta: { filePath: 'music/a.flac', url: 'https://expired', cookie: 'SECRET', roomId: 'room' },
  })
  assert.equal(result.meta.filePath, 'music/a.flac')
  assert.equal(JSON.stringify(result).includes('https://expired'), false)
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
  assert.equal(JSON.stringify(result).includes('room'), false)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/playback-contracts.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement exact shared types**

```ts
export type PlaybackStartReason =
  | 'select' | 'next' | 'previous' | 'auto' | 'restore' | 'remote'
  | 'day_boundary' | 'statistics_clear'

export type PlaybackPauseReason = 'user' | 'device' | 'remote' | 'recovery'
export type PlaybackSeekOrigin =
  | 'bar' | 'hotkey' | 'media_session' | 'lyric'
  | 'party' | 'restore' | 'buffer_recovery'
export type PlaybackSkipReason =
  | 'next' | 'previous' | 'select' | 'dislike' | 'stop' | 'error'
  | 'load_timeout' | 'buffer_timeout' | 'queue_removed'
export type PlaybackEndReason = PlaybackSkipReason | 'natural_end' | 'day_boundary' | 'statistics_clear'

export interface PlaybackCheckpointV1 {
  playbackGroupUuid: string
  checkpointSeq: number
  cumulativePlayedMs: number
  cumulativeActiveMs: number
  positionMs: number
  durationMs: number | null
  occurredAtMs: number
}

export interface PlaybackCheckpointAckV1 {
  playbackGroupUuid: string
  sessionUuid: string
  segmentNo: number
  checkpointSeq: number
  cumulativePlayedMs: number
  cumulativeActiveMs: number
}

export interface PlaybackTrackV1 {
  source: string
  sourceTrackId: string
  name: string
  singer: string
  durationMs: number | null
  playablePayload: LX.Music.MusicInfo | null
}

export interface PlaybackStartCommandV1 {
  version: 1
  playbackGroupUuid: string
  track: PlaybackTrackV1
  context: { type: string | null; id: string | null }
  resume: { listId: string | null; indexHint: number | null }
  startReason: PlaybackStartReason
  startPositionMs: number
  occurredAtMs: number
  consent: {
    recentAllowed: boolean
    statsAllowed: boolean
    privateMode: boolean
  }
}

export type PlaybackFactV1 =
  | { version: 1; type: 'play_start'; reason: PlaybackStartReason }
  | { version: 1; type: 'pause' | 'resume'; reason: PlaybackPauseReason }
  | {
      version: 1
      type: 'seek'
      origin: PlaybackSeekOrigin
      fromMs: number
      toMs: number
    }
  | {
      version: 1
      type: 'skip'
      reason: PlaybackSkipReason
      automatic: boolean
    }
  | { version: 1; type: 'play_end'; reason: 'natural_end' }
  | {
      version: 1
      type: 'error'
      stage: 'url' | 'load' | 'decode' | 'buffer' | 'output' | 'unknown'
      code: number | null
      recoverable: boolean
      attempt: number
    }

export interface PlaybackPreplayFailureV1 {
  version: 1
  playbackGroupUuid: string
  track: PlaybackTrackV1
  context: { type: string | null; id: string | null }
  resume: { listId: string | null; indexHint: number | null }
  startReason: PlaybackStartReason
  startPositionMs: number
  occurredAtMs: number
  error: Extract<PlaybackFactV1, { type: 'error' }>
  consent: PlaybackStartCommandV1['consent']
}

export interface PlaybackResumeUpdateV1 {
  version: 1
  playbackGroupUuid: string
  checkpointSeq: number
  track: Pick<PlaybackTrackV1, 'source' | 'sourceTrackId'>
  listId: string | null
  indexHint: number | null
  positionMs: number
  durationMs: number | null
  updatedAtMs: number
}

export interface PlaybackResumeAckV1 {
  playbackGroupUuid: string
  checkpointSeq: number
  positionMs: number
}
```

Define:

```ts
export type PlaybackStartResultV1 =
  | { mode: 'activity'; ack: PlaybackCheckpointAckV1 }
  | { mode: 'resume-only'; ack: PlaybackResumeAckV1 }
  | { mode: 'private'; playbackGroupUuid: string; checkpointSeq: number }

export type PlaybackCommitRequestV1 =
  | { version: 1; checkpoint: PlaybackCheckpointV1; fact?: PlaybackFactV1 }
  | {
      version: 1
      checkpoint: PlaybackCheckpointV1
      boundary: { type: 'day_boundary'; nextLocalDay: string; utcOffsetMinutes: number }
    }

export type PlaybackRecorderCommandV1 =
  | { kind: 'start'; request: PlaybackStartCommandV1 }
  | { kind: 'commit'; request: PlaybackCommitRequestV1 }
  | { kind: 'resume'; request: PlaybackResumeUpdateV1 }
  | { kind: 'preplay_failure'; request: PlaybackPreplayFailureV1 }

export interface RecentTrackV1 extends PlaybackTrackV1 {
  version: 1
  lastPlayedAtMs: number | null
  legacyRank: number | null
}

export interface ListeningBucketV1 {
  baselinePlayedMs: number
  livePlayedMs: number
  baselineActiveMs: number
  liveActiveMs: number
  playedMs: number
  activeMs: number
}

export interface ListeningStatsV1 {
  version: 1
  total: ListeningBucketV1
  daily: Array<ListeningBucketV1 & { localDay: string }>
  tracks: Array<ListeningBucketV1 & Omit<PlaybackTrackV1, 'playablePayload'>>
  updatedAtMs: number
}

export interface PlaybackResumeV1 {
  version: 1
  source: string
  sourceTrackId: string
  listId: string | null
  indexHint: number | null
  positionMs: number
  durationMs: number | null
  updatedAtMs: number
}
```

Use JSON byte caps: playable payload 128 KiB, context strings 256 characters, event details 16 KiB, UUIDs canonical v4 format, positions/durations 0 through 7 days in milliseconds. Validate `indexHint` as null or an integer from 0 through 1,000,000. A private start never queues a resume command; a both-disabled start uses only `PlaybackResumeUpdateV1`; all other starts use activity checkpoints. These modes are fixed by the consent snapshot on the first native `playing` transition.

- [ ] **Step 4: Verify GREEN**

```powershell
node --test build-config/storage/playback-contracts.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/common/storage/playback.ts src/common/storage/playbackValidation.ts build-config/storage/playback-contracts.test.js
git commit -m "feat: define playback activity contracts"
```

### Task 3: Add Playback Fact and Projection Schema

**Files:**
- Create: `src/main/worker/dbService/migrations/0006_playback_activity.ts`
- Modify: `src/main/worker/dbService/migrations/index.ts`
- Modify: `src/main/worker/dbService/schemaContract.ts`
- Create: `build-config/storage-electron/playback-schema.test.js`

**Interfaces:**
- Consumes: authoritative schema version `5`.
- Produces: schema version `6` and all playback/resume/projection tables.
- Used by: import and repository tasks.

- [ ] **Step 1: Write constraint and cascade tests**

```js
it('allows one open segment per playback group', () => {
  insertSession({ segmentNo: 0, state: 'playing' })
  assert.throws(() => insertSession({ segmentNo: 1, state: 'paused' }), /UNIQUE/)
})

it('sets recent last_session_id null when a retained session is deleted', () => {
  const sessionId = insertClosedSession()
  insertRecent({ trackId, lastSessionId: sessionId })
  db.prepare('delete from playback_sessions where session_id=?').run(sessionId)
  assert.equal(readRecent(trackId).last_session_id, null)
})

it('rejects unsupported session reasons and inconsistent terminal state', () => {
  assert.throws(() => insertSession({ startReason: 'unknown' }), /CHECK/)
  assert.throws(() => insertSession({ state: 'closed', endReason: null }), /CHECK/)
  assert.throws(() => insertSession({ state: 'interrupted', endReason: 'error' }), /CHECK/)
})

it('installs every projection and resume constraint', () => {
  assert.deepEqual(requiredTablesMissing(db), [])
  assert.throws(() => db.prepare('insert into activity_totals(id, updated_at_ms) values(2, 0)').run(), /CHECK/)
  assert.throws(() => insertProjectionState({ name: 'unknown' }), /CHECK/)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/playback-schema.test.js
```

Expected: FAIL because migration 6 is absent.

- [ ] **Step 3: Implement the complete schema**

Use the approved columns without weakening constraints:

```sql
CREATE TABLE track_snapshots (
  track_id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  name TEXT NOT NULL,
  singer TEXT NOT NULL,
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  playable_payload_json TEXT CHECK(playable_payload_json IS NULL OR json_valid(playable_payload_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  UNIQUE(source, source_track_id)
);

CREATE TABLE playback_sessions (
  session_id INTEGER PRIMARY KEY,
  session_uuid TEXT NOT NULL UNIQUE,
  playback_group_uuid TEXT NOT NULL,
  segment_no INTEGER NOT NULL CHECK(segment_no >= 0),
  track_id INTEGER NOT NULL REFERENCES track_snapshots(track_id),
  local_day TEXT NOT NULL CHECK(length(local_day) = 10),
  utc_offset_minutes INTEGER NOT NULL CHECK(utc_offset_minutes BETWEEN -840 AND 840),
  context_type TEXT,
  context_id TEXT,
  start_reason TEXT NOT NULL CHECK(start_reason IN (
    'select','next','previous','auto','restore','remote',
    'day_boundary','statistics_clear'
  )),
  end_reason TEXT CHECK(end_reason IS NULL OR end_reason IN (
    'next','previous','select','dislike','stop','error',
    'load_timeout','buffer_timeout','queue_removed','natural_end',
    'day_boundary','statistics_clear'
  )),
  started_at_ms INTEGER NOT NULL CHECK(started_at_ms >= 0),
  ended_at_ms INTEGER CHECK(ended_at_ms IS NULL OR ended_at_ms >= started_at_ms),
  start_position_ms INTEGER NOT NULL CHECK(start_position_ms >= 0),
  last_position_ms INTEGER NOT NULL CHECK(last_position_ms >= 0),
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  played_ms INTEGER NOT NULL DEFAULT 0 CHECK(played_ms >= 0),
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK(active_ms >= 0),
  cumulative_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(cumulative_played_ms >= 0),
  cumulative_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(cumulative_active_ms >= 0),
  checkpoint_seq INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_seq >= 0),
  state TEXT NOT NULL CHECK(state IN ('playing','paused','closed','interrupted')),
  recent_allowed INTEGER NOT NULL CHECK(recent_allowed IN (0,1)),
  stats_allowed INTEGER NOT NULL CHECK(stats_allowed IN (0,1)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  CHECK(cumulative_played_ms >= played_ms),
  CHECK(cumulative_active_ms >= active_ms),
  CHECK(
    (state IN ('playing','paused') AND ended_at_ms IS NULL AND end_reason IS NULL)
    OR (state = 'closed' AND ended_at_ms IS NOT NULL AND end_reason IS NOT NULL)
    OR (state = 'interrupted' AND ended_at_ms IS NOT NULL AND end_reason IS NULL)
  ),
  UNIQUE(playback_group_uuid, segment_no)
);

CREATE UNIQUE INDEX playback_one_open_group
ON playback_sessions(playback_group_uuid)
WHERE state IN ('playing','paused');

CREATE INDEX playback_retention
ON playback_sessions(state, ended_at_ms, session_id);

CREATE TABLE playback_events (
  event_id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES playback_sessions(session_id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL CHECK(sequence_no >= 0),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'play_start','pause','resume','seek','skip','play_end','error'
  )),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  position_ms INTEGER NOT NULL CHECK(position_ms >= 0),
  reason TEXT,
  details_json TEXT CHECK(details_json IS NULL OR json_valid(details_json)),
  CHECK(
    (event_type = 'play_start' AND reason IN (
      'select','next','previous','auto','restore','remote',
      'day_boundary','statistics_clear'
    ))
    OR (event_type IN ('pause','resume') AND reason IN ('user','device','remote','recovery'))
    OR (event_type = 'seek' AND reason IN (
      'bar','hotkey','media_session','lyric','party','restore','buffer_recovery'
    ))
    OR (event_type = 'skip' AND reason IN (
      'next','previous','select','dislike','stop','error',
      'load_timeout','buffer_timeout','queue_removed'
    ))
    OR (event_type = 'play_end' AND reason = 'natural_end')
    OR (event_type = 'error' AND reason IS NULL)
  ),
  UNIQUE(session_id, sequence_no)
);

CREATE TABLE recent_tracks (
  track_id INTEGER PRIMARY KEY REFERENCES track_snapshots(track_id) ON DELETE CASCADE,
  recency_seq INTEGER NOT NULL UNIQUE,
  last_session_id INTEGER REFERENCES playback_sessions(session_id) ON DELETE SET NULL,
  last_played_at_ms INTEGER CHECK(last_played_at_ms IS NULL OR last_played_at_ms >= 0),
  legacy_rank INTEGER CHECK(legacy_rank IS NULL OR legacy_rank BETWEEN 1 AND 520),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE INDEX recent_tracks_order ON recent_tracks(recency_seq DESC);

CREATE TABLE listening_daily (
  local_day TEXT PRIMARY KEY CHECK(length(local_day) = 10),
  baseline_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(baseline_played_ms >= 0),
  live_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(live_played_ms >= 0),
  baseline_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(baseline_active_ms >= 0),
  live_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(live_active_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE listening_tracks (
  track_id INTEGER PRIMARY KEY REFERENCES track_snapshots(track_id) ON DELETE CASCADE,
  baseline_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(baseline_played_ms >= 0),
  live_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(live_played_ms >= 0),
  baseline_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(baseline_active_ms >= 0),
  live_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(live_active_ms >= 0),
  last_played_at_ms INTEGER CHECK(last_played_at_ms IS NULL OR last_played_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE activity_totals (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  baseline_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(baseline_played_ms >= 0),
  live_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(live_played_ms >= 0),
  baseline_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(baseline_active_ms >= 0),
  live_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(live_active_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE projection_state (
  name TEXT PRIMARY KEY CHECK(name IN ('recent','statistics')),
  version INTEGER NOT NULL CHECK(version >= 1),
  last_session_id INTEGER REFERENCES playback_sessions(session_id) ON DELETE SET NULL,
  visible_after_ms INTEGER CHECK(visible_after_ms IS NULL OR visible_after_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE playback_resume_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  playback_group_uuid TEXT NOT NULL,
  checkpoint_seq INTEGER NOT NULL CHECK(checkpoint_seq >= 0),
  source TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  list_id TEXT,
  index_hint INTEGER CHECK(index_hint IS NULL OR index_hint BETWEEN 0 AND 1000000),
  position_ms INTEGER NOT NULL CHECK(position_ms >= 0),
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

INSERT INTO activity_totals(id, updated_at_ms) VALUES(1, 0);
INSERT INTO projection_state(name, version, updated_at_ms)
VALUES ('recent', 1, 0), ('statistics', 1, 0);
```

- [ ] **Step 4: Verify GREEN and database checks**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/playback-schema.test.js
npm run build:main
```

Expected: PASS, including `foreign_key_check` and structural verification.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/migrations/0006_playback_activity.ts src/main/worker/dbService/migrations/index.ts src/main/worker/dbService/schemaContract.ts build-config/storage-electron/playback-schema.test.js
git commit -m "feat: add playback activity schema"
```

### Task 4: Import Frozen Legacy Activity Without Fabricating Facts

**Files:**
- Create: `src/main/migration/legacyData/activity.ts`
- Modify: `src/main/storage/credentials/types.ts`
- Modify: `src/main/startup/storageCoordinator.ts`
- Create: `build-config/storage-electron/playback-migration.test.js`

**Interfaces:**
- Consumes: the same legacy snapshot source, recent list, listening converter, legacy resume, marker/vault services.
- Produces: playback baselines, resume state, `legacy_data_v1.playback_activity`, encrypted unknown-key quarantine, and eventually `crossArtifactComplete`.
- Guarantees: zero synthetic sessions/events/timestamps for legacy data.

- [ ] **Step 1: Write ordering, mismatch, retry, and quarantine tests**

```js
it('imports recent order with negative sequence and no invented time/session', async() => {
  await migrateActivity(fixture({ recentPlayList: [trackA, trackB] }))
  assert.deepEqual(readRecent(), [
    { sourceTrackId: trackA.id, recencySeq: -1, legacyRank: 1, lastPlayedAtMs: null, lastSessionId: null },
    { sourceTrackId: trackB.id, recencySeq: -2, legacyRank: 2, lastPlayedAtMs: null, lastSessionId: null },
  ])
  assert.equal(countRows('playback_sessions'), 0)
  assert.equal(countRows('playback_events'), 0)
})

it('quarantines unknown keys encrypted and omits known obsolete keys', async() => {
  await migrateActivity(fixture({ futureKey: { secretLike: 'VALUE' }, ignoreVersion: '1', lastStartInfo: {} }))
  assert.equal(vault.read(quarantineRef).status, 'available')
  assert.deepEqual(Object.keys(vault.read(quarantineRef).value.payload), ['futureKey'])
  assert.doesNotMatch(await fs.readFile(vaultPath, 'utf8'), /VALUE/)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/playback-migration.test.js
```

Expected: FAIL because the activity importer is absent.

- [ ] **Step 3: Freeze writers and import one atomic DB snapshot**

Before renderer registration, disable legacy writes for `playInfo`, `recentPlayList`, and `listeningTimeStats`; parse the final frozen values and compute one activity-domain hash. In one `BEGIN IMMEDIATE` transaction:

1. upsert validated/sanitized recent track snapshots;
2. insert at most 520 recent rows with `recency_seq=-legacy_rank`;
3. upsert identity/display-only track snapshots for legacy listening songs;
4. write daily/track/total `baseline_played_ms` independently and zero active baselines;
5. import validated resume identity/list/index hint/position without inventing a session;
6. write the activity marker with counts, mismatch values, and `baselineActiveTimeKnown:false`.

On retry, matching marker/hash returns the verified target. A mismatching marker is fatal. Never merge by addition.

Extend the vault payload:

```ts
export interface LegacyQuarantinePayloadV1 {
  version: 1
  sourceSha256: string
  keys: string[]
  payload: Record<string, JsonValue>
}
```

Quarantine keys not in the complete known allowlist. Known obsolete `ignoreVersion` and `lastStartInfo` are dropped. Known migrated/account keys are neither quarantined nor retained. Do not write `crossArtifactComplete` until Tasks 5-9 switch and smoke-test every activity reader/writer.

- [ ] **Step 4: Verify GREEN and idempotence**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/playback-migration.test.js
```

Expected: PASS at injected failures before transaction, inside transaction, after commit, after quarantine, and before marker completion.

- [ ] **Step 5: Commit**

```powershell
git add src/main/migration/legacyData/activity.ts src/main/storage/credentials/types.ts src/main/startup/storageCoordinator.ts build-config/storage-electron/playback-migration.test.js
git commit -m "feat: import legacy playback baselines"
```

### Task 5: Implement the Pure Renderer Recorder

**Files:**
- Create: `src/renderer/core/playbackRecorder/types.ts`
- Create: `src/renderer/core/playbackRecorder/reducer.ts`
- Create: `src/renderer/core/playbackRecorder/sampler.ts`
- Create: `src/renderer/core/playbackRecorder/boundary.ts`
- Create: `build-config/storage/playback-recorder.test.js`

**Interfaces:**
- Consumes: explicit player actions plus injected monotonic/media samples.
- Produces: deterministic `PlaybackRecorderCommandV1[]` outbox and state.
- Does not perform: IPC, timers, DOM access, or persistence.

- [ ] **Step 1: Write the state-machine matrix**

Cover pending/first-playing idempotence, pause/resume, buffering, user/system seek, rate change, delayed background samples, natural end, manual/automatic skip, retryable error, final pre-play error, repeat, teardown, ack/retry, and midnight.

```js
it('does not discard a delayed valid background sample', () => {
  let state = playingState({ monotonicMs: 1000, positionMs: 1000, playbackRate: 1 })
  state = reduce(state, { type: 'sample', monotonicMs: 7000, positionMs: 7000 })
  assert.equal(state.cumulativePlayedMs, 6000)
  assert.equal(state.cumulativeActiveMs, 6000)
})

it('excludes a party seek and resets sampling baselines', () => {
  const state = reduce(playingState(), {
    type: 'seek-requested', origin: 'party', fromMs: 1000, toMs: 90000,
    monotonicMs: 2000,
  })
  assert.equal(state.cumulativePlayedMs, 1000)
  assert.equal(lastCommand(state).fact.origin, 'party')
  assert.equal(state.sample.positionMs, 90000)
})

it('uses civil midnight across 23-hour and 25-hour DST days', () => {
  const spring = nextLocalDayBoundary({
    afterMs: Date.parse('2026-03-08T05:00:00.000Z'),
    timeZone: 'America/New_York',
  })
  assert.deepEqual(spring, {
    occurredAtMs: Date.parse('2026-03-09T04:00:00.000Z'),
    nextLocalDay: '2026-03-09',
    utcOffsetMinutes: -240,
  })

  const fall = nextLocalDayBoundary({
    afterMs: Date.parse('2026-11-01T04:00:00.000Z'),
    timeZone: 'America/New_York',
  })
  assert.deepEqual(fall, {
    occurredAtMs: Date.parse('2026-11-02T05:00:00.000Z'),
    nextLocalDay: '2026-11-02',
    utcOffsetMinutes: -300,
  })
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/playback-recorder.test.js
```

Expected: FAIL because the reducer is absent.

- [ ] **Step 3: Implement pure state and sampling rules**

```ts
export interface PlaybackSessionState {
  phase: 'idle' | 'pending' | 'playing' | 'buffering' | 'paused' | 'closing'
  pending: PlaybackStartCommandV1 | null
  playbackGroupUuid: string | null
  checkpointSeq: number
  cumulativePlayedMs: number
  cumulativeActiveMs: number
  playbackRate: number
  sample: { monotonicMs: number; positionMs: number } | null
  acknowledged: PlaybackCheckpointAckV1 | PlaybackResumeAckV1 | null
  outbox: PlaybackRecorderCommandV1[]
}
```

While `playing`, active delta is `max(0, monotonicNow-lastMonotonic)`. Played delta is media position delta only when non-negative and no greater than `activeDelta * playbackRate + 1000`; otherwise it is zero and the baseline resets. `buffering`, `paused`, and `pending` add neither value. Policy with `statsAllowed:false` keeps both cumulative counters at zero. Boundary scheduling uses `Intl.DateTimeFormat` with the injected IANA time zone to find the next civil calendar midnight; it must not add a fixed 24 hours. It emits a checkpoint plus explicit day boundary, and the worker verifies the supplied day/offset.

Every semantic action first samples/checkpoints the pre-transition state, adds at most one fact, and retains the command until an ack equal to or beyond its sequence. A failed send remains at the head of the outbox.

- [ ] **Step 4: Verify GREEN**

```powershell
node --test build-config/storage/playback-recorder.test.js
```

Expected: PASS for all table-driven transitions.

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/core/playbackRecorder build-config/storage/playback-recorder.test.js
git commit -m "feat: add playback recorder state machine"
```

### Task 6: Implement Atomic Worker Checkpoints and Projections

**Files:**
- Create: `src/main/worker/dbService/modules/playback/statements.ts`
- Create: `src/main/worker/dbService/modules/playback/dbHelper.ts`
- Create: `src/main/worker/dbService/modules/playback/projections.ts`
- Create: `src/main/worker/dbService/modules/playback/repository.ts`
- Create: `src/main/worker/dbService/modules/playback/index.ts`
- Modify: `src/main/worker/dbService/modules/index.ts`
- Modify: `src/main/worker/dbService/index.ts`
- Create: `build-config/storage-electron/playback-storage.test.js`

**Interfaces:**
- Consumes: Task 2 DTOs and Task 3 schema.
- Produces: start, commit, pre-play failure, query, interrupt, and active-boundary RPC.
- Guarantees: session/event/resume/projections commit or roll back together.

- [ ] **Step 1: Write idempotence and rollback tests**

```js
it('acks duplicate and out-of-order checkpoints without a second delta or event', () => {
  const first = repository.playbackCommit(commitAt(2, 1000, pauseFact))
  const duplicate = repository.playbackCommit(commitAt(2, 1000, pauseFact))
  const stale = repository.playbackCommit(commitAt(1, 500))
  assert.deepEqual(duplicate, first)
  assert.deepEqual(stale, first)
  assert.equal(readTotalLivePlayedMs(), 1000)
  assert.equal(countEvents('pause'), 1)
})

it('rolls back session and every projection after an injected projection failure', () => {
  assert.throws(() => repository.playbackCommit(commitAt(2, 1000), { failAt: 'after-daily' }))
  assert.equal(readSession().checkpoint_seq, 1)
  assert.equal(readDailyLivePlayedMs(), 0)
  assert.equal(readTrackLivePlayedMs(), 0)
  assert.equal(readTotalLivePlayedMs(), 0)
})

it('enforces all consent combinations and private playback', () => {
  const matrix = [
    { recentAllowed: true,  statsAllowed: true,  privateMode: false, sessions: 1, recent: 1, playedMs: 1000, resume: 1 },
    { recentAllowed: true,  statsAllowed: false, privateMode: false, sessions: 1, recent: 1, playedMs: 0,    resume: 1 },
    { recentAllowed: false, statsAllowed: true,  privateMode: false, sessions: 1, recent: 0, playedMs: 1000, resume: 1 },
    { recentAllowed: false, statsAllowed: false, privateMode: false, sessions: 0, recent: 0, playedMs: 0,    resume: 1 },
    { recentAllowed: true,  statsAllowed: true,  privateMode: true,  sessions: 0, recent: 0, playedMs: 0,    resume: 0 },
  ]

  for (const expected of matrix) {
    resetDatabase()
    runOneSecondPlayback(repository, expected)
    assert.deepEqual(readPolicyEffects(), {
      sessions: expected.sessions,
      recent: expected.recent,
      playedMs: expected.playedMs,
      resume: expected.resume,
    })
  }
})

it('latches consent at first playing and ignores a mid-session policy change', () => {
  const start = repository.playbackStart(startCommand({ recentAllowed: false, statsAllowed: true }))
  repository.playbackCommit(commitAt(2, 1000))
  setCurrentPolicy({ recentAllowed: true, statsAllowed: false })
  repository.playbackCommit(commitAt(3, 2000))
  assert.equal(readRecent().length, 0)
  assert.equal(readTotalLivePlayedMs(), 2000)
  assert.equal(readSession(start.ack.sessionUuid).recent_allowed, 0)
  assert.equal(readSession(start.ack.sessionUuid).stats_allowed, 1)
})

it('rotates a DST boundary without changing the group or duplicating delta', () => {
  repository.playbackStart(startAtNewYorkMidnight('2026-03-08'))
  const ack = repository.playbackCommit(boundaryCommit({
    occurredAtMs: Date.parse('2026-03-09T04:00:00.000Z'),
    nextLocalDay: '2026-03-09',
    utcOffsetMinutes: -240,
    cumulativePlayedMs: 23 * 60 * 60 * 1000,
  }))
  assert.equal(ack.playbackGroupUuid, groupId)
  assert.equal(ack.segmentNo, 1)
  assert.equal(readSegment(0).utcOffsetMinutes, -300)
  assert.equal(readSegment(1).utcOffsetMinutes, -240)
  assert.equal(readTotalLivePlayedMs(), 23 * 60 * 60 * 1000)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/playback-storage.test.js
```

Expected: FAIL because repository methods are absent.

- [ ] **Step 3: Implement the worker API**

```ts
playbackStart(input: PlaybackStartCommandV1): PlaybackStartResultV1
playbackCommit(input: PlaybackCommitRequestV1): PlaybackCheckpointAckV1
playbackUpdateResume(input: PlaybackResumeUpdateV1): PlaybackResumeAckV1
playbackRecordPreplayFailure(input: PlaybackPreplayFailureV1): PlaybackCheckpointAckV1
playbackGetRecent(input: { version: 1; limit: number }): RecentTrackV1[]
playbackGetListeningStats(): ListeningStatsV1
playbackGetResume(): PlaybackResumeV1 | null
playbackMarkStaleSessionsInterrupted(input: { nowMs: number }): number
```

`playbackStart()` is idempotent by group UUID. On first activity-mode start it upserts the sanitized track, inserts segment 0, appends `play_start` using checkpoint sequence 1, updates recent only when allowed, and writes resume in one immediate transaction. With statistics disabled, session played/active counters remain zero. For both policy flags false, persist only the direct-identity resume row and return its resume acknowledgement; do not insert a track snapshot, session, event, recent row, or listening contribution. For private mode, persist nothing and return private mode. The first start latches both flags in the session, and later settings changes cannot alter it.

`playbackCommit()` resolves the one open segment, verifies increasing sequence and non-decreasing cumulative values, calculates delta from stored cumulative counters, updates session, resume, and allowed live projections, appends an optional fact using the checkpoint sequence, and commits before returning. Day boundary first closes the old segment with `end_reason='day_boundary'`, opens the next segment carrying the cumulative baseline/sequence and zero segment totals, then applies no duplicate delta. If no segment is open, look up the group's latest terminal segment: a request at or below its stored sequence returns that terminal acknowledgement unchanged, while a newer request fails with `playback_group_closed`. This makes a post-crash duplicate harmless without reopening or extending an interrupted session.

`playbackUpdateResume()` handles both-disabled mode without creating activity. It accepts a newer sequence for the same group, or a different group only when `updatedAtMs` is not older than the stored row. Duplicate/stale input returns the stored acknowledgement. Private mode never calls it. `playbackRecordPreplayFailure()` creates the documented zero-duration failure fact only when at least one activity consent flag is enabled; it rejects a both-disabled/private request before any write, and the recorder does not send that command in those modes.

On startup, set stale open rows to `state='interrupted'`, `ended_at_ms=now`, keep `end_reason=NULL`, and add no event/duration. A final pre-play failure inserts a closed zero-duration session and final error event with recent/stats flags false.

- [ ] **Step 4: Verify GREEN and worker build**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/playback-storage.test.js
npm run build:main
npm run test:main-bundle
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/modules/playback src/main/worker/dbService/modules/index.ts src/main/worker/dbService/index.ts build-config/storage-electron/playback-storage.test.js
git commit -m "feat: persist atomic playback checkpoints"
```

### Task 7: Add Typed Playback IPC and Reliable Command Delivery

**Files:**
- Create: `src/main/modules/winMain/rendererEvent/playback.ts`
- Create: `src/renderer/utils/playback.ts`
- Create: `src/renderer/core/playbackRecorder/index.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/main/modules/winMain/rendererEvent/index.ts`
- Create: `build-config/storage/playback-ipc.test.js`

**Interfaces:**
- Consumes: common validators, worker playback RPC, and pure recorder commands.
- Produces: validated start/commit/failure/query endpoints and one-at-a-time retry delivery.
- Guarantees: an acknowledgement loss cannot redirect a checkpoint to a closed segment.

- [ ] **Step 1: Write validation and lost-ack tests**

```js
it('retries an unacknowledged command with the same group and sequence', async() => {
  transport.failResponseAfterCommitOnce = true
  await recorder.flush()
  await recorder.flush()
  assert.deepEqual(transport.requests.map(item => [item.checkpoint.playbackGroupUuid, item.checkpoint.checkpointSeq]), [
    [groupId, 2], [groupId, 2],
  ])
  assert.equal(repository.totalPlayedMs(), 1000)
})

it('rejects malformed payloads before worker dispatch', async() => {
  await assert.rejects(handler({ version: 1, checkpoint: { checkpointSeq: -1 } }))
  assert.equal(workerCalls.length, 0)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/playback-ipc.test.js
```

Expected: FAIL because typed playback IPC is absent.

- [ ] **Step 3: Implement the exact endpoints and delivery loop**

Add names:

```text
playback_start
playback_commit
playback_resume_update
playback_preplay_failure
playback_recent_get
playback_listening_get
playback_resume_get
```

The main handlers parse every payload and return worker results unchanged. The renderer delivery loop sends only the outbox head, removes it only after a matching/higher activity or resume acknowledgement, uses bounded exponential retry while the window lives, and exposes `flush({timeoutMs})` for pause/teardown/shutdown. It never logs request bodies. Activity, resume-only, and private modes are mutually exclusive for the lifetime of a playback group.

- [ ] **Step 4: Verify GREEN and builds**

```powershell
node --test build-config/storage/playback-ipc.test.js
npm run build:main
npm run build:renderer
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/modules/winMain/rendererEvent/playback.ts src/renderer/utils/playback.ts src/renderer/core/playbackRecorder/index.ts src/common/ipcNames.ts src/main/modules/winMain/rendererEvent/index.ts build-config/storage/playback-ipc.test.js
git commit -m "feat: add reliable playback IPC"
```

### Task 8: Carry Typed Transition Intent Through the Player

**Files:**
- Modify: `src/renderer/event/appEvent.ts`
- Modify: `src/renderer/plugins/player/index.ts`
- Modify: `src/renderer/core/player/action.ts`
- Modify: `src/renderer/core/useApp/usePlayer/usePlayerEvent.ts`
- Modify: `src/renderer/core/useApp/usePlayer/usePlayEvent.ts`
- Modify: `src/renderer/core/useApp/usePlayer/useMediaSessionInfo.ts`
- Modify: `src/renderer/core/useApp/useParty.ts`
- Modify: `src/renderer/utils/compositions/useLyric.js`
- Modify: `src/renderer/components/common/ProgressBar.vue`
- Modify: all `playNext(true)`/`playPrev(true)` callers returned by the required scan.
- Create: `build-config/storage/playback-intent-callsite.test.js`

**Interfaces:**
- Consumes: reason/origin types from Task 2.
- Produces: explicit source intent at every recorder transition.
- Removes: ambiguous `isAutoToggle:boolean` classification.

- [ ] **Step 1: Write a source-level completeness test**

```js
it('contains no boolean automatic-next calls or originless seeks', () => {
  const source = readRendererSource()
  assert.doesNotMatch(source, /playNext\((true|false)\)/)
  assert.doesNotMatch(source, /playPrev\((true|false)\)/)
  assert.doesNotMatch(source, /app_event\.setProgress\([^,\n\)]*\)/)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/playback-intent-callsite.test.js
```

Expected: FAIL and list every ambiguous call site.

- [ ] **Step 3: Define and wire explicit player intent**

```ts
export interface PlaybackAdvanceOptions {
  automatic: boolean
  reason: PlaybackSkipReason | 'natural_end'
}

export const playNext = async(
  options: PlaybackAdvanceOptions = { automatic: false, reason: 'next' },
): Promise<void>
```

Map natural ended to `{automatic:true,reason:'natural_end'}`, user next to `next`, previous to `previous`, dislike to `dislike`, buffering timeout to `buffer_timeout`, URL/load timeout to `load_timeout`, exhausted error to `error`, removed current queue item to `queue_removed`, and another selection to `select`. The recorder ignores a natural-end advance after it already closed the session.

Change `appEvent.setProgress()` to require origin. Map ProgressBar=`bar`, keyboard=`hotkey`, media session=`media_session`, lyric=`lyric`, party sync=`party`, restore=`restore`, and internal buffering recovery=`buffer_recovery`. Add native `seeking`, `seeked`, and `ratechange` subscriptions in the player plugin, and preserve native waiting/canplay transitions.

- [ ] **Step 4: Verify GREEN and renderer build**

```powershell
node --test build-config/storage/playback-intent-callsite.test.js
npm run build:renderer
```

Expected: PASS.

- [ ] **Step 5: Commit**

Stage the exact files reported by `git diff --name-only` for this task, excluding the two user-owned listening files:

```powershell
git add src/renderer/event/appEvent.ts src/renderer/plugins/player/index.ts src/renderer/core/player/action.ts src/renderer/core/useApp/usePlayer src/renderer/core/useApp/useParty.ts src/renderer/utils/compositions/useLyric.js src/renderer/components/common/ProgressBar.vue build-config/storage/playback-intent-callsite.test.js
git commit -m "refactor: carry typed playback intent"
```

### Task 9: Integrate Recorder and Cut Resume/Recent/Listening Callers Over

**Files:**
- Create: `src/renderer/core/useApp/usePlayer/usePlaybackRecorder.ts`
- Modify: `src/renderer/core/useApp/usePlayer/usePlayer.ts`
- Modify: `src/renderer/core/useApp/usePlayer/usePlayProgress.ts`
- Modify: `src/renderer/store/recentPlay/action.ts`
- Modify: `src/renderer/store/recentPlay/state.ts`
- Modify: `src/renderer/store/listeningTime/action.ts`
- Modify: `src/renderer/store/listeningTime/state.ts`
- Modify: `src/renderer/core/useApp/useDataInit.ts`
- Modify: `src/renderer/views/RecentPlay/index.vue`
- Modify: `src/renderer/views/Setting/components/SettingListeningTime.vue`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/main/modules/winMain/rendererEvent/data.ts`
- Create: `build-config/storage/playback-cutover.test.js`

**Interfaces:**
- Consumes: recorder service and typed playback queries.
- Produces: query-backed renderer stores, 15-second checkpoint timer, bounded final flush, and disabled legacy activity endpoints.
- Removes: 2-second resume, 1-second recent, and 5-second listening full-file writes.

- [ ] **Step 1: Write load-failure, first-playing, and legacy-writer scan tests**

```js
it('adds recent only after native playing', async() => {
  recorder.trackSelected(track)
  assert.equal(await recentCount(), 0)
  await recorder.nativePlaying(sample)
  assert.equal(await recentCount(), 1)
  await recorder.nativePlaying(sample)
  assert.equal(await recentCount(), 1)
})

it('contains no legacy activity save calls', () => {
  const source = readFiles(activityCallerFiles)
  assert.doesNotMatch(source, /savePlayInfo|saveRecentPlayList|saveListeningTimeStats/)
  assert.doesNotMatch(source, /DATA_KEYS\.(playInfo|recentPlayList|listeningTimeStats)/)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/playback-cutover.test.js
```

Expected: FAIL because `musicToggled` currently updates recent and progress writes JSON.

- [ ] **Step 3: Integrate the recorder hook**

`usePlaybackRecorder()` registers player/app events, creates a group UUID at selection, starts only at native playing, samples every timeupdate without using `delta <= 2`, checkpoints every 15 seconds, schedules midnight, and immediately flushes before pause, seek, skip, end, error, playback-rate change, renderer unmount, and app shutdown. Activity mode sends facts/checkpoints, both-disabled mode sends only `playback_resume_update`, and private mode sends no persistence IPC. Latch the policy snapshot at first playing; do not reread it until the next group.

Remove `addRecentPlayMusic()` from `handleUpdatePlayInfo()`. Replace recent initialization with `playbackGetRecent({limit:520})`; model each row as display identity plus nullable `playablePayload`. The Recent view disables playback for a null payload instead of fabricating one.

Replace listening state with `ListeningStatsV1` millisecond values. UI selectors divide by 1000 only at formatting boundaries. Keep `src/common/utils/listeningTime.ts` available for legacy conversion and development comparison, but do not persist its shadow object.

Replace resume initialization with `playbackGetResume()` and resolve by `{source,sourceTrackId}` first; use `listId/indexHint` only when the identity still matches. Disable the three activity branches in `rendererEvent/data.ts` once the activity marker matches; requests return a fixed `legacy_activity_disabled` error and never write JSON.

- [ ] **Step 4: Add bounded shutdown registration and verify GREEN**

Register the recorder with foundation `registerShutdownFlusher('playback', () => recorder.flush({timeoutMs:2500}))`. Run:

```powershell
node --test build-config/storage/playback-cutover.test.js
node --test build-config/listening-time.test.js build-config/storage/playback-recorder.test.js
npm run build:main
npm run build:renderer
```

Expected: PASS.

- [ ] **Step 5: Commit without staging user-owned files**

```powershell
git add src/renderer/core/useApp/usePlayer src/renderer/store/recentPlay src/renderer/store/listeningTime src/renderer/core/useApp/useDataInit.ts src/renderer/views/RecentPlay/index.vue src/renderer/views/Setting/components/SettingListeningTime.vue src/renderer/utils/ipc.ts src/main/modules/winMain/rendererEvent/data.ts build-config/storage/playback-cutover.test.js
git commit -m "refactor: cut playback state over to database"
```

### Task 10: Add Retention and Distinct Clear Semantics

**Files:**
- Create: `src/main/worker/dbService/modules/playback/retention.ts`
- Create: `src/main/worker/dbService/modules/playback/clear.ts`
- Modify: `src/main/worker/dbService/modules/playback/index.ts`
- Modify: `src/main/worker/dbService/index.ts`
- Create: `build-config/storage-electron/playback-retention.test.js`
- Create: `build-config/storage-electron/playback-clear.test.js`

**Interfaces:**
- Consumes: active checkpoint, projection cutoffs, and playback repository.
- Produces: batch compaction and four distinct playback/device clear RPC methods.
- Used by: final storage-clear UI plan.

- [ ] **Step 1: Write retention and clear-boundary tests**

```js
it('moves eligible live contributions to baseline before deleting a session', () => {
  const before = readListeningTotal()
  const result = repository.playbackCompact({ nowMs, batchSize: 500 })
  const after = readListeningTotal()
  assert.equal(result.deleted, 1)
  assert.deepEqual(after.total, before.total)
  assert.equal(after.livePlayedMs, before.livePlayedMs - compacted.playedMs)
  assert.equal(after.baselinePlayedMs, before.baselinePlayedMs + compacted.playedMs)
})

it('rotates an active segment before clearing statistics', () => {
  const ack = repository.playbackClearStatistics({ occurredAtMs: clearAt, activeCheckpoint })
  assert.equal(readSegment(0).endReason, 'statistics_clear')
  assert.equal(readSegment(1).startReason, 'statistics_clear')
  assert.equal(readSegment(1).cumulativePlayedMs, ack.cumulativePlayedMs)
  assert.equal(readListeningTotal().total, 0)
  assert.equal(readRecent().length, 1)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/playback-retention.test.js build-config/storage-electron/playback-clear.test.js
```

Expected: FAIL because retention/clear methods are absent.

- [ ] **Step 3: Implement exact operations**

```ts
playbackCompact(input: { nowMs: number; batchSize: number }): { deleted: number; remainingEligible: number }
playbackClearRecent(input: { occurredAtMs: number }): void
playbackClearStatistics(input: {
  occurredAtMs: number
  activeCheckpoint?: PlaybackCheckpointV1
}): PlaybackCheckpointAckV1 | null
playbackDeleteAllActivity(input: { occurredAtMs: number }): void
playbackResetDeviceState(): void
```

Select at most 500 terminal rows that are older than 12 months OR outside the newest 100,000 closed/interrupted sessions. For stats-allowed sessions whose segment starts at/after the statistics cutoff, subtract its contribution from live and add it to baseline for daily/track/total in the deletion transaction. Then delete the session and cascade events. Do not run startup `VACUUM`; expose an explicit idle compaction check for free-page ratio above 25% and adequate temporary disk space.

Recent clear deletes `recent_tracks` and updates the recent cutoff. Statistics clear checkpoints and rotates the active group, zeros all listening baseline/live values, and writes the statistics cutoff in one transaction. Delete-all clears resume, sessions/events, recent, listening, totals, and cutoffs, then deletes unreferenced track snapshots. Device reset clears `local_state` plus resume only and does not touch facts/projections.

- [ ] **Step 4: Verify GREEN**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/playback-retention.test.js build-config/storage-electron/playback-clear.test.js
```

Expected: PASS, including active statistics-clear, interrupted retention, consent/cutoff exclusions, and all-activity snapshot cleanup.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/modules/playback/retention.ts src/main/worker/dbService/modules/playback/clear.ts src/main/worker/dbService/modules/playback/index.ts src/main/worker/dbService/index.ts build-config/storage-electron/playback-retention.test.js build-config/storage-electron/playback-clear.test.js
git commit -m "feat: add playback retention and clear semantics"
```

### Task 11: Run Development Comparison and Complete Phase 3 Markers

**Files:**
- Create: `src/renderer/core/playbackRecorder/comparison.ts`
- Modify: `src/renderer/core/useApp/usePlayer/usePlaybackRecorder.ts`
- Modify: `src/main/migration/legacyData/activity.ts`
- Modify: `src/main/startup/storageCoordinator.ts`
- Create: `build-config/storage/playback-comparison.test.js`
- Create: `build-config/storage-electron/playback-phase3.integration.test.js`
- Create: `build-config/storage-electron/playback-renderer-crash.integration.test.js`
- Create: `build-config/storage/fixtures/playback-recorder-child.mjs`

**Interfaces:**
- Consumes: current in-memory listening helper, new recorder deltas, all destination markers, and typed smoke checks.
- Produces: development-only delta diagnostics and `legacy_data_v1.cross_artifact_complete`.
- Does not persist: two competing listening models.

- [ ] **Step 1: Write comparison and completion-gate tests**

```js
it('compares deltas without calling a legacy persistence function', () => {
  compare.recordNewDelta({ playedMs: 1250, track })
  compare.recordLegacyDelta({ seconds: 1.25, track })
  assert.deepEqual(compare.flush(), { playedDifferenceMs: 0, trackDifferences: [] })
  assert.equal(legacySaveCalls, 0)
})

it('refuses the cross-artifact marker until every typed reader and writer passes', async() => {
  smokeChecks.playbackWriter = false
  await assert.rejects(completePhase3(), /playbackWriter/)
  assert.equal(readMarker('legacy_data_v1.cross_artifact_complete'), null)
})

it('loses less than one interval when the renderer process is terminated', async() => {
  const child = await startRecorderChild({ checkpointEveryMs: 15000 })
  await child.start(groupId)
  await child.advanceAndCheckpoint({ cumulativePlayedMs: 15000, checkpointSeq: 2 })
  await waitForStoredCheckpoint(groupId, 2)
  await child.advanceWithoutCheckpoint({ cumulativePlayedMs: 29999 })
  await child.terminate()

  reopenDatabaseAndInterruptStaleSessions()
  assert.equal(readTotalLivePlayedMs(), 15000)
  assert.equal(29999 - readTotalLivePlayedMs(), 14999)
  assert.equal(readSession().state, 'interrupted')
  assert.equal(readSession().end_reason, null)

  repository.playbackCommit(commitAt(2, 15000))
  assert.equal(readTotalLivePlayedMs(), 15000)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/playback-comparison.test.js
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/playback-phase3.integration.test.js
```

Expected: FAIL because the comparison/gate is absent.

- [ ] **Step 3: Implement the development-only comparison**

Enable only when `LX_STORAGE_COMPARE_PLAYBACK=1` in non-production builds. Feed the same accepted media samples to an in-memory `ListeningTimeStats` shadow and the new recorder; compare cumulative/track/day deltas at checkpoints. Log only numeric differences and source/track hashes, never music payloads. Do not call `saveListeningTimeStats()`.

`playback-recorder-child.mjs` runs the real pure reducer behind a process IPC test adapter and an injected clock, so the test advances 29.999 seconds without wall-clock sleeps. The parent commits child messages through the real repository, waits until sequence `2` is durable, then terminates the child with `child.kill()` and waits for its exit before reopening the database. Run a second fixture where the parent commits sequence `2` but deliberately drops its acknowledgement; retrying the identical request before termination and after reopening must keep every session/event/projection count unchanged.

Complete Phase 3 only when credential, account profile, Phase 2, activity import, quarantine, typed reader, and typed writer checks all pass. Write `legacy_data_v1.cross_artifact_complete` with versioned check names and hashes. The final backup/cleanup plan performs the next-successful-start redaction.

- [ ] **Step 4: Run the complete Phase 3 verification**

```powershell
node --test build-config/listening-time.test.js
node --test build-config/storage/legacy-listening-conversion.test.js build-config/storage/playback-*.test.js
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/playback-*.test.js
npm run lint
npm run build:main
npm run build:renderer
npm run test:main-bundle
rg -n "DATA_KEYS\.(playInfo|recentPlayList|listeningTimeStats)|savePlayInfo|saveRecentPlayList|saveListeningTimeStats" src
git status --short
```

Expected: tests/builds pass; the `rg` output is limited to migration compatibility or disabled legacy wrappers awaiting final deletion. The two existing user-owned files remain visible and uncommitted unless separately handled by the user.

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/core/playbackRecorder/comparison.ts src/renderer/core/useApp/usePlayer/usePlaybackRecorder.ts src/main/migration/legacyData/activity.ts src/main/startup/storageCoordinator.ts build-config/storage/playback-comparison.test.js build-config/storage-electron/playback-phase3.integration.test.js build-config/storage-electron/playback-renderer-crash.integration.test.js build-config/storage/fixtures/playback-recorder-child.mjs
git commit -m "test: verify playback activity cutover"
```

## Phase 3 Acceptance Gate

Do not begin cache separation until all statements are true:

1. Legacy recent order, resume identity, daily/song/total listening values survive to 1 ms without fabricated facts.
2. First native playing, not track selection, creates recent playback.
3. Duplicate, stale, and lost-ack retries cannot double-count or duplicate semantic events.
4. Pause, buffering, seek, restore, party sync, buffer recovery, and playback-rate changes cannot inflate played/active time.
5. Session, event, resume, daily, track, and total changes commit atomically.
6. Midnight and statistics-clear boundaries retain the stable group UUID and cumulative checkpoint baseline.
7. Closed/interrupted retention moves eligible contributions to baselines before deletion.
8. Recent clear, statistics clear, delete-all activity, and device reset have distinct tested effects.
9. No active playback progress path rewrites `data.json`.
10. `legacy_data_v1.cross_artifact_complete` exists only after every new reader/writer smoke check succeeds.
11. The five consent/private cases have distinct persisted effects, and policy changes cannot alter an active group's latched flags.
12. New York 23-hour and 25-hour civil days rotate at the correct local midnight, and a killed renderer loses less than one 15-second interval without double-counting.
