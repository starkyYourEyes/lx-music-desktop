# My List Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the My Lists sidebar into persistent `My` and `Imported / Collected` groups with counts, collapse state, stable-ID actions, group-local sorting, cross-group movement, and backward-compatible backup behavior.

**Architecture:** Store each user playlist's editable `group` in the existing playlist profile JSON, while a small renderer store exposes resolved groups and persists missing legacy values. Pure common helpers own validation, source-based fallback, partitioning, and target-order calculation. The sidebar renders two Sortable roots and stores collapse state in renderer `localStorage`; current playlist sync continues to carry only core list fields.

**Tech Stack:** Electron, Vue 3 SFCs, TypeScript/JavaScript, Less CSS modules, SortableJS, SQLite-backed playlist metadata, Node's built-in test runner, Vue SSR test rendering, ESLint, webpack.

## Global Constraints

- Fixed group order: `mine` (`My`) first, `external` (`Imported / Collected`) second.
- The built-in favorites list belongs to `mine`, appears first, counts toward `My`, and cannot move.
- `LX.List.UserListProfile.group` accepts only `'mine' | 'external'`.
- A missing group resolves to `external` when `source` or `sourceListId` exists; otherwise it resolves to `mine`.
- Manual grouping changes organization only. They do not change playlist contents, source binding, source update, or source-detail behavior.
- New local lists default to `mine`; online collections and new single-list imports default to `external`.
- Full/list backup restore applies a saved group; same-ID single-list import preserves the target's current group.
- Keep `group` out of current sync snapshots and incremental actions. Do not change the sync protocol in this version.
- Persist collapse state only on the current device. Do not include it in settings, playlist backups, or sync.
- Do not add playlist copying, custom groups, nested groups, group header actions, or dependencies.
- Preserve all user changes already present in the working tree. Start execution with `superpowers:using-git-worktrees` before editing production code.

---

## File Structure

- Create `src/common/listGroup.ts`: pure group validation, fallback, partitioning, and order calculation.
- Modify `src/common/types/list.d.ts`: declare `UserListGroup` and the optional profile field.
- Modify `src/common/types/config_files.d.ts`: declare additive backup records carrying optional `group`.
- Modify `src/common/storage/stateValidation.ts`: validate profile groups.
- Create `src/renderer/store/list/group.ts`: reactive group cache, profile initialization, persistence, and best-effort legacy backfill.
- Modify `src/renderer/store/list/action.ts`: assign a group after list creation and return the new ID.
- Modify `src/renderer/core/useApp/useDataInit.ts`: initialize playlist groups before the list UI renders.
- Create `src/renderer/views/List/MyList/groupState.ts`: parse and persist collapse state in renderer `localStorage`.
- Create `src/renderer/views/List/MyList/useGroups.ts`: grouped computed lists, counts, collapse, reveal, and scroll targeting.
- Create `src/renderer/views/List/MyList/groupActions.ts`: atomic group/order movement with rollback.
- Modify `src/renderer/views/List/MyList/index.vue`: render both groups and use stable playlist IDs.
- Modify `src/renderer/views/List/MyList/useEditList.ts`: rename by playlist ID; list creation relies on the renderer action's reveal request.
- Modify `src/renderer/views/List/MyList/useMenu.js`: target playlists by object/ID and add the move command.
- Modify `src/renderer/views/List/MyList/useShare.ts`: stable-ID imports plus single-list group rules.
- Modify `src/renderer/views/List/MyList/useDarg.ts`: two Sortable roots, cross-group drops, and collapsed-heading behavior.
- Modify `src/renderer/utils/compositions/useDrag.js`: expose Sortable group/add/update/move events required by My Lists.
- Modify `src/renderer/views/Setting/components/SettingBackup.vue`: serialize and restore groups with list/full-data backups.
- Modify `src/lang/zh-cn.json`, `src/lang/zh-tw.json`, and `src/lang/en-us.json`: add group and move labels.
- Create `build-config/my-list-groups.test.js`: pure rules, storage contract, group store, and sync-boundary tests.
- Create `build-config/my-list-group-flows.test.js`: creation, backup, import, stable-ID, and rollback tests.
- Create `build-config/my-list-sidebar-groups.test.js`: rendered grouping, collapse, menu, and drag-adapter tests.
- Modify `build-config/storage-electron/non-activity-repository.test.js`: verify group-bearing metadata round trips and is retained/removed with playlist IDs.

---

### Task 1: Group Domain Contract And Pure Ordering Rules

**Files:**
- Create: `build-config/my-list-groups.test.js`
- Create: `src/common/listGroup.ts`
- Modify: `src/common/types/list.d.ts`
- Modify: `src/common/storage/stateValidation.ts`
- Modify: `build-config/storage/non-activity-contracts.test.js`
- Modify: `build-config/storage-electron/non-activity-repository.test.js`

**Interfaces:**
- Produces: `LX.List.UserListGroup = 'mine' | 'external'`
- Produces: `isUserListGroup(value: unknown): value is LX.List.UserListGroup`
- Produces: `resolveUserListGroup(list: Pick<LX.List.UserListInfo, 'source' | 'sourceListId'>, storedGroup: unknown): LX.List.UserListGroup`
- Produces: `partitionUserLists<T>(lists: readonly T[], getGroup: (list: T) => LX.List.UserListGroup): { mine: T[], external: T[] }`
- Produces: `buildMovedUserListOrder(lists: readonly LX.List.UserListInfo[], groups: Readonly<Record<string, LX.List.UserListGroup | undefined>>, id: string, toGroup: LX.List.UserListGroup, toIndex: number): string[]`

- [ ] **Step 1: Write failing group rule tests**

Create `build-config/my-list-groups.test.js` with the repository's `load-ts-module` helper and these literal cases:

