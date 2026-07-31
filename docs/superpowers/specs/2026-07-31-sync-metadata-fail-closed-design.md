# Sync Metadata Fail-Closed Recovery Design

**Date:** 2026-07-31
**Status:** Approved direction, written-spec review pending
**Scope:** Credential cutover handling for versioned sync metadata

## Context

The credential cutover inventories sync keys, stores them in the credential vault, removes plaintext keys, and normalizes public sync metadata. Current versioned metadata is stored in:

- `sync/client/servers.v1.json`
- `sync/server/devices.v2.json`

Commit `de2deb90` tried to prevent a changed destination from being overwritten by moving the predecessor to a guard and publishing the staged file through a hard link. Review found three blocking defects:

1. Recovery cannot distinguish a completed publication from a competing destination and can discard the predecessor.
2. Recovery can restore a damaged guard before verifying its hash when the destination is absent.
3. FAT and exFAT do not support the hard-link operation required by the protocol.

This protocol is not suitable for a portable application. The selected replacement is fail-closed: versioned sync metadata that is invalid or changes after inventory is preserved and normal startup stops in credential recovery.

## Goals

- Never overwrite, delete, redact, or automatically repair an invalid versioned sync metadata file.
- Never overwrite or delete a versioned sync metadata file that was replaced after credential inventory.
- Preserve every discovered credential until it is either verified in the vault or remains in the untouched source file.
- Block settings initialization and module registration when this recovery condition occurs.
- Show a fixed, non-secret diagnostic and the exact affected file path.
- Keep successful legacy sync migration, cross-destination serialization, replacement-manager serialization, and undecryptable credential projections unchanged.
- Support NTFS, FAT32, and exFAT without hard links or filesystem-specific recovery semantics.

## Non-Goals

- Automatically repairing malformed current versioned metadata.
- Choosing between conflicting or concurrently replaced metadata documents.
- Restoring files from application-created or user-created backups.
- Deleting unknown predecessor-guard files. The hard-link implementation has not shipped, so no startup cleanup or compatibility migration is needed for its experimental artifacts.
- Protecting against an external process that continuously mutates the contents of the same open file handle. The application single-instance lock remains the supported writer-coordination boundary.

## Considered Approaches

### 1. Fail closed on invalid or changed versioned metadata (selected)

The migration validates a public projection of each current versioned document before any source mutation. Invalid documents stop startup. A source replacement detected after inventory also stops startup. The source bytes at the affected path remain unchanged.

This is the smallest design that is portable and does not make an unsafe choice on the user's behalf. Recovery requires user inspection, but it cannot silently lose metadata or credentials.

### 2. Quarantine and regenerate automatically

The application could move malformed metadata aside and generate a clean document. This would keep startup moving, but moving the only key-bearing source is itself a destructive decision and crash recovery would still need to decide which file is authoritative. This approach is rejected.

### 3. Continue the predecessor-guard protocol without hard links

The application could rename the predecessor to a guard and exclusively create a replacement. On a crash, the presence of a guard and destination is ambiguous. Automatically restoring or deleting either file recreates the data-loss problem, while never resolving guards turns the atomic writer into a migration-specific state machine. This approach is rejected.

## Versioned Metadata Preflight

Credential discovery remains responsible for reading the allowlisted versioned metadata paths. For each existing versioned document it records:

- the contained absolute path;
- the file identity already used by credential redaction;
- the original source values needed to verify discovered keys;
- the parsed document used to build a public projection.

The preflight permits `key` only as the known legacy secret extension on a client server entry or server device entry. It clones the document, removes only those allowed `key` properties, then validates the clone with the same runtime validators used by the sync readers:

- `isSyncClientServersFileV1`
- `isSyncServerDevicesFileV2`

The migration must not use a permissive normalization result as evidence that a versioned document is valid. Empty identifiers, invalid dates, missing required fields, forbidden fields, invalid envelopes, invalid JSON, and unexpected key locations all fail the preflight.

