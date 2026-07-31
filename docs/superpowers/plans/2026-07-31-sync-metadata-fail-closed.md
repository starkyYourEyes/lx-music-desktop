# Sync Metadata Fail-Closed Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve invalid or post-inventory-replaced versioned sync metadata, stop normal startup in credential recovery, and remove the non-portable hard-link predecessor protocol.

**Architecture:** Credential discovery performs a strict, read-only preflight of `servers.v1.json` and `devices.v2.json` before any migration write. A small typed recovery error carries only a fixed diagnostic and an allowlisted affected path through `runStorageMigrationHooks`; the existing descriptor-bound redaction path converts source replacement into that error. `AtomicJsonFile` remains strict and filesystem-neutral, with no invalid-predecessor override or hard-link recovery state machine.

**Tech Stack:** TypeScript, Node.js `fs`/`fs.promises`, Electron startup recovery, Electron `safeStorage`, `node:test`, and the existing Babel/TypeScript test loaders.

## Global Constraints

- Never access or migrate `C:\Users\hao238\AppData\Roaming\starky-lx-music-desktop`.
- Never run `D:\projects\lx-music-desktop\build\starky-lx-music-desktop-v3.0.0-x64-portable.exe` during this plan.
- Use only synthetic temporary profiles in tests and smoke checks.
- Never log or assert a real Cookie, password, sync key, complete request header, ciphertext, or real profile payload.
- Invalid current versioned metadata must remain byte-for-byte unchanged.
- A current versioned metadata path replaced after inventory must remain byte-for-byte unchanged.
- No migration write may occur before both current versioned metadata files pass preflight.
- A discovered credential must remain either verified in the vault or present in the untouched source.
- Do not automatically repair, restore, delete, or choose among invalid, changed, or experimental predecessor-guard files.
- Do not restore `allowInvalidPreviousFileSha256`, `expectedPreviousFileSha256`, or any equivalent validation bypass.
- Production correctness must not depend on `fs.link`, `fs.linkSync`, directory fsync, or hard-link support.
- Preserve the whole-document queues and replacement-manager refresh from `3338da13`.
- Preserve `credential_undecryptable` public status projection from `f9c0a2c4`.
- Keep legal legacy sync migration and mixed-source conflict handling unchanged.
- Maintain compatibility with NTFS, FAT32, and exFAT.
- Stage only files named by the active task and keep `.superpowers/sdd` evidence ignored.

## File Structure

- Create `src/main/migration/credentials/recoveryError.ts`: fixed recovery codes, typed error, allowlisted-path constructor, and type guard.
- Create `src/main/migration/credentials/syncMetadataPreflight.ts`: pure removal of allowed legacy `key` extensions and strict runtime-validator parity.
- Modify `src/main/migration/credentials/legacySources.ts`: run deterministic two-file preflight and tag versioned credential sources.
- Modify `src/main/migration/credentials/redactLegacySecrets.ts`: convert identity/value changes for tagged versioned sources into typed recovery and verify the redacted public document.
- Modify `src/main/app.ts`: project typed migration recovery to the existing storage recovery outcome.
- Modify `src/main/storage/atomicJsonFile.ts`: remove hard-link predecessor machinery and every invalid-destination exception.
- Modify `src/main/modules/sync/migrate.ts`: accept only strict current versioned destinations and stop passing predecessor hashes.
- Modify `build-config/storage/credential-migration.test.js`: strict preflight, zero-write, valid key-extension, and changed-source coverage.
- Modify `build-config/storage/credential-profile-scan.test.js`: exact diagnostic/path projection and startup-stop coverage.
- Modify `build-config/storage/startup-coordinator.test.js`: real recovery dialog projection for the fixed code and exact path.
- Modify `build-config/storage/sync-credential-cutover.test.js`: replace auto-repair expectations with strict fail-closed expectations while preserving legal migration and I7/I8 regressions.
- Modify `build-config/storage/atomic-json-file.test.js`: delete hard-link protocol tests and prove unknown guard-shaped files are untouched.
- Create `build-config/storage/portable-sync-metadata-smoke.js`: synthetic explicit-root smoke check using only portable filesystem operations.
- Create `build-config/storage/portable-sync-filesystem.test.js`: production protocol scan and smoke-script test on a temporary root.

---

### Task 1: Strict Versioned Sync Metadata Preflight

**Files:**
- Create: `src/main/migration/credentials/recoveryError.ts`
- Create: `src/main/migration/credentials/syncMetadataPreflight.ts`
- Modify: `src/main/migration/credentials/legacySources.ts`
- Modify: `build-config/storage/credential-migration.test.js`