```js
const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const modulePath = path.resolve(__dirname, '../src/common/listGroup.ts')
const loadGroups = () => loadTsModule(modulePath)
const list = (id, source, sourceListId) => ({ id, name: id, source, sourceListId, locationUpdateTime: null })

test('explicit groups win and missing groups derive from source metadata', () => {
  const { resolveUserListGroup } = loadGroups()
  assert.equal(resolveUserListGroup(list('local'), 'external'), 'external')
  assert.equal(resolveUserListGroup(list('online', 'wy', '42'), undefined), 'external')
  assert.equal(resolveUserListGroup(list('partial', undefined, '42'), undefined), 'external')
  assert.equal(resolveUserListGroup(list('local'), undefined), 'mine')
  assert.equal(resolveUserListGroup(list('local'), 'unknown'), 'mine')
})

test('partitioning keeps source position order inside each group', () => {
  const { partitionUserLists } = loadGroups()
  const lists = [list('mine-a'), list('ext-a'), list('mine-b'), list('ext-b')]
  const groups = { 'mine-a': 'mine', 'ext-a': 'external', 'mine-b': 'mine', 'ext-b': 'external' }
  const result = partitionUserLists(lists, item => groups[item.id])
  assert.deepEqual(result.mine.map(item => item.id), ['mine-a', 'mine-b'])
  assert.deepEqual(result.external.map(item => item.id), ['ext-a', 'ext-b'])
})

test('moving across groups returns one normalized exact order', () => {
  const { buildMovedUserListOrder } = loadGroups()
  const lists = [list('mine-a'), list('ext-a'), list('mine-b'), list('ext-b')]
  const groups = { 'mine-a': 'mine', 'ext-a': 'external', 'mine-b': 'mine', 'ext-b': 'external' }
  assert.deepEqual(
    buildMovedUserListOrder(lists, groups, 'ext-a', 'mine', 1),
    ['mine-a', 'ext-a', 'mine-b', 'ext-b'],
  )
  assert.deepEqual(
    buildMovedUserListOrder(lists, groups, 'mine-b', 'external', 1),
    ['mine-a', 'ext-a', 'mine-b', 'ext-b'],
  )
})

test('target indexes are clamped and an unknown ID is a no-op', () => {
  const { buildMovedUserListOrder } = loadGroups()
  const lists = [list('mine-a'), list('ext-a')]
  const groups = { 'mine-a': 'mine', 'ext-a': 'external' }
  assert.deepEqual(buildMovedUserListOrder(lists, groups, 'ext-a', 'mine', -9), ['ext-a', 'mine-a'])
  assert.deepEqual(buildMovedUserListOrder(lists, groups, 'mine-a', 'external', 99), ['ext-a', 'mine-a'])
  assert.deepEqual(buildMovedUserListOrder(lists, groups, 'missing', 'mine', 0), ['mine-a', 'ext-a'])
})
```

Extend `non-activity-contracts.test.js` so `profile: { group: 'mine' }` and `profile: { group: 'external' }` pass, while `group: 'other'`, `group: null`, and a profile with an unknown key fail.

Extend `storage-electron/non-activity-repository.test.js` with a profile `{ description: 'kept', group: 'external' }`. Assert that the exact profile survives a repository reload and `retain`, then assert it disappears when that playlist ID is omitted from the next `retain` command. This is the authoritative persistence/deletion test requested by the design.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test build-config/my-list-groups.test.js build-config/storage/non-activity-contracts.test.js
$env:ELECTRON_RUN_AS_NODE='1'
try {
  node_modules\.bin\electron.cmd --test build-config/storage-electron/non-activity-repository.test.js
} finally {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}
```

Expected: FAIL because `listGroup.ts` and the group type do not exist, and both the contract and repository reject `group` as an extra profile key.

- [ ] **Step 3: Add the type and pure implementation**

Add to `LX.List`:

```ts
type UserListGroup = 'mine' | 'external'

interface UserListProfile {
  description?: string
  coverUrl?: string
  createdAt?: number
  group?: UserListGroup
}
```

Implement `listGroup.ts` without renderer imports. Use the destination group for the moved ID while resolving all other IDs from the supplied map with source-based fallback:

```ts
export const isUserListGroup = (value: unknown): value is LX.List.UserListGroup => {
  return value == 'mine' || value == 'external'
}

export const resolveUserListGroup = (
  list: Pick<LX.List.UserListInfo, 'source' | 'sourceListId'>,
  storedGroup: unknown,
): LX.List.UserListGroup => {
  if (isUserListGroup(storedGroup)) return storedGroup
  return list.source != null || list.sourceListId != null ? 'external' : 'mine'
}

export const partitionUserLists = <T>(
  lists: readonly T[],
  getGroup: (list: T) => LX.List.UserListGroup,
): { mine: T[], external: T[] } => {
  const result: { mine: T[], external: T[] } = { mine: [], external: [] }
  for (const list of lists) result[getGroup(list)].push(list)
  return result
}

export const buildMovedUserListOrder = (
  lists: readonly LX.List.UserListInfo[],
  groups: Readonly<Record<string, LX.List.UserListGroup | undefined>>,
  id: string,
  toGroup: LX.List.UserListGroup,
  toIndex: number,
): string[] => {
  const moved = lists.find(list => list.id == id)
  if (!moved) return lists.map(list => list.id)
  const remaining = lists.filter(list => list.id != id)
  const partitioned = partitionUserLists(remaining, list => resolveUserListGroup(list, groups[list.id]))
  const target = partitioned[toGroup]
  const index = Number.isFinite(toIndex) ? Math.max(0, Math.min(Math.trunc(toIndex), target.length)) : target.length
  target.splice(index, 0, moved)
  return [...partitioned.mine, ...partitioned.external].map(list => list.id)
}
```

- [ ] **Step 4: Extend strict profile validation**

Change the allowed profile keys to `['description', 'coverUrl', 'createdAt', 'group']` and add:

```ts
if (Object.hasOwn(value, 'group') && value.group != 'mine' && value.group != 'external') {
  invalidField('group')
}
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run the commands from Step 2.

Expected: all group resolver, ordering, and storage contract tests PASS.

- [ ] **Step 6: Commit the domain contract**

```powershell
git add -- build-config/my-list-groups.test.js build-config/storage/non-activity-contracts.test.js build-config/storage-electron/non-activity-repository.test.js src/common/listGroup.ts src/common/types/list.d.ts src/common/storage/stateValidation.ts
git commit -m "feat: define my list groups"
```

---

### Task 2: Playlist Profile Group Store And Creation Defaults

**Files:**
- Modify: `build-config/my-list-groups.test.js`
- Create: `src/renderer/store/list/group.ts`
- Modify: `src/renderer/store/list/action.ts`
- Modify: `src/renderer/core/useApp/useDataInit.ts`

**Interfaces:**
- Produces: reactive `userListGroups: Record<string, LX.List.UserListGroup>`
- Produces: `initializeUserListGroups(lists: readonly LX.List.UserListInfo[]): Promise<void>`
- Produces: `ensureUserListGroups(lists: readonly LX.List.UserListInfo[]): Promise<void>`
- Produces: `getUserListGroup(list: LX.List.UserListInfo): LX.List.UserListGroup`
- Produces: `setUserListGroup(id: string, group: LX.List.UserListGroup): Promise<void>`
- Produces: `cacheUserListGroup(id: string, group: LX.List.UserListGroup): void`
- Produces: `userListRevealRequest: Ref<{ id: string, token: number } | null>` and `requestUserListReveal(id: string): void`
- Changes: `createUserList(options): Promise<string>` with optional `group`; the low-level `ListActionAdd.listInfos` remains group-free

