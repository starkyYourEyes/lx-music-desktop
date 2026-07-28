# QQ Music Login Latency Optimization Design

## Goal

Reduce the time from opening the QQ Music login panel to displaying a usable QR
code while preserving the current browser-backed OAuth completion flow.

Under normal network conditions, the QR code should appear within three seconds.
Creation has one fifteen-second hard deadline. The application must not prewarm
or retain a QQ login window outside an active login attempt.

## Background

The current QQ Music implementation creates an isolated hidden `BrowserWindow`,
loads the complete QQ OAuth parent page, waits for `loadURL` to finish, and only
then starts looking for the QR image in the login iframe. Page loading and QR
discovery each receive a separate fifteen-second timeout.

This makes unrelated page resources part of the critical path and allows a
successful-but-slow attempt to take close to thirty seconds. The isolated login
session also does not apply the proxy configured in LX settings.

Closing the renderer login panel currently stops only the two-second polling
timer. It does not notify the main process, so the hidden browser and its
session can remain alive. Session expiry is checked only when the renderer
polls again, which means closing the panel can prevent expiry cleanup from
running.

The repository previously used direct requests to QQ's QR and OAuth endpoints.
That approach was fast, but it was replaced because the current QQ
`login_jump` flow depends on browser parent-page behavior. This design keeps
the browser-backed flow rather than restoring the undocumented direct OAuth
implementation.

## Confirmed Behavior

- Create the hidden browser only when the user opens the QQ login panel.
- Do not prewarm or reuse a hidden browser between login attempts.
- Display the QR within three seconds under normal network conditions.
- Use one fifteen-second creation deadline rather than two sequential
  fifteen-second phases.
- Apply the current LX proxy configuration before navigating the login session.
- Closing the panel immediately invalidates the QR and destroys the associated
  browser and session.
- Reopening the panel creates a new QR and login session.
- Login success, QR expiry, terminal failure, replacement, timeout, component
  disposal, and application teardown all release the session.
- Keep the current two-second renderer polling cadence after the QR is shown.

## Non-Goals

- Do not restore the fully direct QQ QR/OAuth protocol.
- Do not change QQ account persistence or authenticated recommendation APIs.
- Do not share login cookies or storage with the main application window.
- Do not persist QR sessions across application restarts.
- Do not redesign the login panel.
- Do not guarantee the three-second target on unavailable or severely degraded
  networks; those attempts remain bounded by the fifteen-second deadline.

## Architecture

The flow remains browser-backed but makes QR readiness, rather than full page
load, the end of the creation path:

```text
QQ login panel
-> renderer-generated requestId
-> create-login IPC
-> pending main-process login entry
-> isolated session with LX proxy
-> hidden OAuth BrowserWindow
-> page navigation and QR discovery in parallel
-> QR image returned to renderer
-> existing browser completes OAuth while polling continues
```

The renderer generates a cryptographically random `requestId` before invoking
QR creation. The main process registers that ID as a pending entry before its
first asynchronous operation. This lets a close or unmount request cancel an
attempt even when the QR creation IPC has not returned yet.

The main process allows at most one QQ login attempt. Starting a new attempt
establishes its deadline and registers its pending entry before the handler's
first await. It synchronously removes, aborts, and destroys any previous
attempt before starting new navigation. Clearing the previous isolated
session's storage may finish asynchronously and is not part of the new QR
critical path.

## Browser Session Creation

`createQQMusicBrowserAuthSession` accepts an abort signal and the current proxy
configuration. It creates the existing non-persistent, isolated Electron
session and keeps the current security settings:

- sandbox enabled
- context isolation enabled
- Node integration disabled
- web security enabled
- permission requests denied
- navigation restricted to the existing allowlist
- new windows and webviews denied

The session proxy must be configured and awaited before `loadURL` begins. The
shared proxy helper should support the same fixed-server and direct modes used
by the main window session.

Navigation begins once the session is configured. QR discovery starts
immediately after navigation is initiated and polls for the login frame and QR
image without waiting for `loadURL` to resolve. A successful `loadURL` does not
gate QR readiness. A fatal main-document load failure, cancellation, blocked
terminal navigation, or deadline expiry ends the attempt.

