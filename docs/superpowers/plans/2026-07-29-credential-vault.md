# Credential Vault and Secret Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move QQ Music, NetEase, WebDAV, and sync credentials out of plaintext stores into independently encrypted Electron `safeStorage` entries while keeping public account metadata usable.

**Architecture:** The main process owns a versioned `credentials.v1.json` envelope backed by the foundation atomic writer. Each logical credential is encrypted and verified independently; public provider/sync metadata remains in typed non-secret repositories. A startup migration reads allowlisted legacy locations, writes destination-specific markers, switches every reader and writer, then removes plaintext fields only after read-back succeeds.

**Tech Stack:** Electron `safeStorage`, TypeScript, `better-sqlite3`, Comlink, Node.js crypto, atomic JSON persistence, and `node:test`.

## Global Constraints

- This plan requires the completed storage-foundation plan and authoritative schema version `3`.
- Never write a plaintext fallback. If encryption is unavailable, or Linux reports `basic_text`, retain credentials in process memory only and report that secure persistence is unavailable.
- Encrypt every credential entry separately; do not encrypt one monolithic profile blob.
- `credentials.v1.json` contains only version metadata, base64 ciphertext, timestamps, and migration markers.
- Secret values never cross account-status, sync-status, device-list, or general settings IPC responses.
- Do not log secrets, ciphertext, complete account objects, request headers, or credential-source JSON.
- Keep undecryptable ciphertext for explicit diagnosis; log out only the affected provider/device.
- Use the existing successful `app.requestSingleInstanceLock()` as the migration lock; do not add a stale lock file.
- Do not promise secure physical erasure from SSD storage. Remove active references and all future plaintext writes.
- Portable cross-machine credential export is outside this project.
- Each source/destination uses its own canonical SHA-256 and marker; no transaction spans vault JSON and SQLite.
- Preserve every unrelated user change listed in the roadmap and any later concurrent edit; stage only the files named by the current task.

## File Structure

- Create `src/main/storage/credentials/types.ts`: credential refs, payloads, read/write states, and disk envelope.
- Create `src/main/storage/credentials/safeStorageCipher.ts`: injectable safeStorage capability and encryption wrapper.
- Create `src/main/storage/credentials/credentialVault.ts`: per-entry read/write/remove/verify and memory-only fallback.
- Create `src/main/storage/credentials/index.ts`: singleton lifecycle and capability status.
- Create migration `src/main/worker/dbService/migrations/0004_account_profiles.ts`.
- Create `src/main/worker/dbService/modules/account_profile/`: authoritative public account-profile repository.
- Create `src/main/storage/accounts/accountRepository.ts`: combines profile and credential operations.
- Create `src/main/migration/credentials/legacySources.ts`: allowlisted source parsers.
- Create `src/main/migration/credentials/credentialMigration.ts`: idempotent Phase 1 coordinator.
- Create `src/main/migration/credentials/redactLegacySecrets.ts`: verified plaintext removal.
- Modify QQ Music and NetEase account modules to use `AccountRepository`.
- Modify WebDAV settings, IPC, and UI to split ordinary URL settings from credentials.
- Modify sync client/server persistence and renderer-facing types to remove keys.
- Add pure vault/migration tests and Electron safeStorage integration tests.

---

### Task 1: Define Credential References and the safeStorage Cipher

**Files:**
- Create: `src/main/storage/credentials/types.ts`
- Create: `src/main/storage/credentials/safeStorageCipher.ts`
- Create: `build-config/storage/credential-cipher.test.js`

**Interfaces:**
- Consumes: Electron `safeStorage` through dependency injection.
- Produces: stable credential entry IDs, payload types, and `CredentialCipher`.
- Used by: vault and migration tasks.

- [ ] **Step 1: Write capability and isolation tests**

