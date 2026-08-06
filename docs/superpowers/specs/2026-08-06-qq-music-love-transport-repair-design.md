# QQ Music Love Transport Repair Design

**Date:** 2026-08-06

**Status:** Approved direction; pending written-spec review

## Problem

Adding a QQ Music track to LX Music's Love list updates the local list but does
not add the track to the signed-in QQ Music account's "I Like" list.

Runtime evidence from the portable build confirms that:

- the QQ account credential and public profile are present after login;
- recommendation tracks retain `source: 'tx'`;
- recent Love-list records contain valid numeric QQ song IDs and song types;
- QQ Music still uses directory `201` for "I Like".

The remaining incompatibility is the transport used by
`PlaylistDetailWrite/AddSonglist`. The current implementation sends plain JSON
to the signed `u6.y.qq.com/cgi-bin/musics.fcg` endpoint. Current working QQ
Music implementations use either the plain JSON
`u.y.qq.com/cgi-bin/musicu.fcg` protocol with account fields in `comm`, or the
encrypted `ag-1` protocol on the `u6` endpoint. The existing request mixes the
two protocols.

## Goals

1. Make a QQ track added to the local Love list reach QQ Music's "I Like"
   list for the signed-in account.
2. Preserve the existing one-way, best-effort local favorite behavior.
3. Keep QQ recommendation dislike feedback on its existing transport.
4. Reject malformed or unsuccessful QQ write responses instead of accepting a
   silent no-op.

## Non-Goals

- Removing a QQ heart when a local favorite is removed.
- Bulk backfilling existing local favorites.
- Implementing the encrypted QQ Music `ag-1` transport.
- Refactoring unrelated QQ recommendation, playback, or account code.
- Changing playback source fallback behavior.

## Design

`likeMusic` will send `music.musicasset.PlaylistDetailWrite/AddSonglist` to
`https://u.y.qq.com/cgi-bin/musicu.fcg` as JSON. Its request keeps the existing
business parameters:

```json
{
  "dirId": 201,
  "tid": 0,
  "bFmtUtf8": true,
  "v_songInfo": [{ "songId": 123, "songType": 0 }]
}
```

The common request data will identify and authenticate the active QQ Music
account with `uid`, `qq`, `authst`, `loginUin`, `tmeLoginType`, and
`tmeAppID: "qqmusic"`, alongside JSON charset and client-version fields. Values
come only from the current account cookie. The request includes the full cookie
plus QQ Music's `Origin` and `Referer` headers; credentials are never logged.

The existing signed `u6` request remains in place for
`music.feedback.FeedbackBlack/AddDislike`. Transport selection stays internal
to the feedback service so account retry and IPC ownership do not change.

An AddSonglist response succeeds only when the global and module codes are
zero and the operation reports either `retCode: 0` or a valid result update
time. Authentication codes continue to raise `QQMusicAuthError`; all other
failures use the existing sanitized generic error.

## Data Flow

1. The renderer commits a QQ track to `LIST_IDS.LOVE`.
2. The existing source filter selects records with `source: 'tx'`.
3. IPC passes a cloneable QQ music record to the main process.
4. The account service runs credential preflight and one authenticated retry.
5. The feedback service sends AddSonglist over the plain `musicu.fcg`
   transport.
6. Remote failure leaves the local Love entry intact.

## Testing

Implementation follows red-green-refactor. The focused feedback test will
first fail while asserting that AddSonglist:

- targets `u.y.qq.com/cgi-bin/musicu.fcg` without the old `sign` query;
- includes the current account fields in `comm`;
- preserves `dirId`, numeric song ID, and song type;
- accepts the supported success response shapes and rejects missing success
  evidence;
- does not alter the existing AddDislike request transport.

After the focused test passes, the existing QQ feedback, account, IPC, Love
sync, recommendation, build, and lint checks will run in proportion to the
changed surface.

## Manual Verification

The portable application will be rebuilt after automated verification. With
the QQ account shown as signed in, adding a previously unhearted QQ
recommendation track to the local Love list must make it appear in QQ Music's
"I Like" list. The local favorite must remain when the remote request fails.