The load promise must always have a rejection handler so returning a QR before
full load completion cannot produce an unhandled rejection. The handler must
distinguish a fatal load failure from Electron `ERR_ABORTED` caused by an
allowed superseding OAuth navigation. An allowed scan-triggered navigation may
abort the still-pending initial `loadURL` and is not terminal by itself.

Before QR capture, an expected allowed-navigation abort leaves discovery
running until QR readiness or the shared deadline. After QR capture, a load
rejection is diagnostic only when it is the expected result of an allowed
navigation. A fatal main-frame failure, blocked navigation, or destroyed
window marks the active session terminal; the next status check returns a
normalized expired result that asks the user to create a new QR.

QR capture continues to use the browser-generated QR shown in the official
login frame. The design does not create a second direct-protocol QR that would
belong to a different QQ login session.

## Unified Deadline

Creation receives one absolute deadline fifteen seconds after the main IPC
handler begins. Request registration, logical teardown of a replaced attempt,
proxy setup, navigation, frame discovery, image readiness, and capture all
consume the same budget.

The implementation passes remaining time or an abort signal through each
stage. It must not restart the full timeout when moving from navigation to QR
discovery.

Logical replacement teardown means removing the old entry, aborting pending
work, and destroying its window before new navigation starts. Because every
attempt uses a unique isolated partition, asynchronous clearing of the old
partition's authentication cache, storage, and cache may complete off the
critical path.

Partition clearing starts immediately after logical teardown and receives its
own five-second settlement budget. If Electron does not settle the clearing
promises within that budget, the service emits a sanitized cleanup-timeout
diagnostic and releases its references; the unique non-persistent partition is
never reused. Application teardown makes the same bounded cleanup attempt
rather than waiting indefinitely.

The five-minute QR session lifetime is separate from the creation deadline. A
main-process expiry timer starts for every registered attempt and is cleared
when the entry is disposed. This timer guarantees cleanup even if the renderer
stops polling or terminates unexpectedly.

## Session State And Cancellation

The login service stores entries by renderer-generated `requestId`. An entry is
either pending or active:

```ts
type LoginEntry =
  | {
      state: 'pending'
      abortController: AbortController
      expiresAt: number
      expiryTimer: ReturnType<typeof setTimeout>
    }
  | {
      state: 'active'
      auth: QQMusicBrowserAuthSession
      consecutiveCheckFailures: number
      expiresAt: number
      expiryTimer: ReturnType<typeof setTimeout>
    }
```

The exact internal representation may differ, but it must preserve these
semantics:

- A pending entry is visible to cancellation before browser creation awaits.
- Activation succeeds only if the same entry is still current.
- A browser session that finishes creation after cancellation is destroyed
  instead of being inserted again.
- `cancelLoginQr(requestId)` is idempotent.
- Disposing an entry removes it from the map before awaiting cleanup.
- Logical cleanup clears the expiry timer, aborts pending work, and destroys
  the window.
- Partition cleanup clears the isolated session's authentication cache,
  storage, and cache under the separate five-second settlement budget.

Cancellation is an expected result. Closing a panel must not show a creation
failure even if the pending IPC promise later rejects. Existing renderer
revision checks continue to discard stale completions.

Cancellation also uses a bounded tombstone map to cover IPC reordering. If
`cancelLoginQr` receives a valid UUID that is not registered yet, it records
the UUID for thirty seconds. A later create request with that UUID consumes the
tombstone and exits as cancelled before allocating a session or window.
Tombstones contain only the UUID and expiry time, are pruned on access, and are
capped at 64 entries by removing the oldest expiry first.

## IPC Contract

Change QQ QR creation to accept the renderer-generated request ID:

```ts
createQQMusicLoginQr(requestId: string): Promise<LX.QQMusic.LoginQr>
```

The returned `LoginQr.key` is the same opaque request ID. Add:

```ts
cancelQQMusicLoginQr(requestId: string): Promise<void>
```

The main handler accepts only a canonical UUID string, matching
`crypto.randomUUID()`. Cancellation of an unknown or already-disposed ID
succeeds without error and records the short-lived cancellation tombstone
described above.

No QR session secrets, cookies, OAuth codes, partition names, or redirect URLs
cross the IPC boundary.

## Renderer Lifecycle

`useQQMusicLoginQr` owns the current request ID independently of the returned QR
record.

