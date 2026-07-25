# QQ Music Personalized Home Design

## Goal

Replace the two-card QQ recommendation view with a functional QQ Music home page that follows the supplied reference layout. The page must expose today's recommendations, personalized playlists, a three-column song recommendation carousel, and a playlist discovery carousel while preserving LX Music playback, routing, theming, and account behavior.

## API Research

The implementation uses the QQ Music desktop client's current `musics.fcg` module protocol instead of the older web portal aggregation request. The request sequence and shelf mapping were verified against `C:\Users\hao238\Desktop\qm3.saz` (sessions 0065, 0083, 0926, and 0934) without copying account credentials into the repository.

| Page content | Module | Method | Purpose |
| --- | --- | --- | --- |
| Home structure | `music.recommend.RecommendFeed` | `get_recommend_feed` | Returns the personalized shelves, upstream titles, cards, covers, and grouped song recommendations. |
| Playable song details | `music.trackInfo.UniformRuleCtrl` | `CgiGetTrackInfo` | Expands numeric song card IDs from the home feed into complete QQ track objects with MID, album, file, and quality metadata. |
| Daily 30 | `music.ai_track_daily_svr` | `get_daily_track` | Existing authenticated Daily 30 implementation; remains the source of the playable daily list. |
| Guess You Like | `mb_track_radio_svr` | `get_radio_track` | Existing authenticated continuous recommendation implementation; remains the source of the playable Guess You Like queue. |

`get_recommend_feed` is sent to `https://u6.y.qq.com/cgi-bin/musics.fcg` with the captured desktop profile: `ct=20`, `cv=2116`, `platform=wk_v17`, account identifiers, cookie-derived `g_tk`, and the stored QQ Music cookie. Browser-login cookies that omit desktop `uid` or `guid` fields use the same deterministic account-scoped fallbacks as Daily 30 and Guess You Like. The exact serialized request body is signed with the shared QQ `zza` request signer and the signature is sent in the `sign` query parameter; signing a different serialization is invalid. Page 1 uses `direction=0`, `page=1`, and `s_num=0`; page 2 uses `direction=1`, `page=2`, and the page-1 shelf count as `s_num`. The renderer receives normalized data and never receives credentials or the raw response.

The older request combining `HotRecommendServer`, `PlayListPlazaServer`, new songs, albums, charts, and focus banners is intentionally not reused. It returns a generic portal page and cannot reproduce the personalized shelves in the references.

## Selected Approach

The recommended approach is a normalized home-feed service plus the two existing playable special lists.

Alternatives considered:

1. Compose the page from independent Daily 30, radio, radar, and playlist-square calls. This is mechanically simple but loses QQ Music's shelf titles, grouping, and exact personalized playlist selection.
2. Render raw `RecommendFeed` cards directly. This best matches the upstream page but many cards contain only numeric IDs or app schemes, which would create controls that LX Music cannot play or open reliably.
3. Normalize supported cards from the first two feed pages and enrich the selected song shelf in one batch request. This preserves the upstream recommendation choices while ensuring every rendered song and playlist is functional. This is the selected approach.

## Immersive Brush Mode

The first captured `id=301` shelf contains two QQ-owned special cards before its ordinary playlists: `type=700, id=99, title=猜你喜欢-沉浸刷歌` and `type=500, id=0, title=每日30首`. These are product entries, not playlist-detail IDs. QQ experiments may attach a numeric playlist scheme to the Daily 30 card, so ID filtering alone is insufficient. The normalizer exposes the first card as a small `brushMode` descriptor and excludes both `id=0` and the normalized `每日30首` product title from this shelf's `featuredPlaylists`. The renderer supplies the real Daily 30 card from the existing playable service and places Brush Mode third, so the first row has no duplicate Daily 30 entry.

Brush Mode uses the desktop client's captured `music.radioProxy.MbTrackRadioSvr/get_radio_track` request with `id=99` and `num=5`. It shares only the stateless main-process transport with Guess You Like. Its renderer state is deliberately separate: a distinct card ID, temporary-list ID, account owner, generation, queue, request single-flight, and continuation guard prevent either entry from replacing or extending the other's queue. The first brush batch is prefetched with the rest of the QQ recommendation page so its card can show a real song cover and `歌曲名 · 歌手` before activation. The main-process radio transport serializes the simultaneous Guess You Like and Brush Mode requests. When two songs remain, the global player requests another batch, deduplicates it, updates the Brush Mode temporary list, and continues playback without returning to the page.

