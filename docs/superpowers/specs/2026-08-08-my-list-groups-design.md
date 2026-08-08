# My List Groups Design

## Goal

Split the My Lists sidebar into two fixed groups:

- `My`, for the built-in favorites list and playlists assigned to the user's own group; and
- `Imported / Collected`, for playlists acquired from files or online sources.

Users can move normal playlists between the two groups. The group controls organization only. Moving a playlist does not change its source binding or contents.

## Confirmed Scope

The first version includes:

- two fixed, collapsible groups in the My Lists sidebar;
- a persisted group assignment for each user playlist;
- group counts and empty-group behavior;
- group-local sorting and cross-group moves;
- right-click and drag interactions for moving playlists;
- migration rules for existing playlists;
- group-aware playlist and full-data backups; and
- compatibility rules for clients that do not support groups.

The first version does not synchronize group assignments. It keeps the data model ready for a future sync-protocol extension.

## Group Model

Add this optional field to `LX.List.UserListProfile`:

```ts
group?: 'mine' | 'external'
```

`mine` maps to the `My` heading. `external` maps to `Imported / Collected`.

The field records the playlist's current group. It does not record an immutable origin. A user can move an online playlist to `My` without removing `source` or `sourceListId`.

Store the field in the existing `playlist_metadata.profile_json` value. This avoids a database schema migration and keeps the field outside the current playlist sync payload. Extend the profile parser and validator to accept only the two supported values.

The built-in favorites list belongs to `mine`, stays first in that group, and does not need a stored group field. Users cannot move, rename, or delete it.

## Group Resolution

Resolve a user playlist's group in this order:

1. Use a valid stored `profile.group`.
2. If either `source` or `sourceListId` exists, use `external`.
3. Use `mine`.

Treat an unknown or malformed group value as missing. Persist a derived group to playlist metadata so each existing playlist receives an explicit assignment after the first load.

Load playlist metadata during application data initialization before the grouped sidebar renders. The sidebar must not place a playlist in a temporary group and move it after the metadata request completes.

## Default Assignment Rules

| Operation | Resulting group | Source binding |
| --- | --- | --- |
| Create a playlist | `mine` | None |
| Duplicate any playlist | `mine` | Removed from the duplicate |
| Collect an online playlist or leaderboard | `external` | Preserved |
| Import a new single-playlist file | `external` | Preserved when present in the file |
| Import a single-playlist file over an existing ID | Keep the target's current group | Follow the existing metadata overwrite rules |
| Restore playlist or full-data backup | Restore valid saved group | Preserved |
| Restore an older backup without a group | Derive from source fields | Preserved |
| Receive a new playlist from current sync | Derive from source fields | Preserved |
| Receive an update for an existing synced playlist | Keep the local group | Preserve the synced source fields |

A later source refresh, content overwrite, or online synchronization must not reset a user's group choice.

## Sidebar Structure

Keep the existing `My Lists` title and its New List and Update Source Lists buttons. The New List button creates a playlist at the end of `My`. The group headings do not gain action buttons.

Render the groups in this fixed order:

1. `My`
2. `Imported / Collected`

Each heading contains a disclosure icon, translated label, and playlist count. The `My` count includes the built-in favorites list. Keep the `Imported / Collected` heading visible with a count of `0` when it has no playlists. Do not render an empty-state row.

Use a focusable button for each heading and expose `aria-expanded`. Clicking the heading or disclosure icon toggles the group.

Store collapse state in device-local UI state as `myListGroupCollapsed: { mine: boolean, external: boolean }`. Default both values to `false`. Do not include collapse state in playlist backups, settings backups, or sync data.

Users may collapse the group that contains the current playlist. Keep it collapsed until another action needs to reveal a target. Navigation from a deep link, playback-page locator, or another view expands the selected playlist's group and scrolls it into view.

Creating, importing, collecting, or moving a playlist expands its target group and scrolls to the affected row. Preserve the playlist displayed in the detail pane unless the existing initiating flow already selects another playlist.

## Ordering And Movement

Maintain a separate visible order inside each group. Filter playlists from the current `userLists` position order, then render each group independently.

After a local reorder or cross-group move, normalize the persisted user-list order to:

1. normal user-list entries assigned to `mine`; then
2. entries in `external`.