```js
it('uses encrypted persistence only when the backend is secure', () => {
  assert.equal(createCredentialCipher(fakeSafeStorage({ available: true, backend: 'kwallet' })).mode, 'encrypted')
  assert.equal(createCredentialCipher(fakeSafeStorage({ available: false })).mode, 'memory-only')
  assert.equal(createCredentialCipher(fakeSafeStorage({ available: true, backend: 'basic_text', platform: 'linux' })).mode, 'memory-only')
})

it('derives stable non-secret entry ids', () => {
  assert.equal(toCredentialEntryId({ kind: 'netease-cookie' }), 'netease-cookie')
  assert.equal(
    toCredentialEntryId({ kind: 'sync-server-device', userName: 'alice', clientId: 'desktop-1' }),
    'sync-server-device:alice:desktop-1',
  )
  assert.throws(() => toCredentialEntryId({ kind: 'sync-server-device', userName: '../x', clientId: 'a' }))
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/credential-cipher.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the exact types**

```ts
export type CredentialRef =
  | { kind: 'netease-cookie' }
  | { kind: 'qq-music-cookie' }
  | { kind: 'webdav-basic' }
  | { kind: 'sync-client'; serverId: string }
  | { kind: 'sync-server-device'; userName: string; clientId: string }
  | { kind: 'legacy-quarantine'; sourceSha256: string }

export interface WebDAVCredentialPayloadV1 {
  version: 1
  username: string
  password: string
}

export interface SyncKeyPayloadV1 {
  version: 1
  key: string
}

export interface CredentialCipher {
  readonly mode: 'encrypted' | 'memory-only'
  encrypt(plaintext: string): Buffer
  decrypt(ciphertext: Buffer): string
}
```

Validate every identifier segment against `/^[A-Za-z0-9._@-]{1,256}$/`. Validate Cookies and sync keys as non-empty strings no longer than 64 KiB; WebDAV username/password are each at most 4 KiB. `safeStorageCipher.ts` calls `isEncryptionAvailable()` before either crypto operation and, on Linux, rejects `getSelectedStorageBackend() === 'basic_text'`.

- [ ] **Step 4: Verify GREEN**

```powershell
node --test build-config/storage/credential-cipher.test.js
```

Expected: PASS without Electron being loaded by the pure test.

- [ ] **Step 5: Commit**

```powershell
git add src/main/storage/credentials/types.ts src/main/storage/credentials/safeStorageCipher.ts build-config/storage/credential-cipher.test.js
git commit -m "feat: define secure credential cipher"
```

### Task 2: Implement the Versioned Credential Vault

**Files:**
- Create: `src/main/storage/credentials/credentialVault.ts`
- Create: `src/main/storage/credentials/index.ts`
- Modify: `src/main/types/app.d.ts`
- Create: `build-config/storage/credential-vault.test.js`
- Create: `build-config/storage-electron/safe-storage-vault.test.js`

**Interfaces:**
- Consumes: `AtomicJsonFile<T>` and `CredentialCipher`.
- Produces: `CredentialVault`, per-entry status, flush, and atomic migration markers.
- Persists: `<profileRoot>/credentials.v1.json` mode `0600` where supported.

- [ ] **Step 1: Write entry-level corruption, removal, and plaintext-scan tests**

```js
it('stores no plaintext secret and round-trips each entry independently', async() => {
  await vault.write({ kind: 'netease-cookie' }, { version: 1, cookie: 'COOKIE_SENTINEL' })
  await vault.write({ kind: 'webdav-basic' }, { version: 1, username: 'u', password: 'PASS_SENTINEL' })
  await vault.flush()
  assert.doesNotMatch(await fs.readFile(vaultPath, 'utf8'), /COOKIE_SENTINEL|PASS_SENTINEL/)
  assert.equal(vault.read({ kind: 'netease-cookie' }).status, 'available')
})

it('preserves an undecryptable entry without affecting another entry', async() => {
  await corruptEntry('netease-cookie')
  assert.equal(vault.read({ kind: 'netease-cookie' }).status, 'undecryptable')
  assert.equal(vault.read({ kind: 'qq-music-cookie' }).status, 'available')
  assert.equal(readEnvelope().entries['netease-cookie'].ciphertext, corruptedCiphertext)
})

