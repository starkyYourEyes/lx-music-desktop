# Sync Credential Re-authentication Recovery Design

**Date:** 2026-08-06

**Status:** Approved direction; pending written-spec review

## Problem

The sync client can retain a valid server profile while its credential vault
entry is no longer decryptable. The current client reports
`credential unavailable`, but the renderer opens the authentication-code modal
only for missing or rejected credentials. The user cannot replace the unusable
credential through the interface.

The reproduced failure followed an Electron runtime-path change. Existing sync
ciphertext authenticates with the Chromium `os_crypt` key from the former
Roaming `Local State`; the new installed and portable runtime keys cannot
authenticate it. The server remains reachable, `/hello` and `/id` succeed, and
the server profile still matches the vault entry.

## Goals

- Open the authentication-code modal when the client reports
  `credential_undecryptable`.
- Keep the configured server address and public server profile while the user
  re-authenticates.
- Replace the unusable credential through the existing authenticated
  `setSyncAuthKey` path.
- Show a localized recovery status instead of the raw internal error.
- Preserve existing handling for missing codes, rejected codes, blocked IPs,
  connection failures, and successful synchronization.

## Non-Goals

- Copying or replacing Chromium `Local State` files.
- Decrypting old credentials with application-managed platform crypto.
- Automatically deleting an undecryptable credential or its public profile.
- Recovering credentials after moving the profile to another operating-system
  account or machine without server authentication.
- Changing the sync protocol, server device records, or credential-vault file
  format.

## Considered Approaches

### 1. Prompt for a new authentication code (selected)

The main process already projects `credential_undecryptable` in
`ClientStatus.unavailableReason`. The renderer can treat this status as a
recoverable authentication requirement, open the existing modal, and submit
the code through the existing `enable_client` action. Successful code
authentication writes a credential encrypted by the current runtime context.

This approach repairs both installed and portable profiles without handling
encryption keys in renderer code or changing persistent formats.

### 2. Migrate the former Chromium `Local State` key

The application could locate and merge the former `os_crypt.encrypted_key`
into the new runtime. Profiles may already contain credentials written under
both old and new keys, so replacing the current key can make newer credentials
unreadable. Cross-platform migration would also require platform-specific
handling. This approach is rejected.

### 3. Treat the credential as missing in the main process

`getSyncAuthKey` could return `null` for an undecryptable entry and reuse the
existing `Missing auth code` path. This discards the distinction between an
absent credential and a retained but unreadable credential. Account, WebDAV,
sync-client, and sync-server status contracts already expose this distinction.
This approach is rejected.

## Design

The renderer will derive the sync-client presentation from the full client
status rather than its message alone. When
`unavailableReason == 'credential_undecryptable'`, it will:

1. show a localized status that asks the user to enter a new connection code;
2. open `SyncAuthCodeModal` through the same state used for missing and rejected
   authentication codes;
3. leave the configured host and client profile unchanged.

Submitting a code keeps the current data flow:

1. `SyncAuthCodeModal` sends `enable_client` with the configured host and code.
2. The main process validates the server through `/hello` and `/id`.
3. Code authentication returns a new client key.
4. `setSyncAuthKey` writes and verifies the key in the credential vault, then
   retains the public server profile.
5. The WebSocket connection starts and successful synchronization clears the
   error status.

Closing the modal does not delete or modify the old entry. A rejected code
keeps the modal available through the existing `Auth failed` behavior. A
connection error continues to surface through the existing status path.

The localized message will be added to every maintained language file. The
internal `credential unavailable` message remains available to the main-process
log and status contract but will not be the renderer's primary status text when
the typed reason is present.

## Testing

Implementation will follow red-green-refactor. A focused renderer test will
first reproduce a client status with:

```ts
{
  status: false,
  message: 'credential unavailable',
  address: [],
  unavailableReason: 'credential_undecryptable',
}
```

The test will require the authentication modal to open and the client status to
use the localized recovery message. It will also prove that:

- missing-code and rejected-code statuses still open the modal;
- a normal connection failure does not open it;
- a successful or neutral status closes an already-open modal;
- submitting a replacement code still sends `enable_client` with the current
  host and code.

The focused test will run before and after the production change. Existing sync
credential-cutover, renderer build, TypeScript, and lint checks will run after
the focused test passes.

## Acceptance Criteria

1. An undecryptable sync-client credential opens the authentication-code modal
   without manual profile edits.
2. The settings page shows a localized recovery message instead of
   `credential unavailable`.
3. A valid code replaces the unusable credential and allows synchronization to
   connect.
4. Canceling or entering an invalid code does not delete the existing profile
   or alter server-side device records.
5. Existing missing-code, authentication-failure, connection-failure, blocked
   IP, and successful-sync behavior remains covered and unchanged.