The built-in favorites list does not participate in the database position order.

Add one move command to each normal playlist's context menu. The command names the other group, for example `Move to "My"`. Do not show a move command for the current group or the built-in favorites list.

Keep the existing drag activation behavior. Support sorting inside a group and dragging across groups. When the pointer rests over a collapsed target heading, expand that group. Dropping on the heading before expansion moves the playlist to the target group's end. A drop inside an expanded group uses the indicated position.

Move commands update `profile.group` and list position as one user operation. A moved online playlist keeps source-detail and source-update actions. Duplicating it creates a local, unbound playlist in `mine`.

The current sidebar code uses visible DOM indexes to read `userLists[index]`. Grouping and collapse break that assumption. Refactor menu, rename, import, and drag handlers to pass stable playlist IDs or playlist objects. Resolve the current list by ID at the action boundary.

## Backup And Import

Project each user playlist's group into its serialized backup record. Keep the existing `playList_v2`, `allData_v2`, and `playListPart_v2` type identifiers and add `group` as an optional, backward-compatible property. Older clients can ignore the extra property.

Playlist and full-data restore paths apply a valid saved group to existing and new playlists. They derive a group for records from older backups or records with invalid values.

The single-playlist import path follows acquisition semantics instead of restore semantics. It assigns `external` to a new target and preserves the current group when the imported ID overwrites an existing target. The importer may read the serialized group but must not use it to override these rules.

Import functions must await playlist creation, music writes, and group metadata writes before reporting success or revealing the target row.

## Sync Boundary

Keep `group` out of the current sync snapshot and all incremental list actions. The existing sync protocol carries core list information, while group storage remains in `playlist_metadata`.

A remote full overwrite retains metadata for list IDs that remain present and removes metadata for deleted IDs. The group resolver assigns and persists a group for remote playlists that arrive without local metadata.

Position changes continue through the existing sync path. Older clients may observe the normalized global playlist order, but they do not receive group assignments. A future protocol version can add `group` to playlist metadata and define conflict resolution without moving the local storage field.

## Failure Handling

Group resolution falls back to source-based derivation when it reads invalid metadata. A failed background write does not block playlist loading. Keep the derived value for the renderer session, log the failure, and retry when metadata is written again.

Manual cross-group moves require stronger handling because derivation cannot recover the user's choice. Snapshot the old group and order before writing. Do not present the move as complete until both writes succeed. If either write fails, restore the previous group and order. Reload both durable stores if rollback fails, then show the existing generic operation error UI.

Deleting a playlist removes its playlist metadata. Retain operations remove metadata only for playlist IDs that no longer exist.

Missing or invalid collapse state resets both groups to expanded.

## Localization And Layout

Add translations for the two group labels and move commands to every bundled locale. Keep the labels on one line with ellipsis inside the current sidebar width and supported sidebar scale range. The count and disclosure control must keep stable dimensions so long translations cannot shift playlist rows.

Match the existing sidebar colors, type scale, spacing, hover states, and active-row treatment. Groups add hierarchy without changing the playlist cards, cover artwork, detail pane, or global navigation.

## Testing

Write focused tests before production changes for:

- explicit group resolution, source-based fallback, and invalid-value recovery;
- metadata validation, persistence, retention, and deletion;
- default assignments for create, duplicate, online collect, single import, restore, and current sync;
- same-ID single import preserving the target group;
- old backup migration and backup round trips;
- current sync snapshots and incremental actions excluding `group`;
- fixed group order, counts, empty external group, and favorites placement;
- collapse persistence and navigation-triggered expansion;
- group-local sorting and both cross-group move interactions;
- dropping on collapsed headings and at explicit positions; and
- context-menu, rename, import, and drag actions resolving targets by stable ID.

Run the focused renderer and storage tests, lint touched files, and build the renderer. Inspect the sidebar at minimum and maximum supported scale in narrow and standard windows, using English and both Chinese locales. Verify expanded, collapsed, empty, active, dragging, and long-label states.

## Non-Goals

- User-created, renamed, deleted, or reordered groups.
- Nested groups or folders.
- Group-specific header actions.
- Group synchronization in the current protocol.
- Changes to online source binding when a playlist moves.
- Changes to playlist contents, song sorting, playback, or the detail pane.