Opening the panel generates a new request ID and starts creation. Closing the
panel, refreshing the QR, or unmounting the component invalidates the renderer
revision, clears polling, and sends cancellation for the current request ID.
Refreshing waits for cancellation to be dispatched before beginning the
replacement attempt.

Late creation and check results are ignored unless their request ID and
revision are both current and the panel is still open.

After the QR is displayed, polling remains every two seconds. Success and
expiry stop polling as they do now. The main process owns authoritative
disposal, so renderer cleanup remains safe when a check and close happen
concurrently.

## Check Failure Policy

Login status checks distinguish transient failures from terminal session
failures:

- A transient failure keeps the active browser session and increments
  `consecutiveCheckFailures`.
- A successful check resets the failure count to zero.
- The first two consecutive transient failures cross IPC as safe check errors,
  allowing the renderer's existing two-second retry path to continue.
- Three consecutive transient failures dispose the entry and return an
  `expired` state with a safe message asking the user to create a new QR.
- A destroyed browser, blocked terminal navigation, invalid session, OAuth
  failure, or expiry is terminal, disposes the entry immediately, and returns
  the same normalized `expired` state.

The renderer keeps its existing retry behavior after a transient error. Once
the main process reports a terminal result, polling stops and the panel asks
the user to generate a new QR.

## Diagnostics

Emit sanitized stage diagnostics sufficient to locate future latency:

- session registered
- proxy configured
- navigation started
- login frame found
- QR image ready
- QR captured
- cancelled
- timed out
- terminal failure
- partition cleanup completed
- partition cleanup timed out

Diagnostics may include an elapsed millisecond count and a fixed reason enum.
They must not include cookies, QR content, OAuth codes, complete URLs, URL query
parameters, or upstream response bodies. Normal user cancellation should not
be logged as a warning.

## Error Handling

- User cancellation is silent and always releases resources.
- A creation timeout destroys the entry and shows a retryable QR timeout
  message.
- Page load failure, blocked terminal navigation, or invalid QR capture
  destroys the entry and shows a generic retryable creation error.
- A terminal failure after QR display is normalized to `expired`, allowing the
  existing renderer branch to stop polling without introducing a new public
  login state.
- An abort that races with successful creation still ends as cancellation.
- Replacing a request cannot allow the older browser or result to become
  current again.
- Session cleanup errors are contained after the entry is removed and do not
  block replacement or application shutdown.

Errors crossing IPC remain generic and must not expose upstream URLs or
credentials.

## Module Changes

### `src/main/modules/qqMusic/browserAuth.ts`

- Accept cancellation and proxy inputs.
- Configure the isolated session proxy before navigation.
- Start navigation and QR discovery in parallel.
- Enforce one absolute creation deadline.
- Preserve the browser-backed OAuth callback and security boundaries.
- Produce sanitized timing diagnostics.

### `src/main/modules/qqMusic/login.ts`

- Register pending entries by renderer request ID.
- Activate entries only when still current.
- Add idempotent cancellation and unconditional expiry timers.
- Track consecutive transient check failures.
- Dispose every terminal path through one cleanup function.

### Main And Renderer IPC

- Pass `requestId` into QQ QR creation.
- Add the QQ QR cancellation event and typed wrappers.
- Dispose remaining login entries on owning window or application teardown.

### `src/renderer/views/Recommend/useQQMusicLoginQr.ts`

- Generate and retain the request ID before invoking creation.
- Cancel on close, refresh, and component disposal.
- Keep revision and key checks for stale responses.
- Preserve the existing panel states and polling cadence.

Account persistence, QQ recommendation services, and final authenticated cookie
handling remain unchanged.

## Testing Strategy

Implementation follows the repository's existing focused Node-script test
pattern.

### Browser Auth Tests

- QR discovery begins before `loadURL` resolves.
- A ready QR can return while unrelated page loading remains pending.
- A page load rejection is observed and cannot become unhandled.
- An allowed scan-triggered navigation may produce `ERR_ABORTED` while the
  initial load is pending without terminating a valid login session.
- A fatal main-frame load error remains terminal.
- Proxy configuration completes before navigation starts.
- Direct mode is used when LX proxy settings are disabled.
- Aborting during proxy setup, navigation, frame discovery, or capture destroys
  the browser exactly once.
- All creation stages share one deadline.
- Partition clearing cannot block replacement and settles or reports its
  sanitized timeout within five seconds of logical teardown.