- [ ] **Step 1: Add failing group-controller tests**

Load `group.ts` with mocks for Vue reactivity and `@renderer/utils/data`. Cover these outcomes:

```js
const groupStorePath = path.resolve(__dirname, '../src/renderer/store/list/group.ts')
const commonGroups = loadTsModule(path.resolve(__dirname, '../src/common/listGroup.ts'))
const loadGroupStore = ({ metadata = {}, setProfile = async() => {}, errors = [] } = {}) => loadTsModule(groupStorePath, {
  '@common/utils/vueTools': { reactive: value => value, ref: value => ({ value }) },
  '@common/listGroup': commonGroups,
  '@common/utils': { log: { error: error => errors.push(error) } },
  '@renderer/utils/data': {
    getListUpdateInfo: async() => metadata,
    setUserListProfile: setProfile,
  },
})

test('initialization honors stored groups and backfills only missing groups', async() => {
  const writes = []
  const module = loadGroupStore({
    metadata: { stored: { updateTime: 0, isAutoUpdate: false, profile: { group: 'external' } } },
    setProfile: async(id, profile) => writes.push({ id, profile }),
  })
  await module.initializeUserListGroups([list('stored'), list('online', 'wy', '42'), list('local')])
  assert.deepEqual(module.userListGroups, { stored: 'external', online: 'external', local: 'mine' })
  assert.deepEqual(writes, [
    { id: 'online', profile: { group: 'external' } },
    { id: 'local', profile: { group: 'mine' } },
  ])
})

test('a failed legacy backfill keeps the derived in-memory group', async() => {
  const module = loadGroupStore({ metadata: {}, setProfile: async() => { throw new Error('disk') } })
  await module.initializeUserListGroups([list('online', 'wy', '42')])
  assert.equal(module.getUserListGroup(list('online', 'wy', '42')), 'external')
})
```

Add a creation harness that asserts local creation calls the profile writer with `mine`, source-backed creation calls it with `external`, an explicit single-import group wins, a profile-write failure does not delete/reject the created playlist, and the function returns the created ID.

Assert that successful creation publishes the returned ID through `userListRevealRequest`, repeated requests for the same ID increment the token, and the payload sent to low-level `createUserListAction()` does not contain `group`. Low-level remote sync creation bypasses this renderer action, so the test must also prove that `ensureUserListGroups()` derives and persists a newly observed remote list without publishing a reveal request. Cover an existing synced ID with a stored manual group and assert `ensureUserListGroups()` preserves it, plus a removed ID and assert its cache entry is deleted.

- [ ] **Step 2: Run the store tests and verify RED**

Run: `node --test build-config/my-list-groups.test.js`

Expected: FAIL because the renderer group store and creation option are absent.

- [ ] **Step 3: Implement the renderer group store**

Implement the store with one cache hydration path shared by initialization and later sync-driven list changes:

```ts
export const userListGroups = reactive<Record<string, LX.List.UserListGroup>>({})
export const userListRevealRequest = ref<{ id: string, token: number } | null>(null)
let revealToken = 0

const hydrateGroups = async(lists: readonly LX.List.UserListInfo[]) => {
  const metadata = await getListUpdateInfo()
  const liveIds = new Set(lists.map(list => list.id))
  for (const id of Object.keys(userListGroups)) {
    if (!liveIds.has(id)) delete userListGroups[id]
  }

  const backfills: Array<Promise<void>> = []
  for (const list of lists) {
    const storedGroup = metadata[list.id]?.profile?.group
    const group = resolveUserListGroup(list, storedGroup)
    userListGroups[list.id] = group
    if (!isUserListGroup(storedGroup)) {
      backfills.push(setUserListProfile(list.id, { group }).catch(error => {
        log.error(error)
      }))
    }
  }
  await Promise.all(backfills)
}

export const initializeUserListGroups = hydrateGroups
export const ensureUserListGroups = hydrateGroups
export const getUserListGroup = (list: LX.List.UserListInfo) => {
  return userListGroups[list.id] ?? resolveUserListGroup(list, undefined)
}
export const cacheUserListGroup = (id: string, group: LX.List.UserListGroup) => {
  userListGroups[id] = group
}
export const setUserListGroup = async(id: string, group: LX.List.UserListGroup) => {
  await setUserListProfile(id, { group })
  userListGroups[id] = group
}
export const requestUserListReveal = (id: string) => {
  userListRevealRequest.value = { id, token: ++revealToken }
}
```

`hydrateGroups()` populates the reactive cache before awaiting best-effort writes. Each backfill catches and logs its own failure, so initialization resolves and the UI uses the derived session value even when persistence fails. `setUserListGroup()` writes the profile first and updates the reactive cache only after success. `cacheUserListGroup()` supports derived display when a non-critical creation write fails.

`requestUserListReveal(id)` replaces the ref value with `{ id, token }`, where `token` increments on every request so repeated imports or moves of the same ID still notify the sidebar. This renderer-session request carries no route change and no durable state.

- [ ] **Step 4: Assign groups during list creation**

Extend the renderer action signature:

```ts
export const createUserList = async({
  name,
  id = `userlist_${Date.now()}`,
  list = [],
  source,
  sourceListId,
  position = -1,
  group,
}: {
  name?: string
  id?: string
  list?: LX.Music.MusicInfo[]
  source?: LX.OnlineSource
  sourceListId?: string
  position?: number
  group?: LX.List.UserListGroup
}): Promise<string> => {
  const listInfo: LX.List.UserListInfo = {
    id,
    name: name ?? 'list',
    source,
    sourceListId,
    locationUpdateTime: position < 0 ? null : Date.now(),
  }
  await createUserListAction({
    position: position < 0 ? userLists.length : position,
    listInfos: [listInfo],
  })
  const assignedGroup = resolveUserListGroup(listInfo, group)
  cacheUserListGroup(id, assignedGroup)
  await setUserListGroup(id, assignedGroup).catch(error => {
    log.error(error)
  })
  if (list.length) await addListMusics(id, list)
  requestUserListReveal(id)
  return id
}
```

After the database creates the playlist, call `resolveUserListGroup(listInfo, group)` so even an invalid runtime option falls back safely. Cache it, attempt `setUserListGroup()`, log a persistence failure without removing the list, then await any song writes, publish one reveal request, and return `id`. Do not publish before song writes complete.

