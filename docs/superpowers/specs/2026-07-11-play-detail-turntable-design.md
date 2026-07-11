# Play Detail Turntable Redesign

## Goal

Redesign the song playback detail page around the supplied turntable reference while preserving LX Music's theme system, playback behavior, lyric interactions, comments, queue, party mode, window controls, and keyboard behavior.

The page should feel like a focused desktop listening surface rather than a stretched list view. Album art and lyrics have equal visual importance.

## Design Read

- Product: desktop music player detail view for regular listening and lyric reading.
- Direction: tactile turntable imagery with a quiet, restrained interface.
- Redesign mode: visual and layout overhaul with behavior preservation.
- Design variance: 5/10. The turntable creates asymmetry, while controls stay predictable.
- Motion intensity: 4/10. Rotation communicates playback state; other motion stays subtle.
- Visual density: 4/10. Essential information remains visible without crowding the listening view.

## Layout

The page uses three stable regions:

1. A compact top bar with the existing close/back action and window controls.
2. A flexible main stage with a turntable on the left and track information plus lyrics on the right.
3. A fixed bottom control deck with progress on its top edge, secondary actions on the left, primary playback controls in the center, and utility actions on the right.

The main stage remains visually balanced at normal desktop widths. The turntable occupies 40 percent of the stage, and lyrics occupy the remaining 60 percent. The record and lyric column share the same vertical center so the page reads as one composition.

## Turntable

- Build the record with CSS and the current album cover. Do not add a fixed bitmap turntable skin.
- Use concentric groove rings, a subtle outer shadow, and a small center spindle to make the record legible across light and dark themes.
- Place the album cover inside the record label area using the current `musicInfo.pic` source.
- Include a restrained tonearm silhouette above the record as a decorative, non-interactive element.
- Rotate the record only while `isPlay` is true.
- Pause the CSS animation rather than removing it so the record resumes from the same angle.
- Use a slow linear rotation of 18 seconds per revolution.
- Disable rotation under `prefers-reduced-motion: reduce`; playback state remains visible through the play/pause button.
- When cover art is missing, show the existing music fallback treatment inside the label area. The record itself remains visible.

## Track And Lyrics

- Show song name as the primary heading, followed by singer and album metadata.
- Keep long values readable with ellipsis at the compact metadata level and wrapping where the current expanded description already allows it.
- Keep the existing lyric renderer, drag and touch scrolling, active-line zoom, selection mode, context menu, font size, alignment, offset adjustment, and progress-seek behavior.
- Increase whitespace around the lyric viewport and strengthen the current line without lowering inactive lyric contrast below a readable level.
- Do not add the reference image's encyclopedia or recommendation tabs. LX Music does not currently provide those features in this surface.

## Bottom Control Deck

- Move the progress bar to the top edge of the deck so playback position is readable across the full window width.
- Preserve the existing current time, total time, playback status, previous, play/pause, next, queue, party mode, favorite/add, lyric, visualization, playback mode, volume, and related actions.
- Keep primary transport controls centered even when the left and right action groups have different widths.
- Use icon-only controls with existing accessible labels. Party mode may retain a short text label because the room code is meaningful state.
- Use theme variables for background, text, selected state, and hover state. Do not introduce a fixed teal palette from the reference image.

## Comments And Fullscreen

- Opening comments keeps the turntable visible but reduces its size and gives the comment panel a stable right-side column.
- Lyrics remain available while comments are open, with a smaller font scale matching the current behavior.
- Fullscreen enlarges the record and lyrics proportionally without changing the control layout.
- Existing mouse auto-hide behavior remains unchanged in fullscreen.

## Responsive Behavior

- At wide widths, use the full turntable and two-column main stage.
- At medium widths, reduce record size, metadata spacing, and secondary control gaps before changing the structure.
- At narrow supported window widths, keep a compact two-column stage instead of stacking the record above lyrics; this preserves lyric height in a desktop application.
- Hide the decorative tonearm first when vertical or horizontal space is constrained.
- Long song, singer, album, status, and party-room text must not overlap playback controls.

## State And Data Flow

No new store or IPC contract is required.

- `musicInfo` supplies title, singer, album, cover, and lyric information.
- `isPlay` controls record animation state and the existing play/pause icon.
- `isShowPlayComment` controls the existing comment layout transition.
- `isFullscreen` controls fullscreen sizing and existing mouse auto-hide behavior.
- Existing player actions continue to handle progress, navigation, playback modes, queue, and party mode.

## Accessibility

- Preserve every existing `aria-label` and button semantic.
- Maintain visible keyboard focus states against both light and dark themes.
- Decorative turntable pieces use no interactive semantics and do not enter the tab order.
- Record rotation respects reduced-motion preferences.
- Text and controls meet their existing theme contrast contracts; inactive lyrics remain readable.

## Verification

- Run the renderer build and focused lint checks for all edited Vue files.
- Verify record rotation while playing, pause-at-angle behavior, and resume behavior.
- Verify cover changes when tracks change and the missing-cover fallback.
- Verify lyric scrolling, selection mode, context menu, font sizing, alignment, and progress seek.
- Verify comments, queue, party modal, fullscreen, window controls, and auto-hide behavior.
- Inspect normal, comment-open, fullscreen, and narrow-window states in both light and dark themes.
- Confirm no control or metadata overlaps at supported window sizes.

## Non-Goals

- No encyclopedia, similar-song, or recommendation tabs.
- No new playback, queue, party, or comment behavior.
- No route, navigation label, setting key, IPC, or analytics contract changes.
- No fixed reference-image color palette and no generated turntable asset.
