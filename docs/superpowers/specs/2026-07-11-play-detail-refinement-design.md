# Play Detail Refinement Design

## Goal

Refine the recently rebuilt play detail page so the turntable reads as a working record player, the track information aligns cleanly with the lyric panel, and the bottom controls use less vertical space.

## Scope

The change is limited to the existing play detail components:

- `Turntable.vue` for tonearm placement and playback-state motion.
- `index.vue` for centered track title and metadata.
- `PlayBar.vue` for a more compact bottom control bar.

Lyrics, comments, queue, party mode, fullscreen behavior, and player data flow remain unchanged.

## Turntable

The tonearm will rotate around its existing upper-left pivot. Its resting state stays above the record. While `isPlay` is true, a playback class rotates the arm clockwise so the cartridge rests over the outer groove, similar to the supplied reference. Pausing removes the playback class and returns the arm smoothly to its resting position.

The animation uses a short CSS transition and does not affect record rotation. Reduced-motion users receive the final state without an animated transition. The arm remains decorative and non-interactive.

## Track Information Alignment

The title and metadata row will be horizontally centered within the lyric panel. Long values keep their current truncation behavior. Singer and album remain on one row where space permits.

The lyric player's alignment is deliberately untouched. It continues to follow the existing left, center, or right alignment setting selected by the user.

## Compact Play Bar

The footer height will decrease from 92px to 72px. Vertical padding and control sizes will be reduced proportionally, with the primary play button reduced from 48px to 42px. The progress bar remains pinned to the top edge, and all current left, center, and right controls remain available.

Responsive layouts will retain stable grid columns and shrink the same controls consistently at narrower widths.

## Verification

- Add a focused structural check that fails until the tonearm has a playback-state class and the requested layout dimensions and alignment rules are present.
- Run focused ESLint for the three modified Vue files.
- Run the renderer production build.
- Inspect the normal and playing states in the desktop app at the current desktop viewport, including title truncation and control-bar spacing.
- Rebuild and smoke-test the Windows x64 portable executable after visual approval.
