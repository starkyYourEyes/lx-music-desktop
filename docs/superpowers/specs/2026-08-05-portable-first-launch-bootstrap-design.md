# Portable First-Launch Bootstrap Design

## Context

The Windows portable artifact is an electron-builder NSIS wrapper. The wrapper
extracts the Electron application into a temporary directory, sets
`PORTABLE_EXECUTABLE_DIR` to the directory containing the original portable
executable, and launches the extracted child executable.

The current bootstrap ignores that launcher variable. It derives the portable
root from `app.getPath('exe')` and enables portable mode only when a sibling
`portable` directory already exists. On a true first launch, that checks the
temporary extraction directory, returns installed mode, and opens the installed
profile instead of creating launcher-local storage.

## Goals

- A single-file Windows portable artifact must enter portable mode on its first
  launch even when no `portable` directory exists.
- The first mutation must be the guarded creation of exactly
  `<PORTABLE_EXECUTABLE_DIR>/portable`.
- Invalid portable launcher input must stop startup before installed migration,
  Electron path publication, database open, session creation, or window creation.
- Existing unpacked/green behavior remains compatible: without the launcher
  variable, an already-present sibling `portable` directory selects portable
  mode, while an absent sibling selects installed mode.
- A fresh portable database reaches schema 7, creates no backup artifact or
  `backups` directory, and stores cache data only under `portable/cache`.
- The production main-process bundle must retain Node's runtime environment so
  `PORTABLE_EXECUTABLE_DIR` reaches bootstrap unchanged while `NODE_ENV` remains
  compiled as `production`.
- Closing the main window with the default tray-disabled setting must keep the
  renderer alive until shutdown flushers complete and the run-state is clean.

## Non-Goals

- Changing electron-builder's NSIS template or portable artifact format.
- Changing renderer or lyric-renderer environment substitution.
- Treating launcher environment variables as cryptographic proof of provenance.
- Changing installed-profile paths, legacy portable migration semantics, or the
  existing storage directory layout.
- Restoring or deleting the installed profile touched by the diagnostic launch.

## Design

### Pure compatibility detector

Keep `getPortableUserDataPaths` as the existing side-effect-free compatibility
detector. It continues to return portable paths only when Windows is active and
`<dirname(executablePath)>/portable` already exists.

### Guarded launcher resolver

Add an explicitly side-effecting API to `legacyUserData.js`:

```ts
export interface PreparePortableUserDataPathsOptions {
  platform: NodeJS.Platform
  executablePath: string
  portableExecutableDir?: string
  fsApi?: typeof fs
}

export function preparePortableUserDataPaths(
  options: PreparePortableUserDataPathsOptions,
): { appDataPath: string, userDataPath: string } | null
```

Behavior:

1. Non-Windows platforms return `null` without filesystem mutation.
2. When `portableExecutableDir` is absent, call the compatibility detector. A
   `null` result remains installed mode. A portable result is validated with a
   direct-directory guard before it is returned.
3. When `portableExecutableDir` is present, it is an asserted portable launch,
   not a fallback hint. Require a non-empty absolute Windows path and normalize
   it with `path.win32`.
4. Validate the launcher directory and its complete ancestry using
   `validateDirectDirectory` with the injected filesystem and `path.win32`.
5. Create or validate exactly the direct child named `portable` with
   `createDirectChildDirectory(..., { mode: 0o700 })`.
6. Revalidate and close both guards. Return the guarded child's normalized path
   and its direct `userData` child.
7. Any malformed value, link/reparse point, identity change, invalid existing
   child, or creation failure throws. It must never fall back to installed mode.

The direct-directory primitive already holds descriptors, verifies ancestry and
real paths, and revalidates parent and child identities around creation. The
portable migration and storage initialization reopen and revalidate their own
roots after this bounded handoff.

### Bootstrap ordering

`bootstrap.ts` passes `runtime.env.PORTABLE_EXECUTABLE_DIR` to
`preparePortableUserDataPaths` immediately after reading `app.getPath('exe')`.
It catches any resolver failure, logs a fixed portable-root validation message,
calls `app.exit(1)`, and returns before reading `appData` or `home`.