it('keeps memory-only values off disk', async() => {
  const memoryVault = createVault({ cipher: memoryOnlyCipher })
  const result = await memoryVault.write({ kind: 'qq-music-cookie' }, { version: 1, cookie: 'SECRET' })
  assert.deepEqual(result, { persistence: 'memory-only' })
  assert.equal(await exists(vaultPath), false)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/credential-vault.test.js
```

Expected: FAIL because the vault is missing.

- [ ] **Step 3: Implement the disk envelope and vault API**

```ts
export interface CredentialVaultFileV1 {
  version: 1
  entries: Record<string, {
    version: 1
    ciphertext: string
    updatedAtMs: number
  }>
  migrationMarkers: Record<string, {
    sourceSha256: string
    completedAtMs: number
  }>
}

export type CredentialRead<T> =
  | { status: 'available'; value: T }
  | { status: 'missing' }
  | { status: 'undecryptable' }
  | { status: 'memory-only'; value: T }

export interface CredentialVault {
  read<T>(ref: CredentialRef): CredentialRead<T>
  write<T>(ref: CredentialRef, value: T): Promise<{ persistence: 'encrypted' | 'memory-only' }>
  remove(ref: CredentialRef): Promise<void>
  verify<T>(ref: CredentialRef, expected: T): Promise<boolean>
  getMigrationMarker(name: string): { sourceSha256: string; completedAtMs: number } | null
  putMigrationMarker(name: string, sourceSha256: string, completedAtMs: number): Promise<void>
  flush(): Promise<void>
}
```

Serialize each payload with canonical JSON before encryption. Decryption validates the payload associated with that `CredentialRef`; a valid cipher with the wrong payload type returns `undecryptable`. Never delete a bad entry during `read()`. Install the singleton only after `app.whenReady()` makes safeStorage available and before account/sync services hydrate.

- [ ] **Step 4: Verify pure and real-Electron behavior**

```powershell
node --test build-config/storage/credential-vault.test.js
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/safe-storage-vault.test.js
```

Expected: PASS; on hosts without a secure backend, the Electron test asserts `memory-only` rather than failing.

- [ ] **Step 5: Commit**

```powershell
git add src/main/storage/credentials/credentialVault.ts src/main/storage/credentials/index.ts src/main/types/app.d.ts build-config/storage/credential-vault.test.js build-config/storage-electron/safe-storage-vault.test.js
git commit -m "feat: add encrypted credential vault"
```

### Task 3: Add Public Account Profiles and the Account Repository

**Files:**
- Create: `src/main/worker/dbService/migrations/0004_account_profiles.ts`
- Modify: `src/main/worker/dbService/migrations/index.ts`
- Create: `src/main/worker/dbService/modules/account_profile/statements.ts`
- Create: `src/main/worker/dbService/modules/account_profile/dbHelper.ts`
- Create: `src/main/worker/dbService/modules/account_profile/index.ts`
- Modify: `src/main/worker/dbService/modules/index.ts`
- Modify: `src/main/worker/dbService/index.ts`
- Create: `src/main/storage/accounts/accountRepository.ts`
- Create: `build-config/storage-electron/account-profile.test.js`
- Create: `build-config/storage/account-repository.test.js`

**Interfaces:**
- Consumes: vault from Task 2 and app DB migration runner.
- Produces: schema version `4`, worker account-profile RPC, and the main-process `AccountRepository`.
- Guarantees: public status objects cannot contain Cookies.

- [ ] **Step 1: Write schema and logical-operation tests**

```js
it('accepts only public provider profiles', () => {
  repo.upsertAccountProfile({ provider: 'qq_music', profileJson: '{"name":"Q"}', updatedAtMs: 1 })
  assert.deepEqual(repo.getAccountProfile('qq_music'), {
    provider: 'qq_music', profileJson: '{"name":"Q"}', updatedAtMs: 1,
  })
  assert.throws(() => repo.upsertAccountProfile({ provider: 'qq', profileJson: '{}', updatedAtMs: 1 }))
})

it('returns a secret-free account record after hydration', async() => {
  await repository.hydrate()
  const status = repository.getStatus('netease')
  assert.equal(status.loggedIn, true)
  assert.equal(Object.hasOwn(status, 'cookie'), false)
  assert.doesNotMatch(JSON.stringify(status), /COOKIE_SENTINEL/)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/account-profile.test.js
node --test build-config/storage/account-repository.test.js
```

Expected: FAIL because schema version 4 and repository are absent.

- [ ] **Step 3: Add the authoritative profile table and APIs**

Migration SQL:

```sql
CREATE TABLE account_profiles (
  provider TEXT PRIMARY KEY CHECK(provider IN ('netease', 'qq_music')),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);
```

Worker API:

```ts
getAccountProfile(provider: 'netease' | 'qq_music'): AccountProfileRow | null
upsertAccountProfile(row: AccountProfileRow): void
removeAccountProfile(provider: 'netease' | 'qq_music'): void
```

Main repository:

```ts
export interface AccountRepository {
  hydrate(): Promise<void>
  getStatus(provider: 'netease' | 'qq_music'): AccountStatus
  getCookie(provider: 'netease' | 'qq_music'): string | null
  save(provider: 'netease' | 'qq_music', input: {
    cookie: string
    profile: JsonValue
    updatedAtMs: number
  }): Promise<{ persistence: 'encrypted' | 'memory-only' }>
  clear(provider: 'netease' | 'qq_music'): Promise<void>
}
```

`save()` validates, writes and verifies the vault entry, writes the public profile through the worker, reads both destinations back, then updates hydrated memory. `clear()` attempts vault removal and DB profile removal, reports either failure, and leaves memory logged out only after both calls finish. Account status exposes `loggedIn`, public profile, updated time, and persistence state only.

- [ ] **Step 4: Verify GREEN**

```powershell
node --test build-config/storage/account-repository.test.js
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/account-profile.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/migrations/0004_account_profiles.ts src/main/worker/dbService/migrations/index.ts src/main/worker/dbService/modules/account_profile src/main/worker/dbService/modules/index.ts src/main/worker/dbService/index.ts src/main/storage/accounts/accountRepository.ts build-config/storage/account-repository.test.js build-config/storage-electron/account-profile.test.js
git commit -m "feat: add secure account repository"
```

### Task 4: Migrate Allowlisted Legacy Secrets Idempotently

**Files:**
- Create: `src/main/migration/credentials/legacySources.ts`
- Create: `src/main/migration/credentials/credentialMigration.ts`
- Create: `src/main/migration/credentials/redactLegacySecrets.ts`
- Modify: `src/main/startup/storageCoordinator.ts`
- Create: `build-config/storage/credential-migration.test.js`

**Interfaces:**
- Consumes: `data.json`, `config_v2.json`, sync client/server JSON, vault, account repository, and marker repository.
- Produces: destination-specific markers plus `legacy_data_v1.credentials` and `legacy_data_v1.account_profiles`.
- Leaves: unrelated `data.json` values intact for later phases.

- [ ] **Step 1: Write source mapping and crash-resume tests**

Use fixtures for these exact sources:

```text
data.json -> neteaseAccount.cookie, neteaseAccount.profile, neteaseAccount.updatedAt
data.json -> qqMusicAccount.cookie, qqMusicAccount.profile, qqMusicAccount.updatedAt
config_v2.json -> setting["webdav.username"], setting["webdav.password"]
sync/client/syncAuthKey.json -> each client key
sync/server/devices.json -> each device key
sync/server/users/<validated-user>/devices.json -> each device key when present
legacy sync.json -> syncAuthKey and clients only when the newer source is absent
```

```js
for (const failAt of ['after-vault-write', 'after-profile-write', 'after-source-redaction']) {
  it(`resumes safely ${failAt}`, async() => {
    await assert.rejects(runMigration({ failAt }), /injected failure/)
    await runMigration()
    assert.equal(await countVaultEntries(), expectedEntryCount)
    assert.equal(await countAccountProfiles(), 2)
    assert.equal(await verifyEveryDestination(), true)
  })
}
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/credential-migration.test.js
```

Expected: FAIL because no credential coordinator exists.

- [ ] **Step 3: Implement per-destination migration**

```ts
export type CredentialMigrationResult =
  | { status: 'complete'; encryptedEntries: number; memoryOnlyEntries: number; profiles: number }
  | { status: 'secure-storage-unavailable'; volatileEntries: number }

export async function migrateLegacyCredentials(
  deps: CredentialMigrationDeps,
): Promise<CredentialMigrationResult>
```

Normalize and hash each entry separately. For an encrypted destination: write, decrypt, validate, compare canonical JSON, and write the vault marker. For profiles: one SQLite transaction upserts profiles, reads counts/hashes, and writes the DB marker. Only after both classes verify, atomically redact credential fields from their active source documents. Never create a plaintext `.bak`; until verification, the original source is the retry source.

Path rules for multi-user sync data: validate directory names, resolve each path, require it to remain below the exact sync-user root, and reject symbolic traversal. Redaction rewrites sync metadata without `key`; it does not remove device IDs, names, protocol selection, or last-connect times.

If secure storage is memory-only, validate the legacy credential into the process-only vault for this run, mark its destination as `memory-only`, and atomically redact the plaintext source. Do not create a persistent vault entry or a recoverable plaintext copy. The current process may remain authenticated from memory, but the next startup is logged out and reports that secure persistence is unavailable; this is the deliberate no-plaintext-fallback behavior.

- [ ] **Step 4: Wire the migration before service registration and verify GREEN**

Insert the hook after DB ready/vault initialization and before `initSetting()` exposes settings or account/sync modules start. Run:

```powershell
node --test build-config/storage/credential-migration.test.js
npm run build:main
```

Expected: PASS and migration runs only after the single-instance lock.

- [ ] **Step 5: Commit**

```powershell
git add src/main/migration/credentials src/main/startup/storageCoordinator.ts build-config/storage/credential-migration.test.js
git commit -m "feat: migrate legacy credentials"
```

### Task 5: Cut QQ Music and NetEase over to AccountRepository

**Files:**
- Modify: `src/main/modules/qqMusic/index.ts`
- Create: `src/main/modules/netease/account.ts`
- Modify: `src/main/modules/netease.ts`
- Create: `build-config/storage/account-credential-cutover.test.js`

**Interfaces:**
- Consumes: hydrated `AccountRepository` from Task 3.
- Produces: unchanged public login/status feature behavior with no `STORE_NAMES.DATA` account access.
- Guarantees: login refresh and logout persist through the vault/profile repository.

- [ ] **Step 1: Write dependency-injected login/refresh/logout tests**

```js
it('persists refreshed QQ cookie and public profile through the repository', async() => {
  await service.refresh()
  assert.deepEqual(repository.saved, {
    provider: 'qq_music', cookie: refreshedCookie, profile: refreshedProfile,
  })
})

it('isolates a corrupt NetEase entry', async() => {
  repository.readResult = { status: 'undecryptable' }
  assert.deepEqual(await service.getStatus(), { loggedIn: false, reason: 'credential_unavailable' })
  assert.equal(qqRepository.clearCalls, 0)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/account-credential-cutover.test.js
```

Expected: FAIL because both modules still read `data.json`.

- [ ] **Step 3: Replace all account storage call sites**

QQ Music replaces its existing `AccountStore` adapter with `AccountRepository`; every login/refresh/logout write is awaited. NetEase extracts `getAccountData`, `saveAccountData`, and refresh state into `src/main/modules/netease/account.ts`; API calls ask hydrated memory for a Cookie and never return it through status IPC.

Required scan after editing:

```powershell
rg -n "STORE_NAMES\.DATA|DATA_KEYS\.(neteaseAccount|qqMusicAccount)" src/main/modules/netease.ts src/main/modules/netease/account.ts src/main/modules/qqMusic/index.ts
```

Expected: no output.

- [ ] **Step 4: Verify GREEN and account bundle**

```powershell
node --test build-config/storage/account-credential-cutover.test.js
npm run build:main
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/modules/qqMusic/index.ts src/main/modules/netease.ts src/main/modules/netease/account.ts build-config/storage/account-credential-cutover.test.js
git commit -m "refactor: move music account credentials to vault"
```

### Task 6: Separate WebDAV Credentials from Settings

**Files:**
- Modify: `src/main/modules/webdav.ts`
- Modify: `src/main/modules/winMain/rendererEvent/webdav.ts`
- Modify: `src/renderer/views/Setting/components/SettingOther.vue`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/common/types/music.d.ts`
- Modify: `src/common/defaultSetting.ts`
- Modify: `src/main/utils/index.ts`
- Create: `build-config/storage/webdav-credential-cutover.test.js`

**Interfaces:**
- Consumes: ordinary `webdav.url` setting and vault entry `{kind:'webdav-basic'}`.
- Produces: credential status/set/remove endpoints and a main-process `getConfiguredWebDAV()`.
- Removes: username/password overrides from ordinary list-music requests.

- [ ] **Step 1: Write settings filter, transient test, and status tests**

```js
it('drops credential keys from every ordinary settings write', () => {
  const sanitized = sanitizeSettingUpdate({
    'webdav.url': 'https://example.test/dav',
    'webdav.username': 'USER_SENTINEL',
    'webdav.password': 'PASS_SENTINEL',
  })
  assert.deepEqual(sanitized, { 'webdav.url': 'https://example.test/dav' })
})

it('returns only a masked WebDAV status', async() => {
  assert.deepEqual(await service.getCredentialStatus(), {
    configured: true,
    usernameHint: 'a***e',
    persistence: 'encrypted',
  })
  assert.doesNotMatch(JSON.stringify(await service.getCredentialStatus()), /PASS_SENTINEL/)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/webdav-credential-cutover.test.js
```

Expected: FAIL because credentials are ordinary settings.

- [ ] **Step 3: Implement narrow WebDAV credential operations**

```ts
getWebDAVCredentialStatus(): Promise<{
  configured: boolean
  usernameHint: string | null
  persistence: 'encrypted' | 'memory-only' | 'missing'
}>

setWebDAVCredentials(input: {
  username: string
  password: string
}): Promise<{ persistence: 'encrypted' | 'memory-only' }>

removeWebDAVCredentials(): Promise<void>
```

Keep `webdav.url` and `webdav.autoRefresh` in `config_v2.json`. Retain username/password default keys only as empty compatibility values during this milestone, and make `updateSetting()` reject non-empty writes to them. The UI owns unsaved input locally, invokes `webdav_test` with a strictly validated transient value, and calls the vault setter only on save. `WebDAVListMusicParams` no longer accepts username/password; normal WebDAV operations combine URL plus vault credentials only in the main process.

- [ ] **Step 4: Verify GREEN and scan settings output**

```powershell
node --test build-config/storage/webdav-credential-cutover.test.js
rg -n "webdav\.(username|password)" src/main src/renderer src/common
npm run build:main
npm run build:renderer
```

Expected: remaining matches are type/default migration compatibility, validator denylist, and local unsaved UI fields only.

- [ ] **Step 5: Commit**

```powershell
git add src/main/modules/webdav.ts src/main/modules/winMain/rendererEvent/webdav.ts src/renderer/views/Setting/components/SettingOther.vue src/renderer/utils/ipc.ts src/common/ipcNames.ts src/common/types/music.d.ts src/common/defaultSetting.ts src/main/utils/index.ts build-config/storage/webdav-credential-cutover.test.js
git commit -m "refactor: isolate WebDAV credentials"
```

### Task 7: Move Sync Keys and Remove Renderer Key Exposure

**Files:**
- Modify: `src/common/types/sync.d.ts`
- Modify: `src/common/constants_sync.ts`
- Rewrite: `src/main/modules/sync/client/data.ts`
- Modify: `src/main/modules/sync/client/auth.ts`
- Modify: `src/main/modules/sync/client/index.ts`
- Rewrite: `src/main/modules/sync/server/user/data.ts`
- Modify: `src/main/modules/sync/server/user/index.ts`
- Modify: `src/main/modules/sync/server/server/auth.ts`
- Modify: `src/main/modules/sync/server/server/server.ts`
- Modify: `src/main/modules/sync/migrate.ts`
- Modify: `src/main/modules/winMain/rendererEvent/sync.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Create: `build-config/storage/sync-credential-cutover.test.js`

**Interfaces:**
- Consumes: vault sync credential refs and atomic metadata writer.
- Produces: key-free `SyncClientProfile` and `SyncServerDevice` to renderer.
- Persists: `sync/client/servers.v1.json` and `sync/server/devices.v2.json` without `key`.

- [ ] **Step 1: Write public-shape and disk-scan tests**

```js
it('removes keys from server status and device IPC data', async() => {
  const status = await service.getStatus()
  const devices = await service.getDevices()
  assert.doesNotMatch(JSON.stringify(status), /SERVER_KEY_SENTINEL/)
  assert.doesNotMatch(JSON.stringify(devices), /SERVER_KEY_SENTINEL/)
  assert.equal(Object.hasOwn(devices[0], 'key'), false)
})

it('leaves no known sync key in JSON metadata', async() => {
  await repository.flush()
  for (const text of await readEveryJson(syncRoot)) {
    assert.doesNotMatch(text, /CLIENT_KEY_SENTINEL|SERVER_KEY_SENTINEL/)
  }
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/sync-credential-cutover.test.js
```

Expected: FAIL because current server status/devices contain `key`.

- [ ] **Step 3: Split public metadata from vault key material**

```ts
export type SyncClientProfile = Omit<LX.Sync.ClientKeyInfo, 'key'>
export type SyncServerDevice = Omit<LX.Sync.ServerKeyInfo, 'key'>

export const toPublicDevice = ({ key: _key, ...device }: LX.Sync.ServerKeyInfo): SyncServerDevice => device
```

Authentication retrieves `{version:1,key}` from the vault using stable server/device IDs. Metadata writers serialize only IDs, names, protocol, mobile flag, and last-connect values. `server.ts` converts to public objects before storing in status, broadcasting status, or returning `getDevices()`. `sync/migrate.ts` must never copy a legacy key into a new JSON document.

After migration verification, replace old key-bearing JSON with key-free versioned metadata or a marker document through the atomic writer. Do not make a plaintext backup.

- [ ] **Step 4: Verify GREEN and compatibility tests**

```powershell
node --test build-config/storage/sync-credential-cutover.test.js
node --test scripts/test-sync-client-compatibility.js
npm run build:main
npm run build:renderer
```

Expected: PASS and current/legacy wire compatibility remains intact.

- [ ] **Step 5: Commit**

```powershell
git add src/common/types/sync.d.ts src/common/constants_sync.ts src/main/modules/sync src/main/modules/winMain/rendererEvent/sync.ts src/renderer/utils/ipc.ts build-config/storage/sync-credential-cutover.test.js
git commit -m "refactor: protect sync key material"
```

### Task 8: Verify the Complete Credential Cutover

**Files:**
- Create: `build-config/storage/credential-profile-scan.test.js`
- Modify: `src/main/startup/storageCoordinator.ts`

**Interfaces:**
- Consumes: all credential tasks.
- Produces: the Phase 1 startup smoke check consumed by non-activity migration.

- [ ] **Step 1: Add a realistic profile scan fixture**

Construct a profile containing all five legacy sources and known sentinels. Run migration, service hydration, QQ/NetEase status, WebDAV status, and sync status. Recursively read every `.json` except the encrypted vault and assert no sentinel remains; inspect the vault text separately and assert it also contains no plaintext sentinel.

```js
for (const secret of knownSecrets) {
  assert.equal((await readProfileJsonText()).includes(secret), false)
  assert.equal((await fs.readFile(vaultPath, 'utf8')).includes(secret), false)
  assert.equal(JSON.stringify(allRendererResponses).includes(secret), false)
}
```

- [ ] **Step 2: Run the complete credential suite**

```powershell
node --test build-config/storage/credential-*.test.js build-config/storage/account-*.test.js build-config/storage/webdav-credential-cutover.test.js build-config/storage/sync-credential-cutover.test.js
npm run test:storage:electron
npm run lint
npm run build:main
npm run build:renderer
```

Expected: PASS.

- [ ] **Step 3: Register the Phase 1 smoke check**

Before account and sync service registration, require:

```ts
export interface CredentialStartupCheck {
  vaultReadable: boolean
  profileRepositoryReadable: boolean
  activePlaintextSources: string[]
}
```

`activePlaintextSources` contains source identifiers only, never values. Any non-empty result blocks the affected service and leaves the startup coordinator in a user-visible error state.

- [ ] **Step 4: Commit the Phase 1 gate**

```powershell
git add build-config/storage/credential-profile-scan.test.js src/main/startup/storageCoordinator.ts
git commit -m "test: verify credential isolation"
```

## Credential Acceptance Gate

Do not start the non-activity migration until all statements are true:

1. Every confirmed secret is encrypted per entry or explicitly memory-only for the current process.
2. `safeStorage` unavailable/basic-text states never persist plaintext.
3. QQ Music and NetEase have no direct account access through `STORE_NAMES.DATA`.
4. WebDAV username/password cannot be written through ordinary settings APIs.
5. Sync JSON metadata and renderer status/device responses contain no key.
6. A corrupt vault entry affects only its owning provider/device and remains preserved.
7. Re-running any interrupted Phase 1 migration neither duplicates entries nor removes the last valid source before verification.
