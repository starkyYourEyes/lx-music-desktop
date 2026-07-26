# Play Detail Vinyl And Progress Refinement

## Goal

Refine the playback detail page so the vinyl matches the supplied reference more closely and the bottom bar presents track identity, favorite state, and playback progress more clearly.

This change builds on the existing play-detail turntable and compact footer. It does not redesign the page or change playback behavior.

## Approved Visual Direction

- Use option A from the approved comparison: the center album label occupies approximately 62 percent of the record diameter.
- Keep the current record deck size, groove treatment, spindle, tonearm placement, playback-only rotation, and reduced-motion behavior.
- Keep the existing centered title, singer, and album metadata above the lyrics.
- In the footer, place the favorite button immediately to the right of the song-name and singer block.
- Do not show album artwork in the footer.

## Vinyl Proportion

`PlayDetail/Turntable.vue` currently uses a 27 percent inset for the center label, producing a label diameter of approximately 46 percent. Change the inset to 19 percent, producing the approved diameter of approximately 62 percent.

Only the label proportion changes. The outer record remains 94 percent of the deck, so the black vinyl ring becomes narrower without changing the overall composition or tonearm geometry.

## Footer Layout

Keep the existing three-column footer structure so the primary transport controls remain centered independently of the side content.

The left column becomes a compact track section matching the homepage modern play bar:

- Show the current song name on the first line.
- Show the current singer on the second line.
- Truncate long values with an ellipsis.
- Place the favorite button directly to the right of the two-line text block.
- Omit the album-cover element entirely.
- Use the same empty-state fallbacks as the homepage play bar when track metadata is unavailable.

Reuse `PlayBar/ControlBtns.vue` with favorite enabled and its unrelated controls disabled. This preserves its current favorite-state lookup, optimistic update, rollback on failure, love-list synchronization, and local-music metadata handling.

Keep `PlayDetail/components/ControlBtns.vue` in the right column for the existing desktop lyric, visualization, lyric selection, comments, sound effect, playback rate, volume, play mode, and add-to-list controls. Party mode remains unchanged. The favorite control is not duplicated in the right column.

## Progress Indicator And Hover Time

Keep the existing full-width progress bar and seek behavior. Add detail-only presentation around the shared progress component instead of modifying `common/ProgressBar.vue`.

- Render a small progress marker at the current playback fraction.
- Bind marker position to the existing reactive `progress` value from `usePlayProgress`.
- Do not create a separate timer. The player's existing `timeupdate` path already updates current time and progress while playing.
- Hide the time tooltip by default.
- While the pointer is anywhere over the progress track, show `current time / total duration` above the current playback marker.
- Anchor the marker to the exact playback position. Clamp only the tooltip near the left and right window edges so its text cannot overflow.
- Make the marker and tooltip ignore pointer events so dragging and clicking the existing seek mask continue to work.

Paused playback keeps the marker and formatted time at the paused position. Track changes, stopped playback, and unavailable duration use the existing zero progress and `00:00` formatting.

## Data Flow And Failure Behavior

No new store, event, IPC, or timer is required.

- `musicInfo` supplies the footer song name and singer.
- `playMusicInfo` continues to drive whether the favorite button is enabled and which list item is updated.
- `playProgress.progress`, `nowPlayTimeStr`, and `maxPlayTimeStr` drive the marker and tooltip.
- Existing player events continue to handle seeking, loading, stopping, and track changes.

Favorite failures retain the homepage control's optimistic rollback and warning behavior. Progress display has no asynchronous failure path of its own; invalid or missing duration remains at zero through the existing player store.

## Responsive And Accessibility Behavior

- Preserve the footer's centered transport controls at supported widths.
- Give the track text a bounded flexible width so long metadata cannot push the favorite button into the transport controls.
- Keep the favorite button visible at normal desktop widths and use the existing disabled state when no playable track is loaded.
- Preserve existing button semantics, translated accessible labels, focus states, and theme variables.
- The progress marker is decorative. The existing progress mask remains the sole seek interaction surface.
- The tooltip appears on pointer hover only and does not replace existing keyboard or playback controls.

## Verification

- Add or update focused structural coverage for the 19 percent label inset, footer track information, favorite-only control configuration, marker binding, tooltip content, and hover visibility.
- Run focused lint checks for every modified Vue file.
- Run the relevant renderer unit tests.
- Run the renderer production build.
- Inspect the detail page while playing, paused, seeking, switching tracks, and stopped.
- Confirm favorite toggling and rollback behavior through the reused homepage control.
- Inspect normal and narrow supported widths, including very long song and singer names.
- Confirm the tooltip stays visible at zero progress and near track completion without blocking seeking.
- Rebuild and smoke-test the Windows x64 portable executable after the UI change passes verification.

## Non-Goals

- Do not alter the homepage play bar.
- Do not modify the shared progress component API or behavior.
- Do not change footer height, transport controls, right-side detail controls, queue, party mode, lyrics, comments, fullscreen behavior, or player timing cadence.
- Do not add hover-position time preview; the tooltip represents the current playback position only.
- Do not add a second favorite implementation or new list-store logic.
