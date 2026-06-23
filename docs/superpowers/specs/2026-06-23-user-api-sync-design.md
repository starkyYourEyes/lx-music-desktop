# User API Sync Design

## Goal

Add one-way synchronization for desktop custom music APIs, also called custom sources. The desktop app is the source of truth. When the desktop custom source list changes, the sync service sends the full decoded source list to connected clients that advertise support for the new `userApi` sync feature.

## Confirmed Behavior

- The feature reuses the existing sync connection and feature negotiation system.
- The feature is independent from playlist sync and dislike sync.
- Desktop-to-mobile is the only supported direction in this phase.
- The desktop app sends custom sources only after the custom source list changes, plus during initial feature sync when the remote data is out of date.
- The transmitted script is the original JavaScript text, not the desktop `user_api.json` compressed `gz_...` storage string.
- Mobile clients that do not advertise `userApi` support receive no custom source data.
- The mobile project should treat the received payload as "desktop overwrites desktop-managed mobile custom sources" and run its own custom source import/update logic.

## Non-Goals

- No mobile-to-desktop custom source sync.
- No conflict UI for custom sources.
- No per-source incremental diff protocol in this phase.
- No temporary `.js` file needs to be written by the desktop app before sending data.
- No changes to the desktop `user_api.json` on-disk format.

## Current Desktop Storage

Desktop custom sources are stored in `LxDatas/user_api.json` through `STORE_NAMES.USER_API`.

The stored `script` field may be compressed:

```json
{
  "script": "gz_eJx..."
}
```

The existing desktop code can decode this with the current `inflateScript()` logic in `src/main/modules/userApi/utils.ts`. The sync payload should use the inflated JavaScript text so mobile does not need to understand desktop storage internals.

## Recommended Architecture

Add a new sync module named `userApi`, mirroring the shape of `list` and `dislike` but with simpler overwrite-only behavior. "Overwrite" means replacing the set of custom sources previously imported from this desktop sync feature, not necessarily deleting mobile-only custom sources.

Desktop data flow:

```text
desktop user imports/removes/updates custom source
-> src/main/modules/userApi/utils.ts saves user_api.json
-> emit user_api_changed
-> sync server userApi local event builds decoded payload
-> broadcast user_api_data_overwrite to connected ready clients
-> mobile client imports/overwrites desktop-managed custom sources
```

Initial connection flow:

```text
server asks client for enabled features
-> client advertises userApi if supported
-> server compares desktop payload md5 with remote md5
-> if different, server sends full desktop payload
-> both sides mark userApi module ready
```

## Desktop Code Changes

### 1. Add Sync Types

Add `src/common/types/user_api_sync.d.ts`.

Suggested types:

```ts
declare namespace LX {
  namespace Sync {
    namespace UserApi {
      interface ApiInfo {
        id: string
        name: string
        description: string
        author: string
        homepage: string
        version: string
        allowShowUpdateAlert?: boolean
        script: string
        scriptEncoding: 'plain'
      }

      interface Data {
        source: 'desktop'
        updatedAt: number
        apis: ApiInfo[]
      }

      type ActionList =
        LX.Sync.SyncAction<'user_api_data_overwrite', Data>
    }
  }
}
```

### 2. Extend Sync Feature Constants

Update `src/common/constants_sync.ts`.

```ts
export const FeaturesList = [
  'list',
  'dislike',
  'userApi',
] as const
```

Add a config type in `src/common/types/sync.d.ts`:

```ts
interface UserApiConfig {
  skipSnapshot: true
}

interface EnabledFeatures {
  list?: false | ListConfig
  dislike?: false | DislikeConfig
  userApi?: false | UserApiConfig
  party?: false | PartyConfig
}
```

`skipSnapshot` is always `true` for this feature because the desktop is authoritative and there is no conflict merge.

### 3. Extend Socket Types

Update `src/main/types/sync.d.ts`.

Client socket additions:

```ts
moduleReadys: {
  list: boolean
  dislike: boolean
  party: boolean
  userApi: boolean
}

remoteQueueUserApi: LX.Sync.ServerSyncUserApiActions
```

Server socket additions:

```ts
feature: LX.Sync.EnabledFeatures

moduleReadys: {
  list: boolean
  dislike: boolean
  userApi: boolean
}

remoteQueueUserApi: LX.Sync.ClientSyncUserApiActions
```