**Interfaces:**
- Consumes: `isSyncClientServersFileV1`, `isSyncServerDevicesFileV2`, `SyncClientServersFileV1`, and `SyncServerDevicesFileV2` from `src/common/storage/syncMetadata.ts`.
- Produces: `CredentialMigrationRecoveryCode`, `CredentialMigrationRecoveryError`, `createSyncMetadataRecoveryError`, `isCredentialMigrationRecoveryError`, `VersionedSyncMetadataKind`, and `preflightVersionedSyncMetadata`.
- Produces: `LegacyCredentialSource.documentKind: 'generic' | 'sync-client-v1' | 'sync-server-v2'` for Task 2.

- [ ] **Step 1: Replace the auto-repair expectation with failing preflight tests**

Add table-driven cases to `build-config/storage/credential-migration.test.js`. Use both exact current paths and preserve the original text rather than reserializing it for the assertion:

```js
const invalidVersionedCases = [
  {
    name: 'client invalid json',
    relativePath: 'sync/client/servers.v1.json',
    rawBytes: '{"version":1,"servers":',
  },
  {
    name: 'client invalid version',
    relativePath: 'sync/client/servers.v1.json',
    document: { version: 2, servers: {} },
  },
  {
    name: 'client missing servers',
    relativePath: 'sync/client/servers.v1.json',
    document: { version: 1 },
  },
  {
    name: 'client empty id',
    relativePath: 'sync/client/servers.v1.json',
    document: {
      version: 1,
      servers: {
        server_bad: { clientId: '', serverName: 'Bad', key: 'CLIENT_INVALID_SENTINEL' },
      },
    },
  },
  {
    name: 'server invalid date',
    relativePath: 'sync/server/devices.v2.json',
    document: {
      version: 2,
      userName: 'default',
      clients: {
        device_bad: {
          clientId: 'device_bad',
          deviceName: 'Bad',
          isMobile: false,
          lastConnectDate: -1,
          key: 'SERVER_INVALID_SENTINEL',
        },
      },
    },
  },
  {
    name: 'client forbidden field',
    relativePath: 'sync/client/servers.v1.json',
    document: {
      version: 1,
      servers: {
        server_bad: { clientId: 'client_bad', serverName: 'Bad', key: 'CLIENT_FORBIDDEN_SENTINEL', forbidden: true },
      },
    },
  },
  {
    name: 'client unexpected top-level key',
    relativePath: 'sync/client/servers.v1.json',
    document: { version: 1, servers: {}, key: 'TOP_LEVEL_KEY_SENTINEL' },
  },
  ...[1.5, Number.MAX_SAFE_INTEGER + 1, null].map((lastConnectDate, index) => ({
    name: `server invalid date ${index}`,
    relativePath: 'sync/server/devices.v2.json',
    document: {
      version: 2,
      userName: 'default',
      clients: {
        [`device_bad_${index}`]: {
          clientId: `device_bad_${index}`,
          deviceName: 'Bad',
          isMobile: false,
          lastConnectDate,
          key: `SERVER_DATE_${index}_SENTINEL`,
        },
      },
    },
  })),
]

for (const testCase of invalidVersionedCases) {
  const target = path.join(root, testCase.relativePath)
  const originalBytes = testCase.rawBytes ?? `${JSON.stringify(testCase.document, null, 2)}\n`
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, originalBytes)
  let vaultWrites = 0
  let profileWrites = 0
  const vault = {
    mode: 'encrypted',
    async write() { vaultWrites++; return { persistence: 'encrypted' } },
    async verify() { return true },
    getMigrationMarker() { return null },
    async putMigrationMarker() { throw new Error('marker write must not run') },
  }

  await assert.rejects(
    migrateLegacyCredentials({
      dataRoot: root,
      vault,
      profiles: { async migrateLegacyAccountProfiles() { profileWrites++ } },
    }),
    error => error.code == 'credentials.sync_metadata_invalid' && error.affectedPath == target,
  )
  assert.equal(await fsp.readFile(target, 'utf8'), originalBytes, testCase.name)
  assert.equal(vaultWrites, 0, testCase.name)
  assert.equal(profileWrites, 0, testCase.name)
  assert.equal(fs.existsSync(path.join(root, 'credentials.v1.json')), false, testCase.name)
}
```

