import { normalizeSnapshot, rebaseSnapshot, type ProfileSnapshot } from '@common/utils/listProfileSync'
import { normalizeProfile } from '@common/utils/listProfile'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { sendEvent } from '@main/modules/winMain/main'

const listeners = new Set<(origin?: object) => void>()
export const notifyPlaylistMetadataChanged = (metadata: LX.List.ListUpdateInfo, origin?: object) => {
  sendEvent(WIN_MAIN_RENDERER_EVENT_NAME.storage_playlist_metadata_changed, metadata)
  for (const listener of listeners) listener(origin)
}
export const onPlaylistMetadataChanged = (listener: (origin?: object) => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const getProfileSnapshot = async(): Promise<ProfileSnapshot> => {
  const [metadata, lists] = await Promise.all([global.lx.worker.dbService.getPlaylistMetadata(), global.lx.worker.dbService.getAllUserList()])
  return normalizeSnapshot({ version: 1, listIds: ['default', 'love', ...lists.map(list => list.id)], profiles: Object.fromEntries(Object.entries(metadata).filter(([, item]) => item.profile).map(([id, item]) => [id, normalizeProfile(item.profile)])) })
}
export const applyProfileSnapshot = async(base: ProfileSnapshot, proposed: ProfileSnapshot, origin?: object) => {
  const next = rebaseSnapshot(await getProfileSnapshot(), proposed, base)
  let metadata = await global.lx.worker.dbService.getPlaylistMetadata()
  let changed = false
  const ids = new Set([...Object.keys(base.profiles), ...Object.keys(next.profiles)])
  for (const id of ids) {
    const current = metadata[id] ?? { updateTime: 0, isAutoUpdate: false }
    const profile = { ...current.profile }
    if (next.profiles[id]) Object.assign(profile, next.profiles[id])
    else {
      delete profile.description
      delete profile.coverUrl
      delete profile.group
      delete profile.createdAt
    }
    if (JSON.stringify(profile) == JSON.stringify(current.profile ?? {})) continue
    changed = true
    metadata = await global.lx.worker.dbService.applyPlaylistMetadata({
      version: 1, action: 'upsert', playlistId: id, base: current, value: { ...current, profile }, updatedAtMs: Date.now(),
    })
  }
  if (changed) notifyPlaylistMetadataChanged(metadata, origin)
  return getProfileSnapshot()
}
