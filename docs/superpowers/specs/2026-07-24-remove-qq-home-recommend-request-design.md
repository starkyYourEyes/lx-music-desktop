# Remove QQ Home Recommendation Request

## Goal

Remove the QQ Music home recommendation diagnostic request from the application while preserving the QQ recommendation page, QQ account login, and the QQ "Guess You Like" experience.

## Scope

Remove the complete runtime path for the home recommendation request:

- the QQ recommendation page diagnostic composable and all calls to it;
- the renderer IPC wrapper and IPC event name;
- the main-process IPC handler and account-service entry point;
- the QQ home recommendation request service;
- types used only by this request;
- tests dedicated to the removed request, plus obsolete wiring assertions.

Keep the previously captured `qq-getRecommend-response.json` file and historical design documents as reference material.

## Runtime Behavior

Opening the QQ recommendation page or changing to a logged-in QQ account must no longer send a QQ home recommendation request or write `[QQ Music getRecommend]` messages to the developer console.

QQ login, account restoration, account logout, the QQ recommendation route, sidebar navigation, "Guess You Like" loading, and playback behavior remain unchanged.

## Verification

Add or update a wiring assertion first so it fails while the diagnostic request is still connected. After removing the request path, run the focused QQ recommendation page, QQ login, account, IPC, song, and continuous recommendation tests. Search production sources to verify that `getHomeRecommend`, `qq_music_get_home_recommend`, `useQQHomeRecommendDiagnostic`, and the console label no longer remain.

## Non-Goals

- Do not change the QQ recommendation page layout or styling.
- Do not alter the "Guess You Like" request or playback behavior.
- Do not delete the captured response JSON or historical documentation.
- Do not add a replacement recommendation API.