Add one separate two-file case using the client-empty-id and server-negative-date documents above. It must report `sync/client/servers.v1.json` first and perform zero writes.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test --test-name-pattern "fails closed before writes for invalid versioned sync metadata|reports client metadata first" build-config/storage/credential-migration.test.js
```

Expected: FAIL because current discovery accepts these documents and migration redacts or completes instead of throwing `credentials.sync_metadata_invalid`.

- [ ] **Step 3: Define the typed recovery boundary**

Create `src/main/migration/credentials/recoveryError.ts` with exact fixed fields and an allowlisted constructor:

```ts
import path from 'node:path'

export type CredentialMigrationRecoveryCode =
  | 'credentials.sync_metadata_invalid'
  | 'credentials.sync_metadata_changed_after_inventory'

export class CredentialMigrationRecoveryError extends Error {
  override readonly name = 'CredentialMigrationRecoveryError'

  constructor(
    readonly code: CredentialMigrationRecoveryCode,
    readonly affectedPath: string,
  ) {
    super(code)
  }
}

export const createSyncMetadataRecoveryError = (
  code: CredentialMigrationRecoveryCode,
  dataRoot: string,
  affectedPath: string,
): CredentialMigrationRecoveryError => {
  const root = path.resolve(dataRoot)
  const candidate = path.resolve(affectedPath)
  const allowed = [
    path.join(root, 'sync', 'client', 'servers.v1.json'),
    path.join(root, 'sync', 'server', 'devices.v2.json'),
  ]
  if (!allowed.includes(candidate)) throw new Error('Invalid sync metadata recovery path')
  return new CredentialMigrationRecoveryError(code, candidate)
}

export const isCredentialMigrationRecoveryError = (
  error: unknown,
): error is CredentialMigrationRecoveryError => error instanceof CredentialMigrationRecoveryError
```

Do not attach `cause`, parsed data, hashes, or source values to this error.

- [ ] **Step 4: Implement a pure key-extension projection and strict validation**

Create `src/main/migration/credentials/syncMetadataPreflight.ts`:

```ts
import {
  isSyncClientServersFileV1,
  isSyncServerDevicesFileV2,
  type SyncClientServersFileV1,
  type SyncServerDevicesFileV2,
} from '../../../common/storage/syncMetadata'

export type VersionedSyncMetadataKind = 'sync-client-v1' | 'sync-server-v2'
export type VersionedSyncMetadataDocument = SyncClientServersFileV1 | SyncServerDevicesFileV2

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value)

export const preflightVersionedSyncMetadata = (
  kind: VersionedSyncMetadataKind,
  value: unknown,
): VersionedSyncMetadataDocument | null => {
  const projected = structuredClone(value)
  if (!isRecord(projected)) return null
  const entries = kind == 'sync-client-v1' ? projected.servers : projected.clients
  if (isRecord(entries)) {
    for (const entry of Object.values(entries)) {
      if (isRecord(entry)) Reflect.deleteProperty(entry, 'key')
    }
  }
  return kind == 'sync-client-v1'
    ? isSyncClientServersFileV1(projected) ? projected : null
    : isSyncServerDevicesFileV2(projected) ? projected : null
}
```

Only nested entry `key` properties are removed. All other extra fields remain and therefore fail the strict runtime validators.

- [ ] **Step 5: Integrate deterministic preflight into credential discovery**

In `legacySources.ts`:

1. Add `documentKind` to `SourceDocument` and `LegacyCredentialSource`.
2. Default ordinary documents to `generic` in `readJsonDocument`.
3. Add `readVersionedSyncDocument(dataRoot, filePath, kind)` that wraps parse/path/read failures as `credentials.sync_metadata_invalid`, runs `preflightVersionedSyncMetadata`, and throws the same typed error when the projection is `null`.
4. Read current files in fixed order, client first and server second, before scanning legacy `syncAuthKey.json`, `devices.json`, users, and `sync.json`.
5. Inventory keys from the original current document, not the key-free projection.
6. Keep legacy formats on their existing permissive migration path.

Use this exact control shape so both current files pass before `collectLegacyCredentialInventory` returns:

```ts
const currentClientPath = path.join(dataRoot, 'sync', 'client', 'servers.v1.json')
const currentServerPath = path.join(dataRoot, 'sync', 'server', 'devices.v2.json')
const currentClient = await readVersionedSyncDocument(dataRoot, currentClientPath, 'sync-client-v1')
const currentServer = await readVersionedSyncDocument(dataRoot, currentServerPath, 'sync-server-v2')