- [ ] **Step 5: Initialize before list UI startup completes**

In `useDataInit.ts`, keep the existing `getUserLists()` ordering and add:

```ts
window.lxData.userLists = await getUserLists()
await initializeUserListGroups(window.lxData.userLists)
```

Do not make WebDAV refresh, dislike initialization, or playback restore depend on a successful backfill write.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
node --test build-config/my-list-groups.test.js build-config/storage/non-activity-contracts.test.js
```

Expected: all tests PASS, including the non-fatal backfill and creation-write failure cases.

- [ ] **Step 7: Commit group persistence and creation defaults**

```powershell
git add -- build-config/my-list-groups.test.js src/renderer/store/list/group.ts src/renderer/store/list/action.ts src/renderer/core/useApp/useDataInit.ts
git commit -m "feat: persist playlist group assignments"
```

---

### Task 3: Backup, Restore, Import, And Sync Boundary

**Files:**
- Create: `build-config/my-list-group-flows.test.js`
- Modify: `src/common/types/config_files.d.ts`
- Modify: `src/renderer/views/Setting/components/SettingBackup.vue`
- Modify: `src/renderer/views/List/MyList/useShare.ts`
- Verify without production changes: `src/main/modules/sync/listEvent.ts`

**Interfaces:**
- Produces: `LX.ConfigFile.UserListInfoBackup` with optional `group`
- Consumes: `getUserListGroup()`, `setUserListGroup()`, and `resolveUserListGroup()`
- Changes: `handleImportList(listInfo: LX.List.MyListInfo): Promise<void>`
- Guarantees: current sync serialization omits `group`

- [ ] **Step 1: Write failing backup/import flow tests**

Create `my-list-group-flows.test.js` using `load-ts-module`, `load-vue-sfc`, and exact dependency mocks. Assert:

```js
test('playlist backup records carry the resolved group', async() => {
  const backup = await exportAllListsHarness({ local: 'mine', collected: 'external' })
  assert.equal(backup.find(item => item.id == 'local').group, 'mine')
  assert.equal(backup.find(item => item.id == 'collected').group, 'external')
})

test('restore applies saved groups and derives groups for old records', async() => {
  const writes = await restoreHarness([
    { id: 'saved', name: 'Saved', list: [], group: 'mine', source: 'wy', sourceListId: '1' },
    { id: 'legacy-online', name: 'Online', list: [], source: 'wy', sourceListId: '2' },
    { id: 'legacy-local', name: 'Local', list: [] },
    { id: 'invalid-online', name: 'Invalid', list: [], group: 'other', source: 'wy' },
  ])
  assert.deepEqual(writes, [
    ['saved', 'mine'],
    ['legacy-online', 'external'],
    ['legacy-local', 'mine'],
    ['invalid-online', 'external'],
  ])
})

test('single-list import assigns external only for a new target', async() => {
  assert.equal((await importSingleHarness({ targetExists: false })).created.group, 'external')
  const overwrite = await importSingleHarness({ targetExists: true, currentGroup: 'mine' })
  assert.equal(overwrite.created, null)
  assert.equal(overwrite.groupWrites.length, 0)
  assert.equal(overwrite.currentGroup, 'mine')
})
```

Implement the harnesses against production entry points:

- `exportAllListsHarness()` loads `SettingBackup.vue`, mocks `useBackupExport()` with a function that invokes and captures `createData()`, calls the returned `handleExportPlayList()`, and returns `captured.data`.
- `restoreHarness()` loads the same SFC, mocks `readLxConfigFile()` with the supplied `playList_v2` or `allData_v2` payload, records `setUserListGroup(id, group)`, confirms the dialog, awaits `handleImportPlayList()` or `handleImportAllData()`, and returns only after the group writes complete. Run the saved/legacy cases through both file types.
- `importSingleHarness()` loads `useShare.ts`, supplies either an existing or missing target through the list-state mock, captures `createUserList()` and `setUserListGroup()` calls, confirms overwrite prompts, and awaits `handleImportList(targetList)`.

Define `read(relativePath)` once at the top of the flow test for later source contracts:

```js
const fs = require('node:fs')
const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')
```

Load `buildUserListInfoFull()` from `src/main/modules/sync/listEvent.ts`, pass an input containing `group: 'external'`, and assert `Object.hasOwn(result, 'group') == false`. In the Task 2 creation harness, retain the complementary assertion that incremental `list_create` payloads contain only core `UserListInfo` fields; movement tests in Task 6 must assert that grouping emits metadata plus existing `list_update_position` actions, never a new sync action.

- [ ] **Step 2: Run the flow tests and verify RED**

Run: `node --test build-config/my-list-group-flows.test.js`

Expected: FAIL because backup objects do not carry groups and new single-list imports do not force `external`.

- [ ] **Step 3: Add config-file backup types**

Declare config-only records so the core list/sync types remain unchanged:

```ts
interface UserListInfoBackup extends LX.List.UserListInfoFull {
  group?: LX.List.UserListGroup
}

type ListInfoBackup =
  | LX.List.MyDefaultListInfoFull
  | LX.List.MyLoveListInfoFull
  | UserListInfoBackup