## Main-Process Service

Create a focused `homeRecommend.ts` service beside the existing QQ Music services. It performs three bounded requests:

1. Request the first home feed page.
2. Request the second feed page, which contains the captured `id=205` `歌单遨游指南` shelf.
3. Collect numeric IDs from the selected song shelf and batch-query their complete track records with `source=AiNoFree`.

The normalizer produces one `LX.QQMusic.HomeRecommendation` object:

- `title`: formatted upstream hero title, with a local fallback.
- `featuredPlaylists`: supported playlist cards from the first shelf.
- `privatePlaylists`: playlist cards from stable shelf `id=271`. A title containing `私荐歌单` remains the preferred semantic match, while the ID fallback covers live experiments such as `你的歌单补给站`.
- `relatedSongTitle`: the formatted upstream song-shelf title, including personalized song text when available.
- `relatedSongGroups`: ordered groups of three playable QQ songs.
- `guidePlaylists`: cards from the page-2 `id=205` `歌单遨游指南`; if the experiment is absent, QQ's AI playlist shelf is used as the data source while the requested local section title remains stable.

Only playlist cards with a numeric ID, non-empty title, and cover are exposed. The numeric constraint is intentional because the existing QQ playlist-detail endpoint accepts the live ten-digit playlist IDs but rejects opaque or experiment-only identifiers. Related songs without a successful track-detail match are omitted. Empty or partially malformed shelves degrade to empty sections instead of failing the entire page.

## Renderer Data Flow

The renderer requests the normalized home recommendation through a dedicated IPC event. A QQ-page composable owns loading, error, refresh, per-account cache, and stale-response rejection. The account-keyed cache lives for the renderer module lifetime rather than one route instance: returning to the QQ recommendation page restores the same Feed playlists and related songs without another request. Only an explicit refresh/retry uses the force path to replace cached recommendations. Account changes clear the visible home data before loading the new account so artwork and recommendations cannot leak between users.

The page concurrently loads:

- home recommendation data;
- Daily 30;
- Guess You Like;
- the first five Brush Mode songs.

The top section keeps the already implemented Guess You Like card first and Daily 30 second, then appends up to three supported featured playlists. Playlist cards route to the existing QQ song-list detail page and use the existing detail loader for playback.

The song shelf keeps the upstream grouping. Left and right arrow buttons wrap through available groups without another network request. Clicking a song installs the visible group as an LX temporary list and starts at the selected index; the section play button toggles that same list.

Playlist cards expose separate open and play actions. Card-level Enter/Space handlers run only when the card itself owns the keyboard event, so keyboard activation of the nested play button cannot also navigate to playlist detail.

Guess You Like and Brush Mode cards keep their product names as the primary title. Their cover and supporting line are derived from the song currently playing in that card's own temporary list; the supporting line is always `歌曲名 · 歌手`. Each card stores its own last active song in module-level renderer state, so switching to Daily 30, opening another playlist route, returning to a newly created QQ recommendation page, or activating the other radio mode leaves the card on the song that user actually reached instead of resetting it to the first queue item. The first independently fetched song is used only before that mode has played anything or after account cleanup. The two histories are isolated, tagged with their QQ account owner, and synchronously cleared when the active account changes to prevent cross-account artwork and metadata leaks.

## Visual Design

The page keeps LX Music's theme variables and quiet desktop-tool character while borrowing the supplied QQ Music composition:

- A compact account-aware heading followed by a five-item feature strip.
- One wide Guess You Like feature followed by Daily 30, Brush Mode, and up to two square feed playlists at large widths.
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

- Main-process unit tests verify the captured desktop module/method/comm fields, two-page feed sequence, browser-cookie identity fallback, cookie isolation, track enrichment, stable shelf-ID selection, title formatting, fallback guide selection, malformed-card filtering, auth failure, and timeout cleanup.
- Renderer wiring tests verify IPC ownership, account-scoped loading, cache reuse across route reconstruction, explicit force refresh, required sections, carousel controls, playlist routing, temporary-list song playback, per-mode last-song retention after switching lists, and account cleanup.
- Existing QQ login, Guess You Like, Daily 30, continuous-playback, and provider-page tests remain green.
- TypeScript checks, ESLint, main/renderer production builds, and the complete application build must pass.
- Build `win x64 portable`, verify the executable exists and is non-empty, launch it with an isolated portable data directory, confirm it remains running without an immediate crash, and then close the verification instance.
