# Adjustable Play Bar Height Design

## Goal

Let users reduce the main window's bottom play bar height without losing the existing layout or playback controls. The setting must apply consistently to the mini, middle, and full-width progress styles.

## User Experience

- Add a "Play bar height" control to Basic Settings near the existing play bar progress style setting.
- Use the settings page's established range-slider, number-input, and `px` unit pattern.
- Allow integer values from `56px` through `74px`, in `1px` steps.
- Keep `74px` as the default so existing users retain the current appearance.
- Apply changes immediately while the user adjusts the value.

## Layout Behavior

- Store the value as `common.playBarHeight`.
- Use the configured value as the height of the shared `ModernBar`, so all three progress styles behave identically.
- Scale the artwork linearly with the bar height: `42px` artwork at a `56px` bar and `54px` artwork at a `74px` bar.
- Derive vertical padding from the remaining space so the artwork stays vertically centered.
- Keep playback and utility button hit areas at their current sizes. At the minimum height, the `42px` artwork and existing controls fit without overlap.
- Do not change the separate desktop lyric window's `@height-player` value.

## Validation And Compatibility

- Normalize settings UI input to an integer in the inclusive `56-74` range before saving.
- Treat missing settings as `74` through the default-setting merge used for older profiles.
- Defensively clamp invalid runtime values before using them in inline CSS variables, preventing malformed imported settings from breaking layout.
- Add Simplified Chinese, Traditional Chinese, and English labels.
- Verify the settings contract/default, input normalization, shared play-bar binding, artwork scaling endpoints, and all three progress-style wrappers.
- Run focused tests, lint for touched source files, and the renderer production build.

## Scope

This change only affects the main window's bottom play bar height, its artwork size, and the corresponding Basic Settings control. It does not add presets, alter button sizes, change progress-bar styles, or modify the play-detail view.
