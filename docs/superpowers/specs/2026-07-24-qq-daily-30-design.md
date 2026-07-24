# QQ Music Daily 30 Design

## Goal

Add QQ Music's personalized Daily 30 playlist to the QQ recommendation page. The new card sits immediately to the right of Guess You Like and follows the same card and detail interactions as NetEase Cloud Music's Daily Recommendation card.

## API And Normalization

The main process sends an authenticated JSON POST request to `https://u6.y.qq.com/cgi-bin/musicu.fcg` with this module request:

```json
{
  "daily30": {
    "module": "music.ai_track_daily_svr",
    "method": "get_daily_track",
    "param": {}
  }
}
```

The `comm` object includes the stored account UIN, `qqmusic_key` as `authst`, `tmeLoginType`, and the current QQ Music PC client identifiers (`ct: 20`, `cv: 2116`). The Cookie header remains confined to the main process.

The service validates both the top-level response code and `daily30.code`, treats code `1000` as an expired QQ Music login, and normalizes `daily30.data.tracks` into `LX.Music.MusicInfo_tx[]`. Song normalization is shared with Guess You Like so artwork, artist, duration, quality, and playback metadata remain consistent.

## State And Account Isolation

Daily 30 uses a dedicated renderer store and temporary playlist ID. It does not share queue state, loading state, or playback mode with Guess You Like.

The store caches one successful result per QQ account for the current renderer session. Switching accounts, logging out, or explicitly clearing the account state removes the visible Daily 30 songs and invalidates stale requests. A late response from a previous account cannot replace the current account's list.

## Card Behavior

The QQ recommendation page displays two cards in this order:

1. Guess You Like
2. Daily 30

The Daily 30 card uses:

- Kicker: `Daily 30`
- Title: `每日30首`
- Cover: artwork from the first returned song
- Description: first song name and artist
- Count: number of returned songs, normally 30

When signed out, the card remains visible with a login prompt and no stale artwork. Clicking it opens the existing QQ Music QR login panel.

Hovering the cover reveals the existing play/pause control. Clicking that control starts, pauses, or resumes the dedicated Daily 30 temporary list without opening the detail page. Clicking any other part of the card navigates to the song-list detail page.

## Detail Page

The song-list loader recognizes the Daily 30 temporary ID before falling back to the ordinary provider song-list API. It builds a playlist detail object from the cached or freshly loaded Daily 30 songs, including the first-song artwork, personalized description, total count, and the complete track list.

Playback started from either the card or detail page uses the same Daily 30 temporary list ID. This keeps play/pause state synchronized across both views.

## Loading And Errors

After QQ account initialization or successful login, Guess You Like and Daily 30 load independently. A failure in one request does not hide or block the other card.

While loading, the Daily 30 card displays a loading description. An empty successful response displays an empty-state description. A request failure displays a short retryable error without exposing request URLs, cookies, tokens, or upstream response bodies. Clicking play retries loading. Opening the detail page while signed in also attempts to load the list through the detail loader.

## Verification

Focused tests cover:

- the exact authenticated Daily 30 request module, method, and `comm` fields;
- response-code handling and track normalization;
- account-scoped caching and stale-request rejection;
- card order, first-song artwork, title, description, and logged-out state;
- independent Daily 30 playback and play/pause detection;
- detail-page routing through the Daily 30 loader rather than the ordinary QQ playlist API;
- account logout clearing both QQ recommendation queues.

Run the focused QQ Music tests, relevant song-list tests, TypeScript checks, and lint checks for changed source files.

## Non-Goals

- Changing the existing Guess You Like continuation behavior.
- Persisting Daily 30 songs across application restarts.
- Adding Daily 30 to the NetEase recommendation page or sidebar.
- Changing the shared recommendation-card visual design.
