# Local Music WebDAV Design

## Goal

Add a local music library that scans one or more user-configured folders, shows the songs from the left sidebar, and converts local songs to WebDAV-backed songs whenever they are added to user lists.

## Confirmed Behavior

- Users can configure multiple local music folders in Settings.
- The left sidebar gains a Local Music entry.
- The Local Music page scans configured folders recursively and displays local songs.
- Local songs can be played directly from local files.
- Right-clicking local songs can upload them to the configured WebDAV library.
- Adding local songs to any normal user list uploads them first and writes the returned `source: 'webdav'` item into the target list.
- If WebDAV is not configured or upload fails, the add-to-list action fails instead of storing a local-only item.

## Architecture

- Main process owns file scanning and WebDAV upload because it already owns WebDAV credentials and remote access.
- Renderer exposes a small store for local music list state and page interactions.
- Existing list add flow is extended in `src/renderer/store/list/action.ts` so local-to-WebDAV conversion happens consistently across modals and pages.
- Existing WebDAV playback remains unchanged: uploaded songs return the same `LX.Music.MusicInfoWebDAV` shape used by cloud disk songs.

## Data

New settings:

- `localMusic.dirs: string[]`
- `localMusic.webdavDir: string`

New IPC:

- `local_music_scan`
- `local_music_upload_to_webdav`

Supported local extensions:

- `mp3`
- `flac`
- `ogg`
- `oga`
- `wav`
- `m4a`

## Non-Goals

- No automatic background file watcher in this phase.
- No sidecar lyric or cover upload in this phase.
- No automatic deletion from WebDAV when local files disappear.
