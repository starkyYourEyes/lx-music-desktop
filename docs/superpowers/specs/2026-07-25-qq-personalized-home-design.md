# QQ Music Personalized Home Design

## Goal

Replace the two-card QQ recommendation view with a functional QQ Music home page that follows the supplied reference layout. The page must expose today's recommendations, personalized playlists, a three-column song recommendation carousel, and a playlist discovery carousel while preserving LX Music playback, routing, theming, and account behavior.

## API Research

The implementation uses QQ Music's current `musicu.fcg` module protocol instead of the older web portal aggregation request.

| Page content | Module | Method | Purpose |
| --- | --- | --- | --- |
| Home structure | `music.recommend.RecommendFeed` | `get_recommend_feed` | Returns the personalized shelves, upstream titles, cards, covers, and grouped song recommendations. |
| Playable song details | `music.trackInfo.UniformRuleCtrl` | `CgiGetTrackInfo` | Expands numeric song card IDs from the home feed into complete QQ track objects with MID, album, file, and quality metadata. |
| Daily 30 | `music.ai_track_daily_svr` | `get_daily_track` | Existing authenticated Daily 30 implementation; remains the source of the playable daily list. |
| Guess You Like | `mb_track_radio_svr` | `get_radio_track` | Existing authenticated continuous recommendation implementation; remains the source of the playable Guess You Like queue. |

`get_recommend_feed` is sent as an authenticated Android-profile request with `ct=11`, `cv=14090008`, `v=14090008`, account `qq`, `authst`, `tmeAppID=qqmusic`, and `tmeLoginType`. The stored QQ Music cookie is forwarded in the main process only. The renderer receives normalized data and never receives credentials or the raw response.

The older request combining `HotRecommendServer`, `PlayListPlazaServer`, new songs, albums, charts, and focus banners is intentionally not reused. It returns a generic portal page and cannot reproduce the personalized shelves in the references.

## Selected Approach

The recommended approach is a normalized home-feed service plus the two existing playable special lists.

Alternatives considered:

1. Compose the page from independent Daily 30, radio, radar, and playlist-square calls. This is mechanically simple but loses QQ Music's shelf titles, grouping, and exact personalized playlist selection.
2. Render raw `RecommendFeed` cards directly. This best matches the upstream page but many cards contain only numeric IDs or app schemes, which would create controls that LX Music cannot play or open reliably.
3. Normalize supported feed cards and enrich song cards in a second batch request. This preserves the upstream recommendation choices while ensuring every rendered song and playlist is functional. This is the selected approach.

## Main-Process Service

Create a focused `homeRecommend.ts` service beside the existing QQ Music services. It performs at most two bounded requests:

1. Request the first home feed page.
2. Collect numeric IDs from the selected song shelf and batch-query their complete track records.

The normalizer produces one `LX.QQMusic.HomeRecommendation` object:

- `title`: formatted upstream hero title, with a local fallback.
- `featuredPlaylists`: supported playlist cards from the first shelf.
- `privatePlaylists`: playlist cards from the shelf whose title contains `私荐歌单`.
- `relatedSongTitle`: the formatted upstream song-shelf title, including personalized song text when available.
- `relatedSongGroups`: ordered groups of three playable QQ songs.
- `guidePlaylists`: cards from `歌单遨游指南`; if the experiment is absent, QQ's AI playlist shelf is used as the data source while the requested local section title remains stable.

Only playlist cards with a numeric ID, non-empty title, and cover are exposed. Related songs without a successful track-detail match are omitted. Empty or partially malformed shelves degrade to empty sections instead of failing the entire page.

## Renderer Data Flow

The renderer requests the normalized home recommendation through a dedicated IPC event. A QQ-page composable owns loading, error, refresh, per-account cache, and stale-response rejection. Account changes clear all home data before loading the new account so artwork and recommendations cannot leak between users.

The page concurrently loads:

- home recommendation data;
- Daily 30;
- Guess You Like.

The top section merges the Daily 30 and Guess You Like cards with up to three supported featured playlists. Playlist cards route to the existing QQ song-list detail page and use the existing detail loader for playback.

The song shelf keeps the upstream grouping. Left and right arrow buttons wrap through available groups without another network request. Clicking a song installs the visible group as an LX temporary list and starts at the selected index; the section play button toggles that same list.

## Visual Design

The page keeps LX Music's theme variables and quiet desktop-tool character while borrowing the supplied QQ Music composition:

- A compact account-aware heading followed by a five-item feature strip.
- One wide Daily 30 feature and four square feature cards at large widths.
- A six-column private-playlist row with edge navigation.
- A three-column by three-row related-song panel with arrows anchored to the left and right edges.
- A six-column playlist discovery row labeled `歌单遨游指南`.

Sections remain unframed; only individual media items are cards. Covers use an 8px maximum radius, controls use familiar play and chevron symbols, and responsive breakpoints reduce the grid to two columns and then one without text overlap.

Loading uses stable skeleton dimensions. Empty and error states preserve the section layout and expose a retry command. Signed-out users see the existing QQ QR-login entry instead of stale recommendations.

## Error And Account Handling

- Missing cookie throws `QQMusicAuthError` before any request.
- HTTP failure, timeout, non-zero global code, or non-zero module code produces a sanitized home-recommendation error.
- Authentication error code `1000` clears the stored account through the existing account facade behavior.
- Every main-process request has a ten-second abort timeout.
- Renderer results are accepted only when both the request revision and QQ account key still match.
- A failed refresh retains the last successful data for the same account and exposes the refresh error.

## Testing And Verification

- Main-process unit tests verify request module/method/comm fields, cookie isolation, two-request enrichment, shelf selection, title formatting, fallback guide selection, malformed-card filtering, auth failure, and timeout cleanup.
- Renderer wiring tests verify IPC ownership, account-scoped loading, required sections, carousel controls, playlist routing, and temporary-list song playback.
- Existing QQ login, Guess You Like, Daily 30, continuous-playback, and provider-page tests remain green.
- TypeScript checks, ESLint, main/renderer production builds, and the complete application build must pass.
- Build `win x64 portable`, verify the executable exists and is non-empty, launch it with an isolated portable data directory, confirm it remains running without an immediate crash, and then close the verification instance.

