# Settings Page Reorganization Design

## Goal

Reorganize the settings page so related controls are grouped together, dangerous list-clearing UI is no longer exposed, and the left navigation contains fewer narrowly scoped entries.

## Confirmed Behavior

- Rename the settings navigation item and page heading from `本地音乐` to `本地音乐/WebDAV` in Simplified Chinese.
- Keep other application surfaces that refer to the local music library as `本地音乐`.
- Move the WebDAV connection and credential card out of `其他` and place it between `本地音乐文件夹` and `WebDAV 音源`.
- Remove the `搜索设置` item from the settings navigation.
- Place the three existing search controls in a final `搜索设置` card within `基本设置`.
- Remove the `强迫症设置` item from the settings navigation.
- Place the two existing obsessive-compulsive controls in a final `强迫症设置` card within `其他`.
- Remove the `列表数据清理` card and its renderer-side event handling from `其他`.
- Preserve the underlying list-management APIs and all normal list-management behavior.

## Component Design

`src/renderer/views/Setting/index.vue` remains the owner of the settings navigation. It stops importing, registering, and listing `SettingSearch` and `SettingOdc` as top-level pages. Its local-music entry uses a new settings-specific translation key so the main local-music feature keeps its existing title.

`SettingSearch.vue` becomes an embeddable settings card rather than a top-level page. It keeps the existing setting keys, checkbox identifiers, labels, and update behavior. `SettingBasic.vue` renders this card after all existing basic-setting cards.

`SettingOdc.vue` likewise becomes an embeddable settings card. `SettingOther.vue` renders it after every other remaining card so it is the final section on that page.

A focused `SettingWebDAV.vue` component owns the existing WebDAV connection UI and renderer logic. `SettingLocalMusic.vue` renders it after the local-folder card and before the existing WebDAV-source card. This keeps WebDAV credential behavior intact without moving unrelated cache and tray logic into the local-music component.

## Localization

Add a settings-specific title key to the Simplified Chinese, Traditional Chinese, and English locale files:

- Simplified Chinese: `本地音乐/WebDAV`
- Traditional Chinese: `本地音樂/WebDAV`
- English: `Local Music/WebDAV`

Existing `local_music` translations remain unchanged because they are also used by the application sidebar, local-music page, and status messages.

## Safety Boundary

The list-data-cleanup card, `handleClearListData`, and the `overwriteListFull` import are removed from `SettingOther.vue`. No list store, persistence API, IPC contract, or list data is changed or deleted. This prevents users from invoking the destructive operation from Settings while retaining the lower-level capabilities required by normal application flows.

## Compatibility

All existing setting keys and stored values remain unchanged. Moving the controls does not migrate or reset preferences. Existing direct routes to removed top-level setting component names are allowed to use the settings page's current fallback behavior and open the first available settings page.

## Testing

Add a focused Node wiring test that reads the settings source files and verifies:

- `SettingSearch` and `SettingOdc` are absent from the top-level settings navigation.
- the local-music navigation uses the settings-specific title key;
- `SettingSearch` is rendered last by `SettingBasic`;
- `SettingOdc` is rendered last by `SettingOther`;
- `SettingWebDAV` is rendered between the local-folder and WebDAV-source cards;
- the list-data-cleanup label, handler, and destructive list-store import are absent from `SettingOther`.

Run the focused test before and after implementation to establish the expected failure and passing result. Finish with linting of the touched Vue and JavaScript files and a production renderer build.

## Non-Goals

- No redesign of card styling, typography, spacing, or controls.
- No changes to WebDAV connection, credential storage, upload, refresh, or playback behavior.
- No changes to search or obsessive-compulsive setting semantics.
- No removal of low-level list management APIs.
