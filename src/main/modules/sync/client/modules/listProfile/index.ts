import { getProfileSnapshot, applyProfileSnapshot, onPlaylistMetadataChanged } from '@main/modules/sync/listProfileEvent'
import { SYNC_CLOSE_CODE } from '@common/constants_sync'

interface Registration {
  socket: LX.Sync.Client.Socket
  dirty: boolean
  requestPromise?: Promise<void>
  removeListeners: () => void
}

let registration: Registration | undefined

const request = (current: Registration) => {
  if (registration !== current || !current.socket.moduleReadys?.listProfile || !current.socket.moduleReadys.list) return
  current.dirty = true
  if (current.requestPromise) return
  current.requestPromise = (async() => {
    while (current.dirty) {
      if (registration !== current || !current.socket.moduleReadys.listProfile) break
      current.dirty = false
      await current.socket.remoteQueueListProfile.profile_sync_request()
    }
  })().catch(() => {
    if (registration !== current) return
    current.socket.moduleReadys.listProfile = false
    current.socket.close(SYNC_CLOSE_CODE.failed)
  }).finally(() => {
    current.requestPromise = undefined
  })
}

const removeRegistration = (current: Registration) => {
  if (registration !== current) return
  registration = undefined
  current.removeListeners()
}

export const unregisterEvent = () => {
  if (registration) removeRegistration(registration)
}

export const registerEvent = (socket: LX.Sync.Client.Socket) => {
  unregisterEvent()
  const removers: Array<() => void> = []
  const current: Registration = {
    socket,
    dirty: false,
    removeListeners: () => { for (const remove of removers) remove() },
  }
  registration = current
  const changed = async() => { request(current) }
  removers.push(onPlaylistMetadataChanged(origin => {
    // Suppress only this connection's echo; local edits during an apply still sync.
    if (origin !== socket) request(current)
  }))
  for (const eventName of ['list_create', 'list_remove', 'list_data_overwrite'] as const) {
    global.lx.event_list.on(eventName, changed)
    removers.push(() => { global.lx.event_list.off(eventName, changed) })
  }
  return () => { removeRegistration(current) }
}

export const handler = {
  async profile_sync_get(socket: LX.Sync.Client.Socket) {
    if (!socket.moduleReadys.list) throw new Error('Playlist sync is not ready')
    return getProfileSnapshot()
  },
  async profile_sync_apply(socket: LX.Sync.Client.Socket, base: LX.Sync.ProfileSnapshot, next: LX.Sync.ProfileSnapshot) {
    if (!socket.moduleReadys.list) throw new Error('Playlist sync is not ready')
    return applyProfileSnapshot(base, next, socket)
  },
  async profile_sync_finished(socket: LX.Sync.Client.Socket) {
    if (!socket.moduleReadys.list) throw new Error('Playlist sync is not ready')
    socket.moduleReadys.listProfile = true
    const remove = registerEvent(socket)
    socket.onClose(remove)
  },
}
