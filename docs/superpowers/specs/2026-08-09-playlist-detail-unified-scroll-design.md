# Playlist Detail Unified Scroll Design

## Goal

Place the playlist artwork, name, description, actions, song column headings, and song rows in one vertical scroll container on the playlist detail page.

When the user scrolls down, the playlist information and the column headings scroll out of the viewport in document order. Neither section remains fixed or sticky. The playlist sidebar and the rest of the application layout are unchanged.

## Confirmed Behavior

The unified scroll order is:

1. playlist artwork and metadata;
2. playlist actions;
3. song column headings;
4. virtualized song rows; and
5. pagination.

The existing song-list viewport supplies the only scrollbar for these elements. Scrolling must not introduce a second nested scrollbar.

Changing pages or loading another playlist resets this container to its absolute top, so the playlist information is visible again. Empty and loading states retain the playlist information above their current message.

## Component Design

Extend `BaseVirtualizedList` with an optional header slot rendered before its virtualized content. Measure the rendered header height and treat that height as the origin offset of the virtual rows.

Virtual-window calculations subtract the header height from the container's `scrollTop` before calculating visible song indexes. Index-based scrolling adds the header height when positioning a song row. Raw `scrollTo(0)` continues to mean the absolute top of the entire container, including the header.

Update `MaterialOnlineList` to opt into this behavior only when its caller provides a scrollable header. In that mode it places the caller-provided content and its song column headings in the virtualized-list header slot. Without that slot, it retains the current structure and scrolling behavior.

The playlist detail view moves its existing `songListHeader` markup into the new `MaterialOnlineList` header slot. Its data flow, actions, routing, selection, menus, playback, downloads, and pagination remain unchanged.

## Compatibility

Search results, leaderboards, local music, and other `MaterialOnlineList` consumers do not provide the new header slot. Their column headings therefore remain outside the virtualized scroll area as they are today.

The base virtualized list must behave identically when the optional header is absent or measures zero pixels. Existing callers of `scrollTo`, `scrollToIndex`, and `getScrollTop` retain their current semantics.

Header height is measured from rendered layout rather than duplicated as a CSS or JavaScript constant. Recalculate it after mount and resize so UI scale changes do not desynchronize virtual row placement.

## Failure And Edge Cases

Clamp the row-relative scroll position to zero while the viewport is still within the header. This keeps the first rows rendered before they enter view and prevents negative virtual indexes.

If the list is shorter than the viewport, the header, rows, and pagination remain in normal order without stretching the header. Long playlist names and descriptions keep the existing ellipsis behavior and fixed header dimensions.

When there are no songs, the empty-state content must use the remaining visible region without covering the playlist header or column headings.

## Testing

Add a focused regression test before production changes. It must fail against the current structure and cover these contracts:

- the playlist detail header is supplied to `MaterialOnlineList` as scrollable content;
- the song column headings join that same scrolling header only in opt-in mode;
- virtual visible-index calculations account for the measured header height;
- scrolling to a song index includes the header offset;
- scrolling to absolute top still returns to the playlist information; and
- callers without a header retain a zero offset.

Run the focused regression test, lint every touched source file, and build the renderer. Then inspect the playlist detail page with a long list and verify that one scrollbar moves the playlist information, column headings, rows, and pagination together without gaps or overlapping content.

## Non-Goals

- Sticky playlist metadata or sticky song column headings.
- Visual redesign of the playlist header or song rows.
- Changes to playlist loading, playback, collection, download, pagination, or routing behavior.
- Changes to scrolling behavior on other online-list pages.
- Replacing or disabling song-row virtualization.
