# My List Detail Unified Scroll Design

## Goal

Place the local playlist profile, song column headings, and virtualized song rows in one vertical scroll container on the My Lists detail page shown in the reference screenshot.

When the user scrolls down, the artwork, playlist name, metadata, description, Play All action, and song column headings leave the viewport in document order. None of these elements remains fixed or sticky. The My Lists sidebar and the rest of the application layout remain unchanged.

## Scope Correction

The reference screenshot is the local My Lists detail view implemented by `src/renderer/views/List/MusicList/index.vue`. It is not the online playlist detail route implemented by `src/renderer/views/songList/Detail/index.vue`.

The existing online playlist unified-scroll behavior remains in place. This change applies the requested behavior to the local My Lists detail view without changing unrelated list pages.

## Confirmed Behavior

The local playlist scroll order is:

1. playlist artwork and profile information;
2. the Play All action;
3. song column headings;
4. virtualized song rows; and
5. the empty-list message when the playlist has no songs.

The existing song-list viewport supplies the only scrollbar for these elements. Scrolling must not introduce a page-level or nested second scrollbar.

The profile and column headings scroll completely out of view. The current locate-song control remains overlaid in its existing bottom-right position.

## Component Design

Use the existing optional `header` and `footer` slots on `BaseVirtualizedList`. No new scrolling primitive is required.

Update `src/renderer/views/List/MusicList/index.vue` to render one `BaseVirtualizedList` for both action-button modes. The current duplicated branches differ only in column widths and the optional action cell, so the unified template preserves those differences with conditional widths and conditional action markup.

Render the existing playlist profile section and song column heading table in the virtualized list's `header` slot. Keep the markup, actions, translations, CSS module classes, profile scaling variables, and edit behavior in the current component so the change does not redesign or re-own the profile UI.

Render song rows through the default slot. Preserve the current row classes, playback state, selection, source labels, context menus, downloads, and click handlers. Render the current no-item message through the footer slot when the list is empty so the profile remains visible above it.

## Scroll Semantics

`BaseVirtualizedList` already measures optional header height, subtracts it when calculating visible row indexes, and adds it for index-based scrolling. The local list therefore inherits correct row virtualization without a second offset implementation.

Raw pixel positions saved after this change include the profile and column heading height because `getScrollTop()` reports the container's absolute scroll position. Restoring a saved position continues to call `scrollTo()` with that same absolute value.

Locate-current behavior continues to call `scrollToIndex()`. The base list adds the measured header height before applying the existing local-list offset, so locating a song still positions the requested row in the visible region.

## Empty And Loading States

Always mount the virtualized list, including when the playlist is empty. An empty list has a zero-height row content region followed by a minimum-height empty message in the footer. The profile and column headings remain available above that message and use the same scrollbar when the combined content exceeds the viewport.

Playlist data flow and loading behavior remain unchanged. The header uses the same reactive profile values as before, so cover, title, description, timestamps, and edit availability update without remounting a separate scroll surface.

## Compatibility

The existing online playlist unified-scroll implementation remains unchanged. Search results, leaderboards, recent play, play queue, and other virtualized-list consumers do not receive new slots or behavior.

Both local-list modes retain their current column contracts:

- with action buttons: album 22%, time 9%, action 16%;
- without action buttons: album 28%, time 10%, no action column.

The header slot must render exactly once in either mode. The playlist profile editing modal, search overlay, sort and source modals, add/download dialogs, and context menu remain outside the scroll content as they are today.

## Testing

Extend the existing My Lists renderer harness before production changes. The regression test must fail against the current structure because the profile and column headings precede the virtualized list rather than being children of it.

Cover these contracts:

- the playlist profile and column headings render inside the virtualized-list header before the first row;
- the header renders once with and without action buttons;
- both action-button modes preserve current row cells, widths, events, and actions;
- an empty playlist keeps the profile and column headings above the empty message inside the same virtualized list;
- the local list still exposes scroll and context-menu handlers; and
- existing virtualized-list header offset tests remain green.

After the focused tests pass, run ESLint on touched source files and build the renderer. Rebuild the Windows unpacked directory and inspect a long local playlist in the generated application. Verify that one scrollbar moves the profile, column headings, and rows together, with no gaps, overlap, sticky content, or row-index jumps.

## Non-Goals

- Redesigning the local playlist profile or song rows.
- Changing the My Lists sidebar, playlist grouping, profile editing, playback, search, sorting, downloads, or context menus.
- Changing online playlist behavior beyond retaining the already implemented unified scroll.
- Removing virtualization or replacing it with whole-page rendering.
- Adding sticky metadata or sticky song column headings.