- Existing permission, navigation, sandbox, and cookie-filtering tests continue
  to pass.

### Login Service Tests

- A request is cancellable before browser creation resolves.
- Cancellation delivered before the create handler leaves a tombstone, and the
  later create request allocates no session or window.
- A late browser result after cancellation is destroyed and never activated.
- Cancellation is idempotent for pending, active, unknown, and already-finished
  IDs.
- Starting a replacement disposes the previous attempt.
- The fifteen-second deadline begins at handler entry and includes logical
  replacement teardown.
- The independent expiry timer disposes an entry without renderer polling.
- Success, QR expiry, terminal failure, and application disposal each clean up
  once.
- One or two transient check failures preserve the session.
- A successful check resets the transient failure count.
- Three consecutive transient failures dispose the session.

### Renderer And IPC Tests

- Creation passes a renderer-generated request ID through IPC.
- Close, refresh, and unmount send cancellation and stop polling.
- Closing before creation resolves does not display an error.
- Late create or check responses cannot reopen the panel or restart polling.
- Refresh cancels the old attempt before the replacement becomes current.
- The performance endpoint waits for image load and the rendered
  animation-frame visibility check.
- IPC names, wrappers, handlers, and types remain wired.

### Verification

- Run the focused QQ browser-auth, login-service, renderer-account, IPC, UI
  wiring, and Electron security-boundary scripts.
- Run focused ESLint on touched TypeScript and Vue files.
- Run the main-process production build or equivalent TypeScript bundle check.
- Launch the Electron development build and test direct and LX-proxy network
  configurations.
- Run the performance acceptance procedure below in a production build.
- Close during creation and after QR display, then verify that no QQ login
  `BrowserWindow`, active entry, polling timer, or page workload remains.
- Complete one real mobile QQ scan and confirm account persistence and QQ
  recommendations still work.

## Performance Acceptance Procedure

The three-second target uses the following reproducible reference conditions:

- Windows 10 or 11, at least four logical CPU cores, 8 GB RAM, and SSD storage.
- Production build with developer tools closed and system CPU below 20 percent
  before each series.
- The application remains running for a series, but every attempt uses the
  required new isolated partition and no prewarmed login window.
- Before a series, three reachability probes to the QQ OAuth document and QR
  endpoint must each have a median time-to-first-byte no greater than 500 ms.
- A proxy series uses the LX proxy setting and a proxy that meets the same
  reachability bound. A direct series disables the LX proxy setting.

The renderer records the start immediately before invoking QR creation. After
the login panel's QR `<img>` emits `load` with non-zero natural dimensions, it
waits for the next animation frame and verifies that the image is connected,
visible, and has non-zero rendered bounds. That animation-frame check is the
QR-visible endpoint rather than merely an IPC or decode-ready timestamp.

Run ten new-QR attempts in direct mode and ten through the healthy LX proxy.
Close the panel after every QR-visible measurement and wait for the sanitized
cancellation diagnostic before starting the next attempt. At least nine of ten
attempts in each series must reach the QR-visible endpoint within three
seconds. Every attempt must either display the QR or complete logical teardown,
including window destruction, at the fifteen-second hard deadline. Partition
clearing must settle or emit its cleanup-timeout diagnostic within the
separate five-second budget. Record the raw timings, probe results, application
version, hardware, OS, and proxy mode with the verification result.

## Acceptance Criteria

1. A QQ login QR meets the three-second threshold defined by the performance
   acceptance procedure.
2. QR creation never waits for full OAuth page load after the QR is ready.
3. A login attempt uses one fifteen-second creation deadline.
4. The isolated login session honors the current LX proxy setting before
   navigation.
5. Closing the panel immediately invalidates the QR and releases pending or
   active browser resources.
6. Reopening the panel creates a new QR without reusing the previous session.
7. No QQ login browser remains after success, expiry, cancellation, terminal
   failure, timeout, replacement, component disposal, or application teardown.
8. Existing browser-backed QQ OAuth success and account persistence continue
   to work.
9. Existing Electron security boundaries and credential redaction remain in
   force.
10. No hidden browser is created before the user opens the QQ login panel.
11. Isolated partition clearing settles or reports its sanitized timeout within
    five seconds without blocking a replacement attempt.