if (currentClient != null) clientInventory(currentClient, credentials, 'servers')
if (currentServer != null) serverInventory(currentServer, credentials, currentServer.value.userName as string)
```

`clientInventory` already accepts a `containerKey`; pass the literal `servers` without changing its parsing rules. Do not scan the same current file a second time through legacy filenames.

- [ ] **Step 6: Add the valid legacy-key-extension GREEN case**

Add a test with otherwise strict current client and server documents containing only nested `key` extensions. Run `migrateLegacyCredentials`, assert both vault entries verify, assert the source documents are key-free, and open them through the production validators:

```js
const { isSyncClientServersFileV1, isSyncServerDevicesFileV2 } =
  require('../../src/common/storage/syncMetadata.ts')
assert.equal(isSyncClientServersFileV1(await readJson(clientPath)), true)
assert.equal(isSyncServerDevicesFileV2(await readJson(serverPath)), true)
assert.doesNotMatch(await fsp.readFile(clientPath, 'utf8'), /CLIENT_VALID_SENTINEL/)
assert.doesNotMatch(await fsp.readFile(serverPath, 'utf8'), /SERVER_VALID_SENTINEL/)
```

- [ ] **Step 7: Run Task 1 tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern "versioned sync metadata|legacy key extension|reports client metadata first" build-config/storage/credential-migration.test.js
node --test build-config/storage/credential-migration.test.js
```

Expected: all selected cases and the complete credential migration suite PASS.

- [ ] **Step 8: Commit Task 1**

```powershell
git add src/main/migration/credentials/recoveryError.ts src/main/migration/credentials/syncMetadataPreflight.ts src/main/migration/credentials/legacySources.ts build-config/storage/credential-migration.test.js
git commit -m "fix(storage): fail closed on invalid sync metadata"
```

---

### Task 2: Changed-After-Inventory Recovery Projection

**Files:**
- Modify: `src/main/migration/credentials/redactLegacySecrets.ts`
- Modify: `src/main/app.ts`
- Modify: `build-config/storage/credential-migration.test.js`
- Modify: `build-config/storage/credential-profile-scan.test.js`
- Modify: `build-config/storage/startup-coordinator.test.js`

**Interfaces:**
- Consumes: `LegacyCredentialSource.documentKind` and Task 1 recovery error exports.
- Produces: typed `credentials.sync_metadata_changed_after_inventory` failures from descriptor-bound redaction.
- Produces: `credentialMigrationRecovery(diagnostic, affectedPath?)` behavior in `src/main/app.ts`.

- [ ] **Step 1: Write the end-to-end changed-source failing test**

In `credential-migration.test.js`, create a valid key-bearing `servers.v1.json`. Use a fake vault whose first `verify` call renames the inventoried file aside and writes a replacement at the same path:

```js
const entries = new Map()
let swapped = false
const vault = {
  mode: 'encrypted',
  async write(ref, value) {
    entries.set(JSON.stringify(ref), structuredClone(value))
    return { persistence: 'encrypted' }
  },
  async verify(ref, value) {
    if (!swapped) {
      swapped = true
      await fsp.rename(target, displaced)
      await fsp.writeFile(target, replacementBytes)
    }
    return JSON.stringify(entries.get(JSON.stringify(ref))) == JSON.stringify(value)
  },
  getMigrationMarker() { return null },
  async putMigrationMarker() {},
}
```

Assert the migration rejects with code `credentials.sync_metadata_changed_after_inventory` and exact `target`, `target` still equals `replacementBytes`, the inventoried key is in the fake vault, and the replacement-only key is absent.

- [ ] **Step 2: Run the changed-source test and verify RED**

Run:

```powershell
node --test --test-name-pattern "projects a replaced versioned sync source into recovery" build-config/storage/credential-migration.test.js
```

Expected: FAIL because redaction currently throws a generic identity/source error without code or affected path.

- [ ] **Step 3: Convert only tagged versioned-source changes into typed recovery**

In `redactLegacySecrets.ts`, add a helper that maps failures before any handle write:

```ts
const changedVersionedSourceError = (
  source: LegacyCredentialSource,
): CredentialMigrationRecoveryError | null => source.documentKind == 'generic'
  ? null
  : createSyncMetadataRecoveryError(
      'credentials.sync_metadata_changed_after_inventory',
      source.trustedRoot,
      source.documentPath,
    )
```

In `preflight`, retain the existing descriptor and path identity checks. When identity or inventoried value comparison fails, close the handle and throw the typed error for `sync-client-v1`/`sync-server-v2`; generic account/WebDAV/legacy sources keep their existing generic errors. Before returning `PreparedRedaction`, parse `redacted` and require `preflightVersionedSyncMetadata(documentKind, parsed)` to be non-null for tagged sources.

Do not catch write, truncate, sync, or close errors as changed-after-inventory. Those remain ordinary migration failures.

