# Sync Protocol Compatibility Design

## Goal

Restore bidirectional sync compatibility between the current Starky build and
the original LX Music desktop and mobile clients without restoring unrelated
upstream project identity, repository, update, or branding metadata.

The supported matrix is:

| Client | Server | Expected result |
| --- | --- | --- |
| Current desktop | Current server | Connect with the current protocol |
| Current desktop | Original server | Fall back to the legacy protocol |
| Original desktop | Current server | Connect with the legacy protocol |
| Original mobile | Current server | Connect with the legacy protocol |

Unknown authentication prefixes, client identities, and connection messages
must remain rejected.

## Protocol Model

Create one compatibility module that defines two exact protocol profiles:

- `current`: uses the identifiers from `PROJECT_IDENTITY`.
- `legacy`: uses the original sync authentication prefix, desktop and mobile
  client identifiers, and WebSocket connection message.

Each profile contains only the values needed for sync interoperability. Legacy
repository URLs, author metadata, update endpoints, protocol handlers, user
data paths, and other upstream identity values remain excluded.

Authenticated client and server key records gain an optional protocol marker.
Records without a marker are treated as current records for backward
compatibility with data already written by the current build.

## Current Client to Original Server

Code authentication tries the current profile first. It retries with the
legacy profile only when the server returns an authentication failure. Network
errors, blocked-IP responses, malformed responses, and other failures are not
used as a reason to downgrade.

After successful authentication, the selected profile is stored with the
server key. Cached-key authentication uses the stored profile. For an older
unmarked key, it tries the current profile first and may retry the legacy
profile after an authentication failure, then persists the successful marker.

The WebSocket connection message is selected from the same stored profile.
Reconnects therefore keep using the protocol that authenticated the key.

## Original Client to Current Server

The server decrypts a code-authentication request and matches its authentication
prefix and client identity against the two exact profiles. It creates the
device key only when both values belong to the same profile and stores that
profile with the key.

Cached-key authentication and WebSocket connection authentication use the
profile stored on the device key. This prevents mixed-profile handshakes while
allowing both approved protocol versions.

Original desktop and mobile identities preserve their existing `isMobile`
classification. Unknown, malformed, or cross-profile values are rejected.

## Failure Handling

Automatic fallback is limited to explicit authentication failure. A wrong
connection code can therefore consume two authentication attempts, one for
each profile, but the existing blocked-IP behavior remains unchanged.

The renderer continues to receive the existing error messages. This change
does not add a compatibility toggle or expose protocol details in the UI.

## Test Strategy

Tests will be written before implementation and will cover:

- Exact values and ordering of the current and legacy protocol profiles.
- Current authentication remains the first client attempt.
- Client fallback occurs only after authentication failure.
- Successful client authentication stores the selected protocol.
- WebSocket connection messages follow the stored protocol.
- The current server accepts current desktop and mobile clients.
- The current server accepts original desktop and mobile clients.
- Cached-key and WebSocket authentication work for both profiles.
- Unknown and cross-profile authentication data remain rejected.
- The legacy sync identifiers are allowlisted only in the compatibility
  module and its tests; unrelated production files remain free of upstream
  identity values.

After focused tests pass, run the broader identity/security tests, lint the
changed source files, build the application, and produce a Windows x64 portable
package.