### 4. Add RPC Action Types

Update `src/main/types/sync_common.d.ts`.

Server actions exposed to clients:

```ts
type ServerSyncUserApiActions = WarpPromiseRecord<{
  onUserApiSyncAction: (action: LX.Sync.UserApi.ActionList) => void
}>

type ServerSyncHandlerUserApiActions<Socket> =
  WarpSyncHandlerActions<Socket, ServerSyncUserApiActions>
```

Client actions exposed to server:

```ts
type ClientSyncUserApiActions = WarpPromiseRecord<{
  onUserApiSyncAction: (action: LX.Sync.UserApi.ActionList) => void
  user_api_sync_get_md5: () => string
  user_api_sync_get_data: () => LX.Sync.UserApi.Data
  user_api_sync_set_data: (data: LX.Sync.UserApi.Data) => void
  user_api_sync_finished: () => void
}>

type ClientSyncHandlerUserApiActions<Socket> =
  WarpSyncHandlerActions<Socket, ClientSyncUserApiActions>
```

### 5. Add User API Export and Overwrite Utilities

Update `src/main/modules/userApi/utils.ts`.

Add a decoded export helper:

```ts
export const getUserApiSyncData = async(): Promise<LX.Sync.UserApi.Data> => {
  const apis = getUserApis()
  return {
    source: 'desktop',
    updatedAt: Date.now(),
    apis: await Promise.all(apis.map(async api => ({
      ...api,
      scriptEncoding: 'plain' as const,
      script: await getScript(api.id),
    }))),
  }
}
```

Add an overwrite helper for desktop compatibility, even though this phase does not need mobile-to-desktop sync:

```ts
export const overwriteUserApisFromSync = async(data: LX.Sync.UserApi.Data) => {
  userApis = data.apis.map(({ script, scriptEncoding, ...info }) => info)
  scripts.clear()
  for (const api of data.apis) {
    scripts.set(api.id, await deflateScript(api.script))
  }
  saveData()
}
```

When decoding a script fails, log the error and skip that source in the outgoing sync payload. A single malformed source should not prevent other sources from syncing.

### 6. Emit Change Events

Update `src/main/event/AppEvent.ts`.

Add:

```ts
user_api_changed() {
  this.emit('user_api_changed')
}
```

Update `src/main/modules/userApi/utils.ts` so these functions call `global.lx.event_app.user_api_changed()` after a successful save:

- `importApi()`
- `removeApi()`
- `setAllowShowUpdateAlert()`
- any future function that changes `userApis` or a script body

Do not emit the event while applying a remote overwrite unless mobile-to-desktop sync is added later.

### 7. Add Shared User API Sync Event Module

Add `src/main/modules/sync/userApiEvent.ts`.

Responsibilities:

```ts
export const getLocalUserApiData = async(): Promise<LX.Sync.UserApi.Data>
export const getLocalUserApiMD5 = async(): Promise<string>
export const setLocalUserApiData = async(data: LX.Sync.UserApi.Data): Promise<void>
export const registerUserApiActionEvent = (
  sendAction: (action: LX.Sync.UserApi.ActionList) => void | Promise<void>
) => () => void
export const handleRemoteUserApiAction = async(action: LX.Sync.UserApi.ActionList) => void
```

`getLocalUserApiMD5()` should hash a stable JSON string of the decoded payload, excluding `updatedAt`, so unchanged sources do not resync just because the payload was rebuilt.

Suggested stable hash input:

```ts
{
  source: 'desktop',
  apis: data.apis.map(api => ({
    id: api.id,
    name: api.name,
    description: api.description,
    author: api.author,
    homepage: api.homepage,
    version: api.version,
    allowShowUpdateAlert: api.allowShowUpdateAlert,
    scriptEncoding: api.scriptEncoding,
    script: api.script,
  })),
}
```

### 8. Add Client Sync Module

Add:

```text
src/main/modules/sync/client/modules/userApi/index.ts
src/main/modules/sync/client/modules/userApi/handler.ts
src/main/modules/sync/client/modules/userApi/localEvent.ts
```

For desktop clients, `handler.ts` should support the full RPC contract. For mobile, the mobile project should implement equivalent methods.

Client handler outline:

```ts
const handler: LX.Sync.ClientSyncHandlerUserApiActions<LX.Sync.Client.Socket> = {
  async onUserApiSyncAction(socket, action) {
    if (!socket.moduleReadys?.userApi) return
    await handleRemoteUserApiAction(action)
  },

  async user_api_sync_get_md5() {
    return getLocalUserApiMD5()
  },

  async user_api_sync_get_data() {
    return getLocalUserApiData()
  },

  async user_api_sync_set_data(socket, data) {
    await setLocalUserApiData(data)
  },

  async user_api_sync_finished(socket) {
    socket.moduleReadys.userApi = true
    registerEvent(socket)
    socket.onClose(() => unregisterEvent())
  },
}
```

Client `localEvent.ts` mirrors list sync: when local desktop custom sources change and the client is ready, send `onUserApiSyncAction({ action: 'user_api_data_overwrite', data })` to the server. This is useful for desktop-to-desktop compatibility, but mobile clients do not need to send local changes in this one-way phase.

### 9. Add Server Sync Module

Add:

```text
src/main/modules/sync/server/modules/userApi/index.ts
src/main/modules/sync/server/modules/userApi/sync/index.ts
src/main/modules/sync/server/modules/userApi/sync/sync.ts
src/main/modules/sync/server/modules/userApi/sync/handler.ts
src/main/modules/sync/server/modules/userApi/sync/localEvent.ts
```

Server initial sync outline:

```ts
const syncUserApi = async(socket: LX.Sync.Server.Socket) => {
  if (!socket.feature.userApi) throw new Error('userApi feature options not available')

  const [localMD5, remoteMD5] = await Promise.all([
    getLocalUserApiMD5(),
    socket.remoteQueueUserApi.user_api_sync_get_md5(),
  ])

  if (localMD5 != remoteMD5) {
    const data = await getLocalUserApiData()
    await socket.remoteQueueUserApi.user_api_sync_set_data(data)
  }
}

export const sync = async(socket: LX.Sync.Server.Socket) => {
  await syncUserApi(socket).then(async() => {
    await socket.remoteQueueUserApi.user_api_sync_finished()
    socket.moduleReadys.userApi = true
  })
}
```

Server handler for client-originated actions:

```ts
const handler: LX.Sync.ServerSyncHandlerUserApiActions<LX.Sync.Server.Socket> = {
  async onUserApiSyncAction(socket, action) {
    if (!socket.moduleReadys.userApi) return
    await handleRemoteUserApiAction(action)

    const currentId = socket.keyInfo.clientId
    socket.broadcast(client => {
      if (
        client.keyInfo.clientId == currentId ||
        !client.moduleReadys?.userApi ||
        client.userInfo.name != socket.userInfo.name
      ) return
      void client.remoteQueueUserApi.onUserApiSyncAction(action)
    })
  },
}
```

Server `localEvent.ts`:

```ts
registerUserApiActionEvent(action => {
  for (const client of wss.clients) {
    if (!client.moduleReadys?.userApi) continue
    void client.remoteQueueUserApi.onUserApiSyncAction(action)
  }
})
```

### 10. Wire Modules Into Sync Framework

Update `src/main/modules/sync/server/modules/index.ts`:

```ts
import { sync as userApiSync } from './userApi'

export const callObj = Object.assign({},
  listSync.handler,
  dislikeSync.handler,
  userApiSync.handler,
)

export const modules = {
  list: listSync,
  dislike: dislikeSync,
  userApi: userApiSync,
}

export const featureVersion = {
  list: 1,
  dislike: 1,
  userApi: 1,
} as const
```

Update `src/main/modules/sync/client/modules/index.ts` similarly.

Update `src/main/modules/sync/client/sync/handler.ts`:

```ts
if (featureVersion.userApi == supportedFeatures.userApi) {
  features.userApi = { skipSnapshot: true }
}
```

Update server socket setup in `src/main/modules/sync/server/server/server.ts`:

```ts
socket.moduleReadys.userApi = false
socket.feature.userApi = false
socket.remoteQueueUserApi = msg2call.createQueueRemote('userApi')
```

Update client socket setup in `src/main/modules/sync/client/client.ts`:

```ts
client.moduleReadys.userApi = false
client.remoteQueueUserApi = message2read.createQueueRemote('userApi')
```

## Wire Format

### Feature Negotiation

Desktop server advertises supported feature versions:

```json
{
  "list": 1,
  "dislike": 1,
  "userApi": 1
}
```