For a valid portable launch, the existing order remains:

1. Resolve and guard-create `portable`.
2. Resolve any acknowledged legacy-source retirement.
3. Prepare or resume legacy portable-profile migration.
4. Initialize `profile`, `runtime`, `session-data`, `temp`, and the run-temp
   reservation.
5. Publish Electron `userData` and `sessionData` paths.
6. Start storage coordination, fresh database bootstrap, cache ownership, and
   renderer/window creation.

### Production bundle environment boundary

The main-process production webpack configuration must define only
`process.env.NODE_ENV`, not the complete `process.env` object. Replacing the
complete object erases environment variables supplied by the NSIS parent before
the extracted Electron child starts. The production bundle must therefore keep
bootstrap's default runtime as the real `process.env` object while folding
`process.env.NODE_ENV` checks to the literal `production` value.

This change is limited to `build-config/main/webpack.config.prod.js`. It does
not expose new data to a sandboxed renderer: the target remains Electron's main
process, where Node already provides the runtime environment. It also avoids a
bootstrap-only bypass that would leave other main-process runtime variables
subject to the same compile-time erasure.

### Graceful default-window close

The default setting disables the tray, so the title-bar Close button is the
normal user exit path. The main-window `close` handler must intercept that first
close while `global.lx.isSkipTrayQuit` is false: prevent destruction, hide the
window to prevent repeated input, and call `app.quit()`. The existing
`before-quit` coordinator can then request playback flushing while the renderer
and its IPC bridge are still alive, flush stores, close the database, mark the
run clean, and invoke the final `app.quit()`.

When tray support is enabled, Close continues to hide the window without
quitting. When `global.lx.isSkipTrayQuit` is already true during the final quit,
the handler permits the window to close and preserves the existing
`main_window_close` notifications. The renderer-unavailable flusher failure
must not be downgraded to success because doing so could mark an unflushed run
clean.

## Failure Handling

- A present but invalid launcher variable is fatal and cannot select installed
  storage.
- A missing launcher directory, linked ancestry, replaced directory, or invalid
  `portable` child is fatal before any application data path is published.
- Existing portable migration failures retain their journals, receipts, stages,
  sources, and backups exactly as before.
- Fresh database startup retains the existing rule that `backups` is not created.
- A production bundle that no longer exposes the live runtime environment is a
  build failure and must be rejected before packaging.
- A title-bar close must never destroy the renderer before the shutdown
  coordinator has had the opportunity to flush it. A genuine flusher failure
  still leaves the run-state unclean.

## Verification

Automated RED/GREEN coverage must prove:

- An absolute launcher directory with no `portable` child creates the direct
  child and selects it even when the extracted executable lives elsewhere.
- The installed AppData migration branch is not called for a valid launcher
  assertion.
- Relative, drive-relative, empty, invalid, linked, and replaced launcher roots
  fail before application loading or `app.setPath`.
- The existing adjacent-directory compatibility behavior remains unchanged.
- Bootstrap creates `profile`, `runtime`, `runtime/session-data`, and `temp`, but
  not `cache` or `backups`, before application storage coordination.
- The compiled main bundle retains `process.env` for bootstrap's runtime input,
  still embeds the production `NODE_ENV` branch, and does not substitute an
  object containing only `NODE_ENV`.
- With tray disabled, the first main-window close is prevented, the window is
  hidden, and `app.quit()` is requested while the renderer remains alive; the
  final quit is allowed to close the window.

Release verification must then:

1. Run the focused portable/bootstrap tests, storage suites, Electron storage
   suites, lint, full build, and main-bundle test.
2. Build the Windows x64 portable artifact.
3. Confirm the launcher directory initially has no `portable` child.
4. Snapshot installed-profile sentinel metadata, launch the real artifact, and
   prove the sentinels did not change.
5. Confirm the portable profile reaches schema 7, `cache/cache.db` exists,
   `data.json` and `backups` are absent, and the main window has no startup error.
6. Close through the default title-bar Close button, confirm the run-state is
   clean, relaunch the same artifact, and prove the same database/cache are
   reused without creating backups.
7. Leave the verified portable application running for user testing.