Legacy sources such as `sync.json`, `sync/client/syncAuthKey.json`, `sync/server/devices.json`, and per-user legacy `devices.json` retain their existing migration rules. The strict fail-closed rule applies to the current versioned destinations, not to formats whose purpose is migration.

Preflight examines current destinations in a fixed order: client `servers.v1.json`, then server `devices.v2.json`. If more than one document is invalid, the recovery result reports the first path in that order. No migration writes occur before the complete two-file preflight succeeds, so fixing one file and restarting safely reveals the next failure.

## Migration Flow

For each startup attempt:

1. Discover all allowlisted credential sources and current versioned metadata.
2. Build key inventories and public projections without modifying any source file.
3. Strictly validate every current versioned public projection.
4. If any projection is invalid, return credential recovery immediately. Do not write vault entries, profiles, metadata, markers, or redactions during this attempt.
5. If all projections are valid, write each discovered credential to the vault and verify normalized decrypt-and-compare equality, as in the existing cutover.
6. Before redacting a source, reopen the inventoried file, verify its contained path, file identity, and each inventoried credential value, and retain the open handle.
7. If the path or inventoried value changed, stop with credential recovery. Do not write through that handle and do not modify the file now present at the path. Vault entries already verified in step 5 may remain; this is a safe duplicate, not credential loss.
8. Redact only the exact inventoried file through its verified open handle, flush it, and validate the resulting current versioned document with the runtime validator.
9. Continue the existing legal sync migration and verification flow.

The process never silently drops a discovered credential. Before vault verification it remains in the untouched source. After vault verification it may remain in both locations if a later identity check fails, and recovery prevents normal use until the conflict is resolved.

## Atomic JSON Writer Changes

`AtomicJsonFile` keeps its filesystem-neutral core while deleting every migration-only invalid-predecessor exception:

- Remove `expectedPreviousFileSha256`.
- Do not restore the earlier `allowInvalidPreviousFileSha256` option or any other validation bypass.
- Remove `link` from `AtomicFileSystem`.
- Remove expected-predecessor guard naming, tracking, cleanup, restoration, and publication.
- Remove all tests that define the hard-link guard protocol.
- Keep ordinary stage verification, valid-destination validation, previous-file handling, durable rename, read-back verification, write coalescing, and owned-temp cleanup.

The sync migration no longer passes an expected predecessor hash. The preflight guarantees that invalid current versioned metadata never reaches `replaceMetadata`. Valid current metadata and absent destinations continue through the ordinary writer under the existing single-instance startup lock.

Any file matching the experimental `.expected-previous-*` naming pattern is treated as an unknown file. The application must not restore, delete, or interpret it automatically.

## Recovery Contract

Introduce a typed, internal migration recovery error whose public fields contain only:

```ts
class CredentialMigrationRecoveryError extends Error {
  readonly code:
    | 'credentials.sync_metadata_invalid'
    | 'credentials.sync_metadata_changed_after_inventory'
  readonly affectedPath: string
}
```

The error constructor accepts only an allowlisted versioned metadata path already proven to be contained by the selected data root. It does not include file contents, parsed objects, keys, ciphertext, hashes, or raw exception messages.

`runStorageMigrationHooks` recognizes this typed error and returns:

```ts
{
  status: 'recovery',
  reason: 'credential_startup_check_failed',
  target: {
    kind: 'external-migration',
    component: 'credentials',
    affectedPath,
    diagnostics: [code],
  },
}
```

Unknown migration failures keep the existing fixed `credentials.legacy_migration_failed` diagnostic. The recovery dialog shows the fixed code and sanitized affected path, offers **Open data folder** and **Quit**, and then quits. It never reads or displays the affected file. The coordinator must not initialize settings, register modules, or signal `appInited` after this outcome.

On the next launch, the complete preflight runs again. Once the user has restored, removed, or manually corrected the affected file, normal idempotent migration can resume. Startup does not inspect backups and does not automatically select a replacement file.

## Preserved Behavior