- [ ] **Step 4: Write the startup recovery projection failing test**

In `credential-profile-scan.test.js`, import the real recovery error class and make the mocked `migrateLegacyCredentials` throw:

```js
const affectedPath = path.join(root, 'sync/client/servers.v1.json')
const { CredentialMigrationRecoveryError } = require(
  '../../src/main/migration/credentials/recoveryError.ts',
)
const runMigrationHooks = loadStorageMigrationHooks({
  initializeCredentialVault: async() => vault,
  migrateLegacyCredentials: async() => {
    throw new CredentialMigrationRecoveryError(
      'credentials.sync_metadata_changed_after_inventory',
      affectedPath,
    )
  },
  createAccountRepository: () => { throw new Error('must not hydrate') },
})
```

Assert the complete coordinator outcome contains `affectedPath` and only the fixed diagnostic, `showRecovery` runs once, and credentials check/settings/modules/app-inited do not run. Also assert a sentinel placed only in an unrelated thrown error message never appears in the outcome.

Add a real `showStorageRecovery` case in `startup-coordinator.test.js` with the same outcome. Capture the dialog options and `shell.openPath` call, return response `0`, then assert:

```js
assert.deepEqual(messages[0].buttons, ['Open data folder', 'Quit'])
assert.match(messages[0].detail, /credentials\.sync_metadata_changed_after_inventory/)
assert.equal(messages[0].detail.includes('REPLACEMENT_KEY_SENTINEL'), false)
assert.deepEqual(openedPaths, [path.dirname(affectedPath)])
assert.equal(quitCalls, 1)
```

- [ ] **Step 5: Run the startup projection test and verify RED**

Run:

```powershell
node --test --test-name-pattern "projects typed sync metadata migration recovery" build-config/storage/credential-profile-scan.test.js
```

Expected: FAIL because `runStorageMigrationHooks` currently collapses every migration exception to `credentials.legacy_migration_failed` and points at `credentials.v1.json`.

- [ ] **Step 6: Project typed recovery in `runStorageMigrationHooks`**

Change the helper in `src/main/app.ts` to accept an optional affected path:

```ts
const credentialMigrationRecovery = (
  diagnostic: string,
  affectedPath = path.join(global.lxDataPath, 'credentials.v1.json'),
): CredentialRecoveryOutcome => ({
  status: 'recovery',
  reason: 'credential_startup_check_failed',
  target: {
    kind: 'external-migration',
    component: 'credentials',
    affectedPath,
    diagnostics: [diagnostic],
  },
})
```

Use a typed catch around `migrateLegacyCredentials`:

```ts
  } catch (error) {
    if (isCredentialMigrationRecoveryError(error)) {
      return credentialMigrationRecovery(error.code, error.affectedPath)
    }
    return credentialMigrationRecovery('credentials.legacy_migration_failed')
  }
```

Keep the generic fallback unchanged and do not expose `error.message`.

