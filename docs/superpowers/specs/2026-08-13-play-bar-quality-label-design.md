# Play Bar Quality Label Design

## Goal

Show the quality reported for the active audio resource to the right of the song name in the bottom play bar.

The label represents the resource that passed media validation. It does not represent the preferred quality setting or a quality inferred from a URL, file extension, or failed candidate.

## Confirmed Behavior

The play bar shows the source response's original `type` value when that value matches an `LX.Quality` protocol value: `128k`, `192k`, `320k`, `flac`, `flac24bit`, `ape`, or `wav`.

The renderer preserves the reported spelling and case. It does not convert the value to a display name such as `320K`, `FLAC`, `24BIT FLAC`, or a translated description. A missing or invalid `type` produces no label.

Online playback publishes the label after the active candidate fires `canplay` and the coordinator accepts it. Changing tracks, starting a new resolution, stopping playback, or exhausting the active resolution clears the previous label. A failed candidate cannot publish its quality while the coordinator tries another source.

A completed download uses `metadata.quality`, which records the quality selected for that downloaded resource. Direct local files and WebDAV resources have no trusted quality field and show no label.

## Quality Contracts

Playback resolution keeps two quality concepts:

- `resolvedQuality` controls candidate selection, cache keys, cache lookup order, and playback diagnostics. When a source omits a valid `type`, the adapter may retain the requested quality as `resolvedQuality` to preserve current playback behavior.
- `reportedQuality` is optional and controls the label. The adapter sets it only when the source response includes a valid `type`.

The source adapter validates built-in and custom-source responses against the existing `LX.Quality` values. It returns the accepted raw value as both `resolvedQuality` and `reportedQuality`. For a missing or invalid value, it returns the requested quality as `resolvedQuality` and omits `reportedQuality`.

Playback candidates and validated resources carry optional `reportedQuality`. Direct downloaded resources also carry their trusted download quality. Direct local and WebDAV resources omit it.

## Player State

Add a session-scoped reactive `currentPlaybackQuality` value to the player store. Do not add quality to a song, playlist row, playback-history entry, or persisted play position. One song can resolve to different resources across playback sessions.

The playback action controller clears `currentPlaybackQuality` before binding a new foreground resolution and when it cancels or stops the current resource. The media-event handler sets the value only after it accepts the current resource on `canplay`. It reads `reportedQuality` from the accepted resource and leaves the value empty when the resource does not carry one.

Resource identity checks remain authoritative. Stale media events cannot update the label after a track or candidate change.

## Cache Schema And Data Flow

Extend each music URL cache record with a nullable `reported_quality` field. The field accepts only the existing quality protocol values. Cache writes store the candidate's optional `reportedQuality` beside the URL. Cache reads return the URL, key quality, and optional reported quality.

The cache key quality remains `resolvedQuality`. The new field does not change authorization, lookup order, expiration, invalidation, pruning, or uniqueness.

Upgrade the cache schema from version 1 to version 2 with an atomic migration. The migration preserves existing music URL rows and copies them with `reported_quality` set to `NULL`; it also preserves the other cache tables. Fresh databases use the version 2 schema. Update the migration ledger, schema checksum, schema contract, and verification fixtures for version 2.

An old cache hit has no trusted reported value and shows no label. A later source response can replace that row with a populated `reported_quality` value. Cache entries created from responses without a valid `type` keep the field null.

## Play Bar Layout

All progress styles render `ModernBar.vue`, so one title-row change covers the full, middle, and mini variants.

Split the current title into two sibling elements inside a flex row:

- the song-name element keeps the existing copy action, consumes the remaining width, and uses ellipsis overflow;
- the quality label has fixed width behavior, does not shrink, and has no click handler.

Use the local playlist source label as the visual reference: theme primary color, approximately `0.8em` text, `0.75` opacity, light inline padding, and no pill background. The quality remains visible at narrow widths while the song name truncates earlier. The label does not change the singer row or play-bar height.

## Error And Transition Behavior

The label stays empty while a new resource resolves and while a candidate waits for media validation. A source error, media error, timeout, cancellation, or stale event cannot leave the failed candidate's quality visible.

If a validated resource fails after commit and playback starts a replacement resolution, the controller clears the label before requesting the replacement. The replacement publishes its reported quality after its own `canplay` event.

Cache persistence failures do not block playback or the in-memory label. They retain the current cache failure reporting behavior.

## Testing

Add focused regression coverage for these contracts:

- built-in and custom sources preserve a valid raw `type` as `reportedQuality`;
- missing and invalid `type` values retain the requested `resolvedQuality` but omit `reportedQuality`;
- a candidate cannot publish quality before `canplay`;
- acceptance publishes the current candidate's value, while rejection, fallback, cancellation, stop, and track replacement clear or replace it without stale updates;
- downloaded resources publish `metadata.quality`, while direct local and WebDAV resources publish no value;
- cache writes and reads round-trip nullable `reported_quality` without changing quality lookup order;
- the version 1 to version 2 migration preserves old URLs and assigns null reported quality to old rows;
- fresh version 2 databases and migrated databases pass the strict cache schema contract;
- the play bar renders each valid raw value, hides an empty value, keeps the label outside the copy target, and truncates the title before the label;
- full, middle, and mini progress styles continue to share the same play-bar implementation.

Run the focused playback source, media validation, cache, and play-bar tests. Lint every touched source file and build the renderer and main bundles. Inspect the generated application at desktop and narrow window widths to confirm that the title and label do not overlap.

## Non-Goals

- Detecting bitrate, codec, bit depth, or sample rate from audio content.
- Inferring quality from a file extension or URL.
- Showing the preferred quality setting when the source omits `type`.
- Adding a quality selector, tooltip, dialog, or click action to the label.
- Showing labels for local or WebDAV files without trusted metadata.
- Writing playback-session quality into song or playlist records.