The following accepted behavior is outside this change and must remain intact:

- Vault-first credential writes and normalized decrypt-and-compare verification.
- Source redaction only after destination verification.
- Mixed legacy source coalescing and conflict detection.
- Valid legacy-to-versioned sync migration and source cleanup after verification.
- The shared whole-document queues and replacement-manager refresh behavior from `3338da13`.
- Service-specific `credential_undecryptable` status projection from `f9c0a2c4`.
- Ordinary missing, logged-out, and no-key status shapes.
- No credential fields in renderer-facing sync, account, or WebDAV status types.

## Test Design

### Strict preflight

Table-driven tests cover both versioned paths with:

- invalid JSON and invalid envelope versions;
- empty or missing identities and names;
- negative, fractional, unsafe, or otherwise invalid dates;
- forbidden fields and keys at unexpected locations;
- key-bearing entries whose public projection is otherwise valid.

Every invalid case must return `credentials.sync_metadata_invalid`, identify the exact affected path, preserve the source bytes byte-for-byte, perform zero source deletions or replacements, and prevent vault/profile/marker writes during that attempt. A valid key-bearing projection must proceed and produce runtime-readable key-free metadata.

### Change after inventory

Deterministic boundary tests replace each versioned file after inventory and before redaction. They require:

- `credentials.sync_metadata_changed_after_inventory`;
- the replacement document to remain byte-for-byte unchanged;
- no deletion or overwrite of the path;
- an already verified inventoried credential may remain available in the vault;
- a credential present only in the replacement must not appear in the vault;
- normal startup must not continue.

### Recovery UI

Startup coordinator and dialog tests require the fixed code and exact sanitized path, no raw exception or file payload, **Open data folder** plus **Quit**, and zero settings/module initialization after recovery.

### Legal migration and regressions

Retain or add coverage for:

- absent current destination created from a legacy source;
- valid key-bearing current metadata redacted and accepted by runtime readers;
- mixed current and legacy sources with non-conflicting destinations;
- interrupted migration resumed without deleting the last verified credential source;
- cross-destination save/save and save/remove serialization;
- two-manager stale-snapshot protection;
- undecryptable account, WebDAV, sync-client, and sync-server projections.

### Portable filesystem contract

Automated coverage must prove that the production path has no hard-link dependency:

- `AtomicFileSystem` exposes no `link` operation.
- Production and storage-test scans contain no `fs.link`, `fs.linkSync`, `expectedPreviousFileSha256`, or `.expected-previous-` protocol references.
- Atomic writer and sync migration tests run against a filesystem adapter limited to operations available on NTFS, FAT32, and exFAT.
- A portable-volume smoke script accepts an explicit fixture root and runs only synthetic migration data. Release verification runs it on NTFS, FAT32, and exFAT volumes when those volume types are available; it never points at a real user profile.

Directory fsync remains best-effort because it is not uniformly supported. Correctness must not depend on directory fsync or hard-link support.

## Acceptance Criteria

1. An invalid current versioned sync metadata file remains byte-for-byte unchanged and produces user-visible credential recovery with its exact path.
2. A versioned sync metadata file replaced after inventory remains byte-for-byte unchanged and produces the changed-after-inventory diagnostic.
3. No discovered credential is silently overwritten or discarded.
4. Normal startup cannot proceed after either recovery condition.
5. No application path automatically repairs, restores, deletes, or selects among invalid or changed versioned metadata files.
6. The hard-link predecessor protocol and all of its production references are removed.
7. Legal sync migration, Important 7 concurrency behavior, and Important 8 status projection remain green.
8. The full storage, Electron storage, lint, main build, renderer build, credential-field scans, path scans, and portable filesystem checks pass before packaging.

## Implementation Boundary

The implementation is intentionally limited to versioned sync metadata preflight, typed recovery propagation, removal of the experimental hard-link protocol, and focused tests. It does not redesign the general atomic writer, alter unrelated storage formats, access the real application profile, restore backups, or build/run the previously produced portable executable.