- [ ] **Step 7: Run Task 2 tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern "projects a replaced versioned sync source into recovery" build-config/storage/credential-migration.test.js
node --test --test-name-pattern "projects typed sync metadata migration recovery|storage recovery dialog" build-config/storage/credential-profile-scan.test.js build-config/storage/startup-coordinator.test.js
node --test build-config/storage/credential-migration.test.js build-config/storage/credential-profile-scan.test.js build-config/storage/startup-coordinator.test.js
```

Expected: focused and complete suites PASS; the replacement bytes remain unchanged.

- [ ] **Step 8: Commit Task 2**

```powershell
git add src/main/migration/credentials/redactLegacySecrets.ts src/main/app.ts build-config/storage/credential-migration.test.js build-config/storage/credential-profile-scan.test.js build-config/storage/startup-coordinator.test.js
git commit -m "fix(storage): surface changed sync metadata recovery"
```

---

### Task 3: Remove the Hard-Link Protocol and Strictly Reject Direct Invalid Destinations

**Files:**
- Modify: `src/main/storage/atomicJsonFile.ts`
- Modify: `src/main/modules/sync/migrate.ts`
- Modify: `build-config/storage/atomic-json-file.test.js`
- Modify: `build-config/storage/sync-credential-cutover.test.js`

**Interfaces:**
- Consumes: strict validators and Task 1 `createSyncMetadataRecoveryError`.
- Produces: `AtomicFileSystem` without `link`, and `createAtomicJsonFile` without predecessor-validation options.
- Preserves: ordinary atomic stage/commit/replace/flush/cleanup interfaces.

- [ ] **Step 1: Rewrite the direct sync migration tests to require fail-closed behavior**

Delete the expectations that direct `migrateData` removes forbidden fields or drops invalid entries from existing current versioned metadata. Replace them with a table-driven test named `rejects and preserves invalid current versioned metadata` that:

1. Writes invalid client or server bytes with a synthetic key sentinel.
2. Calls `migrateData(root)`.
3. Requires `credentials.sync_metadata_invalid` and the exact affected path.
4. Requires byte-for-byte preservation.
5. Requires the sentinel credential to remain missing from the fake vault.

Retain a separate legal test where current metadata is strict and key-free while `sync.json` contributes a non-conflicting entry; require the merged document and source cleanup to remain unchanged.

- [ ] **Step 2: Add an atomic-writer unknown-guard preservation test**

Remove the four tests added for expected predecessor publication/restoration. Replace them with:

```js
it('does not interpret or remove unknown predecessor-shaped files', async() => {
  const { target } = await createFixture('unknown-predecessor')
  const unknown = `${target}.${['expected', 'previous'].join('-')}-fixture`
  await fsp.writeFile(target, '{"n":1}')
  await fsp.writeFile(unknown, 'preserve')
  const file = createAtomicJsonFile({ filePath: target, validate: isCounter })

  await file.cleanupOwnedTemps()

  assert.equal(await fsp.readFile(unknown, 'utf8'), 'preserve')
  assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { n: 1 })
})
```

Remove the `crypto`, `hashText`, and `guardPath` test helpers when they become unused.

- [ ] **Step 3: Run the rewritten tests and verify RED against `de2deb90`**

Run:

```powershell
node --test --test-name-pattern "rejects and preserves invalid current versioned metadata|unknown predecessor-shaped" build-config/storage/atomic-json-file.test.js build-config/storage/sync-credential-cutover.test.js
```

Expected: the invalid metadata case FAILS because direct migration normalizes it; the unknown-file case FAILS because current cleanup interprets predecessor guard names.

- [ ] **Step 4: Delete every hard-link and invalid-predecessor path from `AtomicJsonFile`**

In `src/main/storage/atomicJsonFile.ts`:

- Change `AtomicFileSystem` back to:

```ts
export type AtomicFileSystem = Pick<
  typeof fs,
  'mkdir' | 'open' | 'readFile' | 'readdir' | 'rename' | 'stat' | 'unlink'
