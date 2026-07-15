# Tray Menu Latency Optimization Design

## Goal

Reduce the delay between a Windows tray right-click and the custom tray menu becoming visible while preserving its current controls and appearance.

## Root Cause

The Windows tray menu uses a frameless `BrowserWindow` because Electron's native `Menu` cannot provide the current volume slider and free-form control layout. `showTrayMenuWindow` currently creates that window on the first right-click, reloads a complete `data:` HTML document on every right-click, and waits for `loadURL` to finish before calling `show`. State refreshes while the menu is visible also reload the document.

Window creation and renderer navigation therefore run on the click-to-display path. Repeated navigation also rebuilds the DOM and its event listeners when only a few values changed.

## Window Lifecycle

When Windows tray support starts, the main process will create the hidden menu window and load its HTML once. The window will remain hidden until the user opens the menu. Disabling or destroying the tray will destroy the menu window as it does now.

The menu window will track whether its document has finished loading. A right-click after loading will set the bounds, send the latest state, and show the existing window without navigation. If the user right-clicks during the initial preload, the code will remember that request and show the window when loading finishes.

## State Updates

The main process will build a serializable tray-menu state object containing the title, playback state, collection state, volume, mute state, and desktop lyric state. It will send that object to the menu renderer through Electron IPC.

The menu HTML will register one IPC listener during its initial load. That listener will update existing text, attributes, SVG contents, and slider styles in place. Player and setting events will send state updates even while the window is hidden, so the next opening starts with current values. The right-click handler will send one final state snapshot before showing the menu.

Menu actions will continue to travel from the renderer to the main process through the existing `tray-menu-action` channel. Action behavior and menu-closing rules remain unchanged.

## Failure And Race Handling

The preload promise will handle a destroyed window without showing or focusing it. A failed load will clear the cached loading state so the next right-click can recreate and load the menu window. Repeated right-clicks during one load will share the same load operation rather than starting concurrent navigations.

State delivery will check that the window and its web contents still exist. Closing or disabling the tray during preload will leave no pending callback that can reopen the menu.

## Scope

The change applies only to the custom Windows tray menu in `src/main/modules/tray.ts`. Native tray menus on macOS and Linux remain unchanged. The menu layout, labels, controls, position calculation, and action semantics remain unchanged.

## Verification

- Add a focused regression script that fails while the right-click and refresh paths call `loadURL`.
- Require Windows tray creation to preload the hidden menu window.
- Require state refreshes to use IPC without renderer navigation.
- Run the regression script, focused ESLint, TypeScript checks through the main-process production build, and the existing project build.
- Smoke-test repeated Windows tray right-clicks and confirm that playback, collection, mute, volume, and desktop lyric state stay current.
