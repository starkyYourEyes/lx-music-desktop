# QQ Music Recommend Page Design

## Goal

Split provider recommendations into adjacent NetEase Cloud Music and QQ Music sidebar destinations. Move the existing QQ Music "Guess You Like" experience out of the NetEase recommendation page without changing its playlist playback behavior.

## Navigation

- Keep `/recommend` as the NetEase recommendation route for compatibility.
- Add `/qq-recommend` with route name `QQRecommend`.
- Place the two provider entries immediately below the account avatar in this order: NetEase Cloud Music, QQ Music.
- Place the existing separator after the QQ Music entry so both providers form one navigation group.
- Use bundled, colored provider logo assets. Keep the existing active background and bottom indicator.
- Route QQ login requests from the account popover to `/qq-recommend`; NetEase login requests continue to use `/recommend`.

## Provider Pages

The existing `Recommend` page becomes NetEase-only. It retains NetEase login, home sections, playback, refresh, account loading, and scroll caching. All QQ login, data, cache, card, and playback wiring is removed from this page.

The new `QQRecommend` page owns QQ account initialization, QR login, Guess You Like loading, account-change cleanup, and playback. It reuses the existing `LoginPanel`, `SpecialCards`, `useQQMusicLoginQr`, `useQQGuessLikeData`, and QQ-capable playback composable.

When signed out, the page always shows a stable login card. Clicking it opens the QR panel; opening the page does not automatically display a QR code. When signed in, entering the page or completing login automatically loads Guess You Like once, using the existing per-account cache on subsequent visits.

## Guess You Like Card

- Preserve the current card interaction: clicking the card or play control plays or pauses the complete Guess You Like temporary list.
- Use the first returned song artwork as the cover.
- Keep `猜你喜欢` as the card title.
- Show the first song as `歌曲名 · 歌手` below the title.
- Show explicit loading, empty, and load-failure states without retaining another account's artwork.
- Keep card sizing consistent with the existing recommendation cards; the single QQ card occupies one grid column rather than stretching across the page.

## Settings And Localization

- Remove `recommend.qqGuessLikeLoggedOutVisible` from defaults, setting types, and UI.
- Rename the setting section from generic "Recommend Page" to "NetEase Music Recommendations" in Simplified Chinese, Traditional Chinese, and English.
- Add localized sidebar labels for NetEase and QQ recommendation destinations.

## Verification

- Add a focused Node wiring test covering route ownership, sidebar ordering/logo assets, provider-specific login navigation, QQ page auto-loading, card metadata, and removal of the obsolete setting.
- Run the focused test, TypeScript checks for common and renderer projects, ESLint on changed source files, and the renderer production build.

