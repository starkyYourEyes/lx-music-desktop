# QQ Guess-Like Playback Card Design

## Goal

Replace the multi-song QQ Music guess-like section on the recommendation home page with a direct-play card. The card must use the same layout and interaction model as the existing Private FM card. It fetches personalized QQ Music songs and starts playback without opening a playlist detail route.

## Confirmed Behavior

- Place the QQ guess-like card in the special-card group immediately after Private FM.
- Reuse the existing special-card layout, cover play button, keyboard behavior, active state, and responsive grid.
- Do not render the current multi-song QQ guess-like section.
- Do not navigate to `/songList/detail` when the card or its play button is activated.
- When the current account has no usable queue or in-memory cache, call the existing QQ guess-like IPC operation, put the normalized songs in the `tx__qq_guess_like` temporary list, and start at the first song.
- While that temporary list is playing, activating the card pauses playback.
- While that temporary list is paused, activating the card resumes playback without another QQ request.
- Suppress duplicate activation while the first request is pending.
- Keep the card visible after a request failure and allow the next activation to retry.
- Use the first returned song artwork after a successful load. Before that, use the existing text fallback cover.
- Do not fetch QQ guess-like songs merely because the recommendation page mounted or QQ login completed.

## Logged-Out Behavior

The existing `recommend.qqGuessLikeLoggedOutVisible` setting remains authoritative:

- When enabled, render the QQ guess-like special card while logged out. Activating it opens the QQ login panel.
- When disabled, omit the card while logged out.
- When logged in, always render the card.

Successful login closes the login panel and reveals the card. Song retrieval still waits for an explicit card activation.

## Architecture

Extend `RecommendCard` with a QQ guess-like discriminator and include a derived QQ card in `useRecommendCards`. The card is presentation data only; it is not treated as a remote playlist.

Keep `useQQGuessLikeData` responsible for account-keyed in-memory caching, request state, errors, and normalized songs. Change recommendation-page orchestration so account initialization and login success no longer preload the songs. Account changes and logout invalidate visible QQ recommendation state so one account cannot reuse another account's songs.

Extend `useRecommendPlayback` with one card action for QQ guess-like playback. The action accepts an asynchronous loader so it can:

1. pause or resume the existing `tx__qq_guess_like` temporary list without loading;
2. request songs only when no usable QQ guess-like list is available;
3. install the returned songs into the temporary list and start playback;
4. report a safe error without navigating or creating an empty list.

`SpecialCards` remains provider-neutral. It emits `open` and `toggle-card-play`; both QQ card paths resolve to the same direct-play action, as they already do for Private FM.

## State and Error Presentation

- Idle card name: the localized "Guess You Like" label.
- Card kicker: `QQ Music`.
- Idle description: personalized QQ Music recommendations.
- Loading description: loading state; repeated activation has no effect.
- Failed description: load failed and can be retried by activating the card again.
- Loaded description and cover may use the first normalized song.
- The active border and cover play icon reflect only the `tx__qq_guess_like` player state.

No Cookie, OAuth code, raw QQ response, or main-process account data enters card state.

## Alternatives Rejected

- A separate QQ-only card component would duplicate the established special-card layout and interaction logic.
- A fake playlist card would incorrectly introduce playlist-detail navigation and remote-playlist semantics.
- Keeping the multi-song section would not satisfy the requested single-entry direct-play interaction.

## Testing

Follow the repository's Node test-script pattern and test first:

- QQ card is included after Private FM when logged in.
- Logged-out visibility follows the existing setting.
- Card activation opens login when logged out.
- First uncached logged-in activation requests QQ songs, creates `tx__qq_guess_like`, and starts at index zero.
- Pending activation is deduplicated.
- Active playback toggles pause and resume without another request.
- Failed loading leaves the card retryable and does not create an empty temporary list.
- Card activation never routes to song-list detail.
- Account changes invalidate visible songs and do not preload another account's recommendations.
- The old multi-song QQ section is no longer rendered or imported.
- Focused renderer wiring tests, lint, renderer build, and manual Electron UI checks pass.

## Acceptance Criteria

1. QQ guess-like appears as a special card matching Private FM rather than as a song list.
2. Clicking anywhere on the card directly controls playback and never opens playlist details.
3. The first uncached click fetches personalized songs through the existing QQ interface and starts playback.
4. Subsequent clicks pause or resume the same queue without refetching.
5. Logged-out visibility, QQ login, account separation, and persistent Cookie behavior remain unchanged.
6. Loading and failure states remain usable without exposing authentication material.