>
```

- Remove `isAlreadyExists`, expected-guard maps/helpers/patterns, guard cleanup, guard restoration, and the special commit branch.
- Remove `expectedPreviousFileSha256` from options.
- Do not restore `allowInvalidPreviousFileSha256`.
- Keep the ordinary destination path strict:

```ts
if (destinationBytes != null) {
  const destination = parseAndValidate(destinationBytes, 'durable destination')
  if (options.shouldPreservePrevious?.(destination) ?? true) await preservePrevious(destinationBytes)
  else await removePrevious()
}
```

- Keep owned-temp cleanup limited to `ownedTempPattern` and active owned temps.

- [ ] **Step 5: Make direct sync migration validate before vaulting or normalizing current destinations**

In `src/main/modules/sync/migrate.ts`:

1. Remove `createHash`, `JsonDocumentRead.fileSha256`, and the predecessor-hash parameter from `replaceMetadata`.
2. Add `readCurrentMetadataDocument(dataPath, filePath)` around `readJsonDocument`; convert JSON parse/read failures other than `ENOENT` into `createSyncMetadataRecoveryError('credentials.sync_metadata_invalid', dataPath, filePath)`.
3. When `servers.v1.json` exists, require `isSyncClientServersFileV1(currentClientDocument)` before `vaultClientKeys` or `toProfiles`; otherwise throw `createSyncMetadataRecoveryError('credentials.sync_metadata_invalid', dataPath, currentClients)`.
4. When `devices.v2.json` exists, require `isSyncServerDevicesFileV2(currentDeviceDocument)` before `vaultServerKeys` or `toDevices`; otherwise throw the same code with `currentDevices`.
5. Apply the same checks in `migrateRootSource` before merging an existing current destination.
6. Pass only `(filePath, value)` to `replaceMetadata`.

Use this exact wrapper for every current versioned destination read:

```ts
const readCurrentMetadataDocument = async(
  dataPath: string,
  filePath: string,
): Promise<JsonDocumentRead | null> => {
  try {
    return await readJsonDocument(filePath)
  } catch {
    throw createSyncMetadataRecoveryError(
      'credentials.sync_metadata_invalid', dataPath, filePath,
    )
  }
}
```

Use strict document values directly after validation:

```ts
if (currentClientSource != null) {
  if (!isSyncClientServersFileV1(currentClientDocument)) {
    throw createSyncMetadataRecoveryError(
      'credentials.sync_metadata_invalid', dataPath, currentClients,
    )
  }
  currentProfiles = currentClientDocument.servers
}
```

Do not vault a key from an invalid current versioned destination in this direct-call path. Normal startup already handles valid nested key extensions through Tasks 1 and 2.

- [ ] **Step 6: Run Task 3 focused and complete suites**

Run:

```powershell
node --test --test-name-pattern "rejects and preserves invalid current versioned metadata|unknown predecessor-shaped|serializes replacement manager|undecryptable sync" build-config/storage/atomic-json-file.test.js build-config/storage/sync-credential-cutover.test.js
node --test build-config/storage/atomic-json-file.test.js build-config/storage/sync-credential-cutover.test.js
```

Expected: all focused tests PASS; complete atomic and sync suites PASS, including I7 and I8 regressions.

- [ ] **Step 7: Run protocol-removal scans**

Run:

```powershell
rg -n "expectedPreviousFileSha256|allowInvalidPreviousFileSha256|expected-previous|\.link\(|linkSync\(" src
```

Expected: zero matches and `rg` exit code 1. Search `build-config/storage` separately; only the dynamically assembled unknown-file test label may describe the concept, with no production protocol identifier or hard-link call.

- [ ] **Step 8: Commit Task 3**

```powershell
git add src/main/storage/atomicJsonFile.ts src/main/modules/sync/migrate.ts build-config/storage/atomic-json-file.test.js build-config/storage/sync-credential-cutover.test.js
git commit -m "fix(storage): remove sync predecessor guard protocol"
```

---

### Task 4: Portable Filesystem Smoke Contract

**Files:**
- Create: `build-config/storage/portable-sync-metadata-smoke.js`
- Create: `build-config/storage/portable-sync-filesystem.test.js`

**Interfaces:**
- Consumes: `migrateLegacyCredentials`, runtime sync metadata validators, and an explicit existing directory argument.
- Produces: process exit 0 plus one secret-free JSON summary on success; cleans only its own direct `lx-portable-sync-smoke-*` child.

- [ ] **Step 1: Write the smoke-script contract test and verify RED**

Create `portable-sync-filesystem.test.js` with two tests:

```js
it('contains no production hard-link predecessor protocol', async() => {
  const sources = [
    'src/main/storage/atomicJsonFile.ts',
    'src/main/modules/sync/migrate.ts',
  ]
  for (const relative of sources) {
    const source = await fsp.readFile(path.join(repoRoot, relative), 'utf8')
    assert.doesNotMatch(source, /(?:fs|fileSystem)\.link|linkSync|expectedPreviousFileSha256|allowInvalidPreviousFileSha256|expected-previous/)
  }
})