```

Use `ListInfoBackup` in `MyListInfoPart`. Do not add `group` to `UserListInfo` or `ListDataFull`.

- [ ] **Step 4: Serialize and restore groups in Settings**

In `getAllLists()`, add `group: getUserListGroup(list)` only to user-list records. During `importOldListData()` and `importNewListData()`, build a `Map<string, UserListInfoBackup>` for incoming user-list records while merging list contents. After `await overwriteListFull(...)`, apply all imported assignments before returning:

```js
await Promise.all(Array.from(importedUserLists.values(), list => {
  return setUserListGroup(list.id, resolveUserListGroup(list, list.group))
}))
```

Do not put built-in `default` or `love` records in the map. Existing local lists absent from the imported backup retain their groups.

Apply the same helper path to playlist backup and full-data backup. Refactor `handleImportPlayList()` and `handleImportAllData()` into async functions that await selection, confirmation, and the selected import function so callers/tests can observe completion. Keep the v2 type strings unchanged.

- [ ] **Step 5: Apply single-list import rules and await writes**

Add a focused export assertion that a user-list `playListPart_v2` record carries its resolved `group`, while favorites does not. Change `handleImportList(listInfo, index)` to an async `handleImportList(listInfo)` that awaits file selection, parsing, confirmation, metadata/list updates, and music writes. A new imported list appends to the end of the global order, which is the end of `external` after grouped normalization. Ignore any serialized `group` on single-list import because this path follows acquisition semantics.

For a new target, call:

```ts
await createUserList({
  name: listData.name,
  id: listData.id,
  source: listData.source,
  sourceListId: listData.sourceListId,
  group: 'external',
  list: normalizedMusic,
})
```

Pass the music array into `createUserList()` instead of writing it separately: the renderer action publishes the reveal request only after the music write completes. For a confirmed same-ID overwrite, await both `updateUserList()` (for ordinary user lists) and `overwriteListMusics()`, do not call `setUserListGroup()`, then call `requestUserListReveal(targetList.id)`. New imports receive exactly one request from `createUserList()`.

- [ ] **Step 6: Run flow and storage tests and verify GREEN**

Run:

```powershell
node --test build-config/my-list-group-flows.test.js build-config/my-list-groups.test.js build-config/storage/non-activity-contracts.test.js
```

Expected: all tests PASS; the sync projection test proves that group remains outside the current protocol.

- [ ] **Step 7: Commit backup and import behavior**

```powershell
git add -- build-config/my-list-group-flows.test.js src/common/types/config_files.d.ts src/renderer/views/Setting/components/SettingBackup.vue src/renderer/views/List/MyList/useShare.ts
git commit -m "feat: preserve playlist groups in backups"
```

---

### Task 4: Stable Playlist Identity In Sidebar Actions

**Files:**
- Modify: `build-config/my-list-group-flows.test.js`
- Modify: `src/renderer/views/List/MyList/index.vue`
- Modify: `src/renderer/views/List/MyList/useEditList.ts`
- Modify: `src/renderer/views/List/MyList/useMenu.js`
- Modify: `src/renderer/views/List/MyList/useShare.ts`

**Interfaces:**
- Changes: sidebar target contract from visible indexes to `listInfo` or `listId`
- Produces: `data-list-id` on every user-list row
- Produces: `handleRename(listId: string)` and `handleImportList(listInfo: LX.List.MyListInfo): Promise<void>`

- [ ] **Step 1: Add failing stable-ID behavior tests**

Extend `my-list-group-flows.test.js` with a fake DOM whose rendered order differs from `userLists`. Assert that rename updates the playlist named by `data-list-id`, menu source actions use the passed playlist object, and import never derives a create position from a visible row index.

Add a source contract that rejects the old patterns:

```js
assert.doesNotMatch(read('src/renderer/views/List/MyList/useEditList.ts'), /userLists\[parseInt/)
assert.doesNotMatch(read('src/renderer/views/List/MyList/useMenu.js'), /userLists\[index\]/)
assert.doesNotMatch(read('src/renderer/views/List/MyList/index.vue'), /data-index=/)
assert.match(read('src/renderer/views/List/MyList/index.vue'), /data-list-id=/)
```

- [ ] **Step 2: Run the stable-ID tests and verify RED**

Run: `node --test build-config/my-list-group-flows.test.js`

Expected: FAIL because current rename, menu, import, and highlight state depend on numeric indexes.

- [ ] **Step 3: Refactor editing to IDs**

Render `:data-list-id="item.id"`. Replace `rightClickItemIndex` with `rightClickItemId`. Make `handleRename(id)` find `.user-list` elements by `element.dataset.listId == id`. Make `handleSaveListName()` look up `userLists.find(item => item.id == id)` before writing.

Keep `handleCreateList()` awaiting `createUserList({ name })`; do not send a second reveal request from `useEditList`, because the renderer action from Task 2 owns creation completion and reveal timing.

- [ ] **Step 4: Refactor menu and sharing targets**

Change `showMenu(event, listInfo)` and `menuClick(action, listInfo)`. Derive system-list behavior from stable IDs (`default`, `love`, `webdav`). Use `listInfo.source/sourceListId` for source capabilities. Keep every existing menu action and disabled state unchanged.

Remove the import index parameter. Omit `position` when creating a non-conflicting imported ID so the action appends it to `external`. Stable target identity still controls same-ID overwrite prompts and export actions.

- [ ] **Step 5: Run flow tests and verify GREEN**

Run: `node --test build-config/my-list-group-flows.test.js`

Expected: all stable-ID behavior and source-contract assertions PASS.

- [ ] **Step 6: Commit the identity refactor**

```powershell
git add -- build-config/my-list-group-flows.test.js src/renderer/views/List/MyList/index.vue src/renderer/views/List/MyList/useEditList.ts src/renderer/views/List/MyList/useMenu.js src/renderer/views/List/MyList/useShare.ts
git commit -m "refactor: target playlists by stable id"
```

---

### Task 5: Grouped Sidebar Rendering And Collapse State

**Files:**
- Create: `build-config/my-list-sidebar-groups.test.js`
- Create: `src/renderer/views/List/MyList/groupState.ts`
- Create: `src/renderer/views/List/MyList/useGroups.ts`
- Create: `src/renderer/views/List/MyList/groupActions.ts`
- Modify: `src/renderer/views/List/MyList/index.vue`
- Modify: `src/renderer/views/List/MyList/useDarg.ts`
- Modify: `src/renderer/views/List/MyList/useListScroll.ts`
- Modify: `src/renderer/utils/compositions/useDrag.js`
- Modify: `src/lang/zh-cn.json`
- Modify: `src/lang/zh-tw.json`
- Modify: `src/lang/en-us.json`

**Interfaces:**
- Produces: `loadMyListGroupCollapsed(storage)` and `saveMyListGroupCollapsed(storage, state)`
- Produces: `useGroups({ userLists, activeListId, scrollToList }): { groups, collapsed, toggle, expand, reveal }`, where `activeListId: () => string` and `scrollToList: (id: string) => void`
- Produces: `persistExactUserListOrder(ids: readonly string[]): Promise<void>` and `reorderUserListWithinGroup({ id, group, toIndex }): Promise<void>`
- Produces: refs `dom_mine_list` and `dom_external_list`

- [ ] **Step 1: Write failing collapse and rendered-output tests**

Create `my-list-sidebar-groups.test.js`. Unit-test the storage parser with missing, malformed, partial, and valid JSON:

```js
assert.deepEqual(loadWith(null), { mine: false, external: false })
assert.deepEqual(loadWith('{"mine":true,"external":false}'), { mine: true, external: false })
assert.deepEqual(loadWith('{"mine":"yes"}'), { mine: false, external: false })
```

Render the real `MyList/index.vue` through `load-vue-sfc` with one local and one external user list. Assert:

- headings render in fixed order with translated keys;
- counts are `2` for `My` (favorites plus local) and `1` for external;
- favorites is the first `mine` row;
- an empty external fixture still renders its heading and `0` without an empty row;
- group buttons expose `aria-expanded`;
- toggling hides only that group's playlist rows; and
- a changed active list ID expands its group and calls the scroll target with the stable ID;
- `love` expands `mine`, while `default`, `webdav`, deleted IDs, and an empty reveal request do nothing; and
- two reveal requests for the same user-list ID but different tokens each scroll once without changing the active route.

Add a same-group reorder test that starts with interleaved global positions and asserts the exact normalized result. Mock Sortable and assert each group root receives `.user-list` as its draggable selector and that `onUpdate` forwards `data-list-id` plus `newDraggableIndex` instead of child indexes. Reject the reorder promise once and assert the dragged element returns to its `oldDraggableIndex`, so the direct Sortable DOM mutation cannot survive a failed write.

- [ ] **Step 2: Run the sidebar tests and verify RED**

Run: `node --test build-config/my-list-sidebar-groups.test.js`

Expected: FAIL because the sidebar has one flat list and no collapse-state helper.

- [ ] **Step 3: Implement device-local collapse state**

Use the localStorage key `my-list-group-collapsed-v1`. Accept only a plain object with both boolean keys. Return `{ mine: false, external: false }` for missing, malformed, partial, array, or wrong-type values. Serialize only those two keys. Catch storage access/quota errors and keep the in-memory state.

- [ ] **Step 4: Implement the grouped composable**

Use `partitionUserLists(userLists, getUserListGroup)`. Expose group descriptors with stable keys, list arrays, and counts. `mine.count` adds one for favorites. `toggle()` saves collapse state. `reveal(id)` maps `love` to `mine`, resolves ordinary user lists by stable ID, ignores IDs that are not rendered in this sidebar, expands the target group, waits for `nextTick()`, then calls `scrollToList(id)`.

Watch the active route list ID. Initial mount and later external navigation reveal the active group. A user can collapse the current group because toggling does not change the route ID and therefore does not retrigger the watcher.

Watch `userListRevealRequest` with `immediate: true`, ignoring `null`. Each new token expands the target group and scrolls to its stable ID without changing the route or detail pane. This covers local creation, online collection, single-list import, and later movement even when the request originated on another page.

Watch the user-list ID/source signature and call `ensureUserListGroups(userLists)` so current-sync additions receive a derived persisted group.

- [ ] **Step 5: Render two fixed group roots**

Change the scroll container from a single flat user-list loop to two fixed roots with `data-group="mine"` and `data-group="external"`. Each Sortable root contains a focusable `.my-list-group-heading` button row followed by its playlist rows, which makes a collapsed heading a real drop target in Task 6. The `mine` root keeps `.default-list` favorites first and the new-list input after its ordinary rows. Clicking New List calls `expand('mine')` before showing/focusing the input.

Update `useListScroll` to expose `scrollToList(id)` and find `[data-list-id]` instead of the first active element. Keep current cover, fetching, active, edit, and input styles. Add stable header dimensions, ellipsis, count alignment, disclosure rotation, and no card nesting.

- [ ] **Step 6: Preserve group-local drag sorting**

Implement `persistExactUserListOrder(ids)` by moving one ID at a time through the existing `updateUserListPosition()` action:

```ts
for (let position = 0; position < ids.length; position++) {
  const current = userLists.findIndex(item => item.id == ids[position])
  if (current != position) await updateUserListPosition({ ids: [ids[position]], position })
}
```

`reorderUserListWithinGroup()` snapshots the old ID order, calculates the normalized target order with `buildMovedUserListOrder()`, and restores the snapshot if persistence fails:

```ts
export const reorderUserListWithinGroup = async({ id, group, toIndex }: {
  id: string
  group: LX.List.UserListGroup
  toIndex: number
}) => {
  const oldOrder = userLists.map(list => list.id)
  const nextOrder = buildMovedUserListOrder(userLists, userListGroups, id, group, toIndex)
  try {
    await persistExactUserListOrder(nextOrder)
  } catch (error) {
    await persistExactUserListOrder(oldOrder).catch(log.error)
    throw error
  }
}
```

Extend `useDrag.js` to accept a literal `draggable` selector and pass the full Sortable update event to its callback. Pass filter selectors through unchanged instead of prepending `.`. Create one disabled-by-default Sortable instance for each group root with `draggable: '.user-list'` and `filter: '.my-list-group-heading, .default-list'`. Do not set a shared Sortable `group` yet, so Task 5 preserves existing sorting without allowing incomplete cross-group moves. `useDarg.ts` reads `event.item.dataset.listId`, the root's `data-group`, and `event.newDraggableIndex`, then awaits/catches `reorderUserListWithinGroup()` through the existing no-success-dialog interaction. On rejection, remove `event.item` from its Sortable-mutated location and insert it before the `.user-list` currently at `event.oldDraggableIndex` (or before the new-list input/end of its original root). Keep modifier-key enable/disable behavior and `clearDownKeys()` unchanged.

- [ ] **Step 7: Add locale keys**

Add the same keys to all three locale files:

```json
"lists__group_mine": "我的",
"lists__group_external": "导入/收藏",
"lists__move_to_group": "移动到「{name}」",
"lists__move_group_failed": "移动列表失败，请重试。"
```

Use `我的`, `匯入/收藏`, `移動到「{name}」`, `移動清單失敗，請重試。` for Traditional Chinese. Use `My`, `Imported / Collected`, `Move to "{name}"`, `Unable to move the list. Try again.` for English.

- [ ] **Step 8: Run sidebar and flow tests and verify GREEN**

Run:

```powershell
node --test build-config/my-list-sidebar-groups.test.js build-config/my-list-group-flows.test.js build-config/my-list-groups.test.js
```

Expected: all rendered grouping, count, collapse, reveal, stable-ID, and group-local reorder tests PASS.

- [ ] **Step 9: Commit grouped rendering**

```powershell
git add -- build-config/my-list-sidebar-groups.test.js src/renderer/views/List/MyList/groupState.ts src/renderer/views/List/MyList/useGroups.ts src/renderer/views/List/MyList/groupActions.ts src/renderer/views/List/MyList/index.vue src/renderer/views/List/MyList/useDarg.ts src/renderer/views/List/MyList/useListScroll.ts src/renderer/utils/compositions/useDrag.js src/lang/zh-cn.json src/lang/zh-tw.json src/lang/en-us.json
git commit -m "feat: group the my lists sidebar"
```

---

### Task 6: Context-Menu Movement And Cross-Group Drag

**Files:**
- Modify: `build-config/my-list-group-flows.test.js`
- Modify: `build-config/my-list-sidebar-groups.test.js`
- Modify: `src/renderer/views/List/MyList/groupActions.ts`
- Modify: `src/renderer/views/List/MyList/index.vue`
- Modify: `src/renderer/views/List/MyList/useMenu.js`
- Modify: `src/renderer/views/List/MyList/useDarg.ts`
- Modify: `src/renderer/utils/compositions/useDrag.js`

**Interfaces:**
- Produces: `moveUserList({ id, toGroup, toIndex }): Promise<void>`
- Produces: `createMoveUserList(dependencies): (request) => Promise<void>` for transaction testing
- Changes: generic drag helper adds `group`, `onAdd(event)`, and `onMove(event)` to Task 5's full update-event contract
- Consumes: Task 5 group-root refs and `expand(group)`

- [ ] **Step 1: Write failing move transaction tests**

Export an injected `createMoveUserList()` from `groupActions.ts` so tests can use fake durable operations. Cover success, same-group reorder, first-write failure, order-write failure, successful rollback, and failed rollback reload:

```js
const groupActionsPath = path.resolve(__dirname, '../src/renderer/views/List/MyList/groupActions.ts')
const createMoveHarness = overrides => {
  const { createMoveUserList } = loadTsModule(groupActionsPath, {
    '@common/listGroup': loadTsModule(path.resolve(__dirname, '../src/common/listGroup.ts')),
  })
  return createMoveUserList({
    readLists: () => [list('mine'), list('external')],
    getGroup: item => item.id == 'mine' ? 'mine' : 'external',
    setGroup: async() => {},
    setOrder: async() => {},
    reload: async() => {},
    ...overrides,
  })
}

test('order failure restores the previous group and exact order', async() => {
  const calls = []
  const move = createMoveHarness({
    setGroup: async(id, group) => calls.push(['group', id, group]),
    setOrder: async ids => {
      calls.push(['order', ids])
      if (calls.filter(call => call[0] == 'order').length == 1) throw new Error('position')
    },
  })
  await assert.rejects(() => move({ id: 'external', toGroup: 'mine', toIndex: 0 }), /position/)
  assert.deepEqual(calls.at(-2), ['group', 'external', 'external'])
  assert.deepEqual(calls.at(-1), ['order', ['mine', 'external']])
})
```

Add menu tests that normal lists show one enabled `move_group` item naming the other group, while favorites, default, and WebDAV lists show none. Assert that a source-bound playlist still exposes source sync/detail items after a move.

- [ ] **Step 2: Write failing drag-adapter tests**

Mock Sortable creation and assert both roots receive the same group name, `.user-list` as `draggable`, heading/favorites filters, and full event callbacks. Feed synthetic update/add events and assert stable IDs, destination group keys, and draggable indexes become `moveUserList()` requests. Assert unmount destroys both Sortable instances and clears a pending heading timer.

Assert a collapsed-heading drop uses the target group's current length, while a 400 ms hover expands the heading and permits an explicit index.

- [ ] **Step 3: Run movement tests and verify RED**

Run:

```powershell
node --test build-config/my-list-group-flows.test.js build-config/my-list-sidebar-groups.test.js
```

Expected: FAIL because no move transaction, menu command, or cross-list Sortable configuration exists.

- [ ] **Step 4: Implement exact-order persistence and rollback**

`createMoveUserList()` snapshots the old group and `userLists.map(item => item.id)`, computes the target order with `buildMovedUserListOrder()`, writes the new profile group when it changes, then persists the exact order. Inject these exact dependencies so the unit test can control each durable operation:

```ts
interface MoveUserListDependencies {
  readLists: () => LX.List.UserListInfo[]
  getGroup: (list: LX.List.UserListInfo) => LX.List.UserListGroup
  setGroup: (id: string, group: LX.List.UserListGroup) => Promise<void>
  setOrder: (ids: readonly string[]) => Promise<void>
  reload: () => Promise<void>
}
```

Track `groupWritten` and `orderStarted`. If the initial group write rejects, do not issue an order write or compensating writes. Once `setOrder()` starts it may have partially applied several position actions, so any rejection from it requires exact-order rollback; group rollback is required only when `groupWritten` is true. The production order adapter uses existing single-ID `updateUserListPosition()` calls from first to last so old sync clients receive supported actions:

```ts
for (let position = 0; position < ids.length; position++) {
  const current = userLists.findIndex(item => item.id == ids[position])
  if (current != position) await updateUserListPosition({ ids: [ids[position]], position })
}
```

On failure after a write may have changed state, attempt the required group and exact-order rollbacks with `Promise.allSettled()` so one failed rollback does not prevent the other. Reload durable state when either required rollback rejects, in this order:

```ts
const reloadedLists = await getUserLists()
await initializeUserListGroups([...reloadedLists])
```

Then reject so the caller can show `lists__move_group_failed`.

Task 6 replaces Task 5's direct same-group implementation with this transaction for both `onUpdate` and `onAdd`; keep `reorderUserListWithinGroup()` only as a thin compatibility wrapper around `moveUserList()` if an existing focused test still imports it. A manual group move writes only playlist metadata and existing position actions. It must not add `group` to any list object or introduce a sync action.

- [ ] **Step 5: Add the context-menu command**

For a normal playlist, compute its other group and append:

```js
{
  name: t('lists__move_to_group', { name: t(targetGroupKey) }),
  action: 'move_group',
  group: targetGroup,
  disabled: false,
}
```

Invoke `moveUserList()` with the destination group's current length. Call `requestUserListReveal(id)` only after both durable writes succeed. Do not add the item for favorites, default, or WebDAV lists.

Both the context-menu caller and drag caller publish reveal only from the resolved promise and catch rejection with the same dialog:

```js
void moveUserList(request)
  .then(() => requestUserListReveal(request.id))
  .catch(() => {
    void dialog(t('lists__move_group_failed'))
  })
```

- [ ] **Step 6: Extend the Sortable wrapper and My Lists drag composable**

Pass through `group`, `draggable`, `filter`, `onAdd`, `onUpdate`, and `onMove`, returning the consumer's `onMove` result to Sortable. Preserve disabled-by-default activation and `clearDownKeys()`. Destroy Sortable on unmount. Create one Sortable instance per group root with shared group name `my-list-groups`.

Use `event.item.dataset.listId`, `event.to.dataset.group`, and `event.newDraggableIndex`; do not use child indexes. Track heading hover with a 400 ms timer when `event.related` matches `.my-list-group-heading`. Clear the timer on move-away, drop, unchoose, and unmount. Snapshot whether the destination was collapsed before Sortable mutates the DOM. When it remained collapsed at drop time, use the destination group's current ordinary-playlist length as `toIndex`; otherwise use the draggable index. After a successful update/add, publish a reveal request. On failure, use the Task 5 DOM-restoration helper with `event.from` and `event.oldDraggableIndex` before showing the shared failure dialog; the test must cover both same-root and cross-root restoration.

- [ ] **Step 7: Run all group tests and verify GREEN**

Run:

```powershell
node --test build-config/my-list-groups.test.js build-config/my-list-group-flows.test.js build-config/my-list-sidebar-groups.test.js build-config/storage/non-activity-contracts.test.js
```

Expected: all movement, rollback, menu, drag, grouping, backup, and storage tests PASS.

- [ ] **Step 8: Commit movement interactions**

```powershell
git add -- build-config/my-list-group-flows.test.js build-config/my-list-sidebar-groups.test.js src/renderer/views/List/MyList/groupActions.ts src/renderer/views/List/MyList/index.vue src/renderer/views/List/MyList/useMenu.js src/renderer/views/List/MyList/useDarg.ts src/renderer/utils/compositions/useDrag.js
git commit -m "feat: move playlists between groups"
```

---

### Task 7: Regression, Build, And Visual Verification

**Files:**
- Modify only if verification finds a covered defect: files listed in Tasks 1-6.

**Interfaces:**
- Consumes: all completed feature tasks.
- Produces: verified storage, renderer, backup, compatibility, and interaction behavior.

- [ ] **Step 1: Run all focused group tests**

Run:

```powershell
node --test build-config/my-list-groups.test.js build-config/my-list-group-flows.test.js build-config/my-list-sidebar-groups.test.js build-config/storage/non-activity-contracts.test.js
```

Expected: all tests PASS without warnings or unhandled rejections.

- [ ] **Step 2: Run authoritative metadata repository tests**

Run:

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
try {
  node_modules\.bin\electron.cmd --test build-config/storage-electron/non-activity-repository.test.js
} finally {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}
```

Expected: repository round-trip, retain, remove, and profile JSON tests PASS with group-bearing profiles.

- [ ] **Step 3: Run existing renderer regression tests that load list components**

Run:

```powershell
node --test build-config/song-row-artwork.test.js build-config/song-row-components.test.js
```

Expected: all existing list artwork and row behavior tests PASS after My Lists sidebar changes.

- [ ] **Step 4: Lint every touched source file**

Run:

```powershell
npx eslint -f node_modules/eslint-formatter-friendly src/common/listGroup.ts src/common/types/list.d.ts src/common/types/config_files.d.ts src/common/storage/stateValidation.ts src/renderer/store/list/group.ts src/renderer/store/list/action.ts src/renderer/core/useApp/useDataInit.ts src/renderer/views/List/MyList/groupState.ts src/renderer/views/List/MyList/useGroups.ts src/renderer/views/List/MyList/groupActions.ts src/renderer/views/List/MyList/index.vue src/renderer/views/List/MyList/useEditList.ts src/renderer/views/List/MyList/useMenu.js src/renderer/views/List/MyList/useShare.ts src/renderer/views/List/MyList/useDarg.ts src/renderer/views/List/MyList/useListScroll.ts src/renderer/utils/compositions/useDrag.js src/renderer/views/Setting/components/SettingBackup.vue
```

Expected: exit code `0`.

- [ ] **Step 5: Build the production renderer**

Run: `npm run build:renderer`

Expected: webpack exits `0` without Vue, TypeScript, or Less errors.

- [ ] **Step 6: Start the development application**

Run: `npm run dev`

Expected: Electron opens without a renderer startup error. Keep the process active during visual checks and stop it cleanly afterward.

- [ ] **Step 7: Verify grouped sidebar states**

Inspect standard and narrow windows at `70%`, `90%`, and `130%` My Lists sidebar scale. Verify:

- fixed group order, disclosure icons, counts, and favorites placement;
- external count `0` with no placeholder row;
- persisted collapse state after restart;
- active-list reveal from another route;
- long English and both Chinese labels without overlap;
- New List entering `My`; and
- online collection and single-list import entering `Imported / Collected`.

- [ ] **Step 8: Verify movement and failure-sensitive interactions**

Verify modifier-enabled sorting inside each group, cross-group drops at the start/middle/end, hover expansion, direct drops on collapsed headings, right-click movement, retained source-update/detail actions, and correct rename/import/menu targets after groups are collapsed or reordered.

Export and restore playlist/full-data backups, then confirm saved groups return. Import a same-ID single-list file and confirm its current group stays unchanged. Connect current sync if available and confirm incoming lists derive a local group while no compatibility error appears on an older client.

- [ ] **Step 9: Review scope and working-tree isolation**

Run:

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; only planned files and feature tests changed in the implementation worktree. Confirm no database migration, sync protocol type, playlist-copy command, or unrelated playback file changed.

- [ ] **Step 10: Commit verification fixes only when needed**

If verification required changes, rerun the affected RED/GREEN test and Steps 1-5, then commit only the affected planned files:

```powershell
git add -- build-config/my-list-groups.test.js build-config/my-list-group-flows.test.js build-config/my-list-sidebar-groups.test.js build-config/storage/non-activity-contracts.test.js build-config/storage-electron/non-activity-repository.test.js src/common/listGroup.ts src/common/types/list.d.ts src/common/types/config_files.d.ts src/common/storage/stateValidation.ts src/renderer/store/list/group.ts src/renderer/store/list/action.ts src/renderer/core/useApp/useDataInit.ts src/renderer/views/List/MyList/groupState.ts src/renderer/views/List/MyList/useGroups.ts src/renderer/views/List/MyList/groupActions.ts src/renderer/views/List/MyList/index.vue src/renderer/views/List/MyList/useEditList.ts src/renderer/views/List/MyList/useMenu.js src/renderer/views/List/MyList/useShare.ts src/renderer/views/List/MyList/useDarg.ts src/renderer/views/List/MyList/useListScroll.ts src/renderer/utils/compositions/useDrag.js src/renderer/views/Setting/components/SettingBackup.vue src/lang/zh-cn.json src/lang/zh-tw.json src/lang/en-us.json
git commit -m "fix: refine my list grouping"
```

If verification found no defect, do not create an empty commit.