Mobile client accepts:

```json
{
  "userApi": {
    "skipSnapshot": true
  }
}
```

### Data Payload

`LX.Sync.UserApi.Data`:

```json
{
  "source": "desktop",
  "updatedAt": 1782035565095,
  "apis": [
    {
      "id": "user_api_923_1782035565095",
      "name": "Example Source",
      "description": "v1.2.1 example",
      "author": "",
      "homepage": "",
      "version": "1.2.1",
      "allowShowUpdateAlert": true,
      "scriptEncoding": "plain",
      "script": "/* ... original JavaScript source ... */\n"
    }
  ]
}
```

Field notes:

- `id` is the desktop custom source id. Mobile may preserve it as the stable remote id.
- `scriptEncoding` is currently always `plain`.
- `script` is raw JavaScript text after desktop `gz_` inflation.
- `updatedAt` is informational. It should not be part of the MD5 comparison.
- Empty `apis: []` means desktop has no custom sources and mobile should clear sources whose `remoteSource` is `"desktop"`.

### RPC Methods

Calls from server to client:

```text
userApi.user_api_sync_get_md5() -> string
userApi.user_api_sync_get_data() -> LX.Sync.UserApi.Data
userApi.user_api_sync_set_data(data) -> void
userApi.user_api_sync_finished() -> void
userApi.onUserApiSyncAction(action) -> void
```

Calls from client to server:

```text
userApi.onUserApiSyncAction(action) -> void
```

In the one-way mobile phase, mobile does not need to call `onUserApiSyncAction` unless it later supports mobile-to-desktop changes.

### Realtime Action

```json
{
  "action": "user_api_data_overwrite",
  "data": {
    "source": "desktop",
    "updatedAt": 1782035565095,
    "apis": []
  }
}
```

## Mobile Implementation Contract

Mobile should implement `userApi` as a sync feature with version `1`.

On `user_api_sync_set_data(data)` or `onUserApiSyncAction({ action: 'user_api_data_overwrite', data })`:

1. Validate `data.source == 'desktop'`.
2. For each item, require `scriptEncoding == 'plain'`.
3. Parse each `script` with the existing mobile custom source import parser.
4. Preserve or map desktop `id` so future overwrites update the same source.
5. Replace the set of desktop-managed custom sources with `data.apis`.
6. Do not remove mobile-only custom sources unless the mobile project explicitly chooses full replacement for all custom sources.

Recommended mobile storage model:

```text
custom source
  id: mobile internal id
  remoteId: desktop api id
  remoteSource: "desktop"
  name, description, author, homepage, version
  script: mobile preferred storage format
```

Using `remoteId` lets mobile update desktop-managed sources without deleting unrelated mobile-only sources.

## Change Triggering

Only trigger realtime sync after successful desktop custom source persistence.

Trigger points:

- import custom source
- remove custom source
- change update alert flag
- future edit/update of a source script or metadata

Do not trigger when:

- the app only reads `user_api.json`
- a sync connection starts and performs initial comparison
- a remote overwrite is applied for a future desktop-to-desktop scenario

## Error Handling

- If the remote side does not support `userApi`, skip the feature silently.
- If one desktop script fails to inflate, log the error and omit that source from the outgoing payload.
- If mobile rejects the payload, the RPC call should fail and the desktop sync side may close the connection with `SYNC_CLOSE_CODE.failed`, matching existing list/dislike behavior.
- If the payload is identical by MD5 during initial sync, do not send source data.

## Test Plan

Desktop unit-level checks:

- `gz_` script is inflated to raw JavaScript in `getUserApiSyncData()`.
- plain legacy script is passed through unchanged.
- MD5 ignores `updatedAt`.
- failed script inflation skips only the broken source.

Desktop integration checks:

- importing a custom source emits `user_api_changed`.
- removing a custom source emits `user_api_changed`.
- a connected `userApi`-ready client receives one `user_api_data_overwrite` action after a change.
- clients without `userApi` support receive no source payload.
- initial sync sends data when MD5 differs and sends nothing when MD5 matches.

Mobile contract checks:

- mobile accepts `scriptEncoding: "plain"`.
- mobile imports a raw JavaScript source from `script`.
- mobile updates an existing desktop-managed source by desktop `id`.
- mobile clears only desktop-managed sources when `apis` is empty.
