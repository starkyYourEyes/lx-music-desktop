import {
  isSyncClientServersFileV1,
  isSyncServerDevicesFileV2,
  type SyncClientServersFileV1,
  type SyncServerDevicesFileV2,
} from '../../../common/storage/syncMetadata'

export type VersionedSyncMetadataKind = 'sync-client-v1' | 'sync-server-v2'
export type VersionedSyncMetadataDocument = SyncClientServersFileV1 | SyncServerDevicesFileV2

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value)

export const preflightVersionedSyncMetadata = (
  kind: VersionedSyncMetadataKind,
  value: unknown,
): VersionedSyncMetadataDocument | null => {
  const projected = structuredClone(value)
  if (!isRecord(projected)) return null
  const entries = kind == 'sync-client-v1' ? projected.servers : projected.clients
  if (isRecord(entries)) {
    for (const entry of Object.values(entries)) {
      if (isRecord(entry)) Reflect.deleteProperty(entry, 'key')
    }
  }
  return kind == 'sync-client-v1'
    ? isSyncClientServersFileV1(projected) ? projected : null
    : isSyncServerDevicesFileV2(projected) ? projected : null
}
