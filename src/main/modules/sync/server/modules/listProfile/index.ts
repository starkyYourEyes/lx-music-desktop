import { normalizeSnapshot, mergeSnapshots, snapshotsEqual, type ProfileSnapshot } from '@common/utils/listProfileSync'
import { getProfileSnapshot, applyProfileSnapshot, onPlaylistMetadataChanged } from '@main/modules/sync/listProfileEvent'
import getStore from '@main/utils/store'
import { SYNC_CLOSE_CODE } from '@common/constants_sync'

interface SharedSnapshot { snapshot: ProfileSnapshot, mode: string }
const rounds = new WeakMap<LX.Sync.Server.Socket, { epoch: number, dirty: boolean, promise: Promise<void> }>()
const generations = new WeakMap<LX.Sync.Server.Socket, number>()
const generation = (socket: LX.Sync.Server.Socket) => generations.get(socket) ?? 0
export const invalidate = (socket: LX.Sync.Server.Socket) => {
  const epoch = generation(socket) + 1
  generations.set(socket, epoch)
  socket.moduleReadys.listProfile = false
  return () => generation(socket) == epoch
}
const isCurrent = (socket: LX.Sync.Server.Socket, epoch: number) => generation(socket) == epoch &&
  socket.readyState == 1 && socket.moduleReadys.list && !!socket.feature.listProfile
const syncRound = async(socket: LX.Sync.Server.Socket, epoch: number) => {
  if (!isCurrent(socket, epoch)) return false
  const store = getStore('sync_list_profiles_v1', false)
  const key = JSON.stringify([socket.userInfo.name, socket.keyInfo.clientId])
  const shared = store.get<SharedSnapshot | undefined>(key)
  const remote = normalizeSnapshot(await socket.remoteQueueListProfile.profile_sync_get())
  if (!isCurrent(socket, epoch)) return false
  const local = await getProfileSnapshot()
  if (!isCurrent(socket, epoch)) return false
  const mode = socket.profileSyncMode ?? shared?.mode ?? 'merge_local_remote'
  const next = mergeSnapshots(local, remote, shared?.snapshot, mode)
  const applied = await applyProfileSnapshot(local, next)
  if (!isCurrent(socket, epoch)) return false
  const acknowledged = normalizeSnapshot(await socket.remoteQueueListProfile.profile_sync_apply(remote, applied))
  if (!isCurrent(socket, epoch)) return false
  await store.setDurable(key, { snapshot: applied, mode: mode.includes('remote_local') ? 'merge_remote_local' : 'merge_local_remote' })
  if (!isCurrent(socket, epoch)) return false
  socket.profileSyncMode = undefined
  return !snapshotsEqual({ ...applied, listIds: [] }, { ...acknowledged, listIds: [] })
}
const run = async(socket: LX.Sync.Server.Socket, epoch = generation(socket)) => {
  if (!isCurrent(socket, epoch)) return
  const active = rounds.get(socket)
  if (active) {
    if (active.epoch == epoch) { active.dirty = true; return active.promise }
    await active.promise
    if (isCurrent(socket, epoch)) await run(socket, epoch)
    return
  }
  const state = { epoch, dirty: true, promise: Promise.resolve() }
  rounds.set(socket, state)
  state.promise = (async() => {
    let attempts = 0
    while (state.dirty && isCurrent(socket, epoch)) {
      if (++attempts > 20) throw new Error('Playlist profile sync did not converge')
      state.dirty = false
      if (await syncRound(socket, epoch)) state.dirty = true
    }
  })().catch(error => { if (isCurrent(socket, epoch)) throw error }).finally(() => { rounds.delete(socket) })
  return state.promise
}
const request = (socket: LX.Sync.Server.Socket) => {
  if (!socket.moduleReadys?.listProfile) return
  const epoch = generation(socket)
  void run(socket).catch(error => {
    if (!isCurrent(socket, epoch)) return
    console.error('Playlist profile sync failed:', error)
    socket.moduleReadys.listProfile = false
    socket.close(SYNC_CLOSE_CODE.failed)
  })
}
export const handler = {
  async profile_sync_request(socket: LX.Sync.Server.Socket) {
    if (!socket.feature.listProfile || !socket.moduleReadys.listProfile) throw new Error('Playlist profile sync is not enabled')
    request(socket)
  },
}
export const sync = async(socket: LX.Sync.Server.Socket) => {
  const epoch = generation(socket)
  await run(socket, epoch)
  if (!isCurrent(socket, epoch)) return
  socket.moduleReadys.listProfile = true
  try {
    await socket.remoteQueueListProfile.profile_sync_finished()
  } catch (error) {
    if (isCurrent(socket, epoch)) throw error
    return
  }
  if (!isCurrent(socket, epoch)) return
  request(socket)
}
let unregister: (() => void) | undefined
export const unregisterEvent = () => { unregister?.(); unregister = undefined }
export const registerEvent = (wss: LX.Sync.Server.SocketServer) => {
  unregisterEvent()
  const changed = () => { for (const socket of wss.clients) request(socket) }
  const listChanged = async() => { changed() }
  const remove = onPlaylistMetadataChanged(changed)
  global.lx.event_list.on('list_create', listChanged)
  global.lx.event_list.on('list_remove', listChanged)
  global.lx.event_list.on('list_data_overwrite', listChanged)
  unregister = () => {
    remove()
    global.lx.event_list.off('list_create', listChanged)
    global.lx.event_list.off('list_remove', listChanged)
    global.lx.event_list.off('list_data_overwrite', listChanged)
  }
}
