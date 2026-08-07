# Artwork Song Rows Design

## Goal

Give every primary single-song list a consistent artwork-led row: a square cover followed by a two-line title and artist block, while preserving the information, controls, grouping, selection, and playback behavior already owned by each surface.

## Confirmed Scope

Apply the new row treatment to:

- online playlist details;
- My Lists, including the favorites list;
- single-song search results;
- leaderboard song results;
- the play queue;
- Local Music;
- WebDAV cloud-disk lists; and
- Recent Play.

Do not change download-task tables, song-selection modals, duplicate-song modals, or other compact auxiliary lists.

## Confirmed Visual Behavior

- Use a base row height of `60px` and a `44px` square cover with a `4px` corner radius.
- Scale the row and cover modestly with the application's existing font-size behavior so larger accessibility text is not clipped.
- Place the cover inside the main title column rather than creating a separately labeled table column.
- Render the song name on the first line and the artist on the second line.
- Rename the table header from the existing song-name label to a new `Title` label and remove the separate artist header and column.
- Keep the album, duration, source, action, index/current-playing marker, and any surface-specific columns unchanged.
- Preserve existing quality and source badges on the song-name line.
- Do not add the reference image's master-quality, VIP, preview, or favorite columns and badges.
- Keep both text lines single-line and ellipsized. The full song name and artist remain available through the existing accessible labels/tooltips.
- Use `object-fit: cover` for artwork and show a stable music placeholder during loading and after a load error.
- Preserve every existing row interaction: selection, multi-selection, double-click playback, context menus, action buttons, queue navigation, current-song highlighting, and keyboard behavior.

## Architecture Decision

Three implementation shapes were considered:

1. Duplicate the cover and two-line markup in every list. This is locally simple but would repeat asynchronous artwork loading, fallback behavior, sizing, and accessibility logic across at least four row implementations.
2. Replace every list with one universal row component. This maximizes reuse but would force unrelated table, queue, virtualization, selection, and action contracts into a large component and risks regressions.
3. Share only the cohesive visual units and keep each list as the behavioral owner. This is the selected approach.

Create a focused artwork component that resolves and displays a track cover, plus a focused title-cell component that composes the cover, title line, optional badges, and artist line. The table-based Online List, My Lists, and Recent Play rows use the shared title cell while retaining their existing column markup. The narrower Play Queue uses the shared artwork component and its own two-line grid so its current/later/pending grouping remains intact.

The shared title cell accepts slots for existing quality/source badges. It does not know about downloads, list selection, playback, pagination, or source-specific actions.

## Artwork Data Flow

1. Use `musicInfo.meta.picUrl` immediately when it is a usable URL.
2. When the stored URL is absent, resolve the cover only after the artwork component is mounted, which naturally limits work to virtualized or currently rendered rows.
3. Resolve missing online, local, and WebDAV artwork through the existing `getPicPath` music API rather than adding source-specific requests to UI components.
4. Deduplicate concurrent and repeated work with a module-level cache keyed by the stable source and track identity.
5. Cache successful URLs and failed lookups for the renderer session. A failed lookup stays on the placeholder and does not retry on every scroll.
6. Ignore stale asynchronous results if a virtualized component instance is reused for another track or unmounted before resolution finishes.

Artwork lookup is display-only. It must not alter playlist ordering, trigger playback, persist unrelated list changes, or replace the track's playback source.

## Table Layout

The title column absorbs the width released by removing the artist column. Existing fixed percentages for album, time, action, source, and index columns remain unchanged unless their totals require the title column to stay above its minimum usable width.

Both action-button modes remain supported. Rows with action buttons keep the current action column; rows with action buttons disabled gain additional title width. Recent Play retains its source column. The table header stays compact and aligned with the title text, while artwork starts within the title cell below it.

## Play Queue Layout

The queue remains a narrow panel rather than becoming a table. Each queue row gains a `44px` cover between its current/index marker and the existing name/artist text. Current, Play Later, and Pending sections keep their labels, ordering, click behavior, and current-row treatment. The panel does not gain album, duration, action, or favorite columns.

## Error And Loading States

- Reserve the artwork box before image resolution so rows never shift horizontally.
- Use the same neutral music placeholder for missing, loading, and failed artwork, with a subtle loading treatment that does not animate once resolution has failed.
- Handle native image errors by replacing the failed URL with the placeholder and recording the failure in the session cache.
- Do not surface per-row notifications for artwork failures.
- Keep failed artwork visually subordinate to song metadata and compatible with every existing theme.

## Localization

Add a dedicated title-column translation key instead of changing the existing song-name key globally. Provide at least:

- Simplified Chinese: `标题`;
- Traditional Chinese: `標題`; and
- English: `Title`.

Only the approved primary table surfaces use this new label. Existing contexts that truly mean only the song name retain their current translation.

## Testing

Follow test-driven development with focused renderer source tests before production edits:

- prove all approved table surfaces use the title column and no longer render a separate artist column;
- prove excluded auxiliary and download views are not pulled into the shared row change;
- prove the play queue retains its three groups while rendering artwork;
- unit-test artwork resolution for immediate URLs, deduplicated missing-cover lookup, cached failures, image errors, and stale async results;
- verify base dimensions and scalable row sizing are wired consistently across table and queue variants; and
- verify existing columns and row event handlers remain present.

After focused tests pass, run lint on touched files and a production renderer build. Start the application and visually inspect representative online, local, WebDAV, search, leaderboard, queue, and recent-play states at normal and narrow window widths, including missing and broken artwork.

## Non-Goals

- No new favorite/like column or favorite behavior.
- No new membership, preview, or audio-quality entitlement badges.
- No changes to playlist headers, pagination, list sorting, playback resolution, or download behavior.
- No redesign of auxiliary modal lists or download-task rows.
- No database migration or persistent artwork-cache schema.