it('runs the synthetic sync migration under an explicit temporary volume root', async() => {
  const volumeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-portable-volume-'))
  try {
    const result = spawnSync(process.execPath, [smokePath, volumeRoot], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { status: 'pass', fixtureRemoved: true })
    assert.deepEqual(await fsp.readdir(volumeRoot), [])
  } finally {
    await fsp.rm(volumeRoot, { recursive: true, force: true })
  }
})
```

Run:

```powershell
node --test build-config/storage/portable-sync-filesystem.test.js
```

Expected: FAIL because `portable-sync-metadata-smoke.js` does not exist.

- [ ] **Step 2: Implement the explicit-root synthetic smoke script**

Create `portable-sync-metadata-smoke.js` using the same TypeScript extension loader and `@main`/`@common` resolver already used by `credential-migration.test.js`. Require exactly one directory argument, resolve it, require it to be an existing real directory, and create only a direct unique child:

```js
const requestedRoot = process.argv[2]
if (requestedRoot == null) throw new Error('Explicit smoke root is required')
const volumeRoot = path.resolve(requestedRoot)
const rootStats = await fsp.lstat(volumeRoot)
if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('Smoke root must be a real directory')
const fixture = await fsp.mkdtemp(path.join(volumeRoot, 'lx-portable-sync-smoke-'))
if (path.dirname(fixture) != volumeRoot) throw new Error('Smoke fixture escaped explicit root')
```

Inside `fixture`, write otherwise valid client/server versioned documents with nested synthetic keys. Use an in-memory fake vault implementing `mode`, `write`, `verify`, `getMigrationMarker`, and `putMigrationMarker`. Run `migrateLegacyCredentials`, then assert:

```js
assert.equal(isSyncClientServersFileV1(clientDocument), true)
assert.equal(isSyncServerDevicesFileV2(serverDocument), true)
assert.equal(JSON.stringify({ clientDocument, serverDocument }).includes('SMOKE_KEY_SENTINEL'), false)
assert.equal(entries.size, 2)
```

In `finally`, validate `path.dirname(fixture) == volumeRoot`, remove only `fixture`, restore module hooks, then print exactly:

```js
process.stdout.write(`${JSON.stringify({ status: 'pass', fixtureRemoved: true })}\n`)
```

Never recursively delete `volumeRoot`, a drive root, the workspace, or a user profile.

- [ ] **Step 3: Run the portable contract tests and storage suite**

Run:

```powershell
node --test build-config/storage/portable-sync-filesystem.test.js
npm run test:storage
```

Expected: portable contract tests PASS and the complete pure storage suite reports zero failures.

- [ ] **Step 4: Run the smoke script on explicitly provisioned filesystem roots**

First list candidate volumes without modifying them:

```powershell
Get-Volume | Select-Object DriveLetter, FileSystem, HealthStatus
```

For each explicitly provisioned test directory, run the script only after verifying the directory is not the workspace and not a user profile:

```powershell
node build-config/storage/portable-sync-metadata-smoke.js 'X:\lx-portable-smoke-root'
```

Required release matrix: one NTFS directory, one FAT32 directory, and one exFAT directory when those filesystem types are available. Each run must output `{"status":"pass","fixtureRemoved":true}` and leave the supplied directory empty. If a filesystem type is unavailable, record it as an environmental gap; do not format or repartition a drive.

- [ ] **Step 5: Commit Task 4**

```powershell
git add build-config/storage/portable-sync-metadata-smoke.js build-config/storage/portable-sync-filesystem.test.js
git commit -m "test(storage): verify portable sync metadata migration"
```

---

### Task 5: Full Verification and Review Gate

**Files:**
- Verify only; modify no source unless a command exposes a defect.

**Interfaces:**
- Consumes: all Task 1-4 commits.
- Produces: fresh final-source evidence for review and later packaging.

- [ ] **Step 1: Run focused credential and sync recovery suites**

```powershell
node --test build-config/storage/credential-migration.test.js build-config/storage/credential-profile-scan.test.js build-config/storage/startup-coordinator.test.js build-config/storage/atomic-json-file.test.js build-config/storage/sync-credential-cutover.test.js build-config/storage/portable-sync-filesystem.test.js
```

Expected: zero failures.

- [ ] **Step 2: Run full storage and Electron storage suites**

```powershell
npm run test:storage
npm run test:storage:electron
```

Expected: both commands exit 0 with zero failures.

- [ ] **Step 3: Run lint and both production builds**

```powershell
npm run lint
npm run build:main
npm run build:renderer
```

Expected: all commands exit 0. Do not treat output from a failed or timed-out parallel wrapper as proof; rerun an affected command individually.

- [ ] **Step 4: Run security and protocol scans**

```powershell
rg -n "expectedPreviousFileSha256|allowInvalidPreviousFileSha256|expected-previous|(?:fs|fileSystem)\.link|linkSync" src
rg -n "ClientKeyInfo|ServerKeyInfo" src/renderer
rg -n "cookie|password|ciphertext" src/main/modules/sync src/renderer -g "*.ts" -g "*.vue"
rg -n "C:\\Users\\hao238\\AppData\\Roaming\\starky-lx-music-desktop|starky-lx-music-desktop-v3\.0\.0-x64-portable\.exe" src build-config/storage
git diff --check c9659562..HEAD
git status --short
```

Expected:

- no hard-link predecessor protocol matches in production;
- no renderer sync key-info type matches;
- credential-field matches are limited to allowlisted internal credential handling and synthetic tests after manual inspection;
- no forbidden real path or old portable executable references in tracked implementation/test files;
- `git diff --check` exits 0;
- tracked worktree is clean.

- [ ] **Step 5: Run the final review workflow**

Invoke `superpowers:requesting-code-review` over `c9659562..HEAD`. The review must explicitly re-check:

- byte-for-byte preservation for invalid and replaced files;
- zero writes before complete two-file preflight;
- no credential loss across vault/source states;
- exact diagnostic and affected path without raw errors;
- I7 replacement-manager and cross-destination serialization;
- I8 undecryptable public projections;
- no hard-link or invalid-destination bypass;
- NTFS/FAT32/exFAT portability contract.

Address any Critical or Important finding with a fresh RED/GREEN cycle and rerun Steps 1-4. Do not package or run a portable executable until this review is clean and the user separately authorizes the packaging/run step.
