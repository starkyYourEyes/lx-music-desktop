import { STORE_NAMES } from '@common/constants'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainOn, mainHandle } from '@common/mainIpc'
import getStore from '@main/utils/store'

const activityDataKeys = new Set(['playInfo', 'recentPlayList', 'listeningTimeStats'])

type ActivityDataKey = 'playInfo' | 'recentPlayList' | 'listeningTimeStats'

const parseActivityDataKey = (value: unknown): ActivityDataKey => {
  if (typeof value != 'string' || !activityDataKeys.has(value)) throw new Error('Invalid activity data key')
  return value as ActivityDataKey
}

interface DataStoreAccess {
  get: (key: ActivityDataKey) => unknown
  set: (key: ActivityDataKey, value: unknown) => void
}

interface PlaybackActivityMarker {
  name: string
  sourceSha256: string
  completedAtMs: number
  detailsJson: string
}

interface DataHandlerDependencies {
  getPlaybackActivityMigrationMarker: () => Promise<PlaybackActivityMarker | null>
}

const playbackActivityMarkerName = 'legacy_data_v1.playback_activity'
const sha256Pattern = /^[a-f0-9]{64}$/

const isAuthoritativePlaybackActivityMarker = (marker: PlaybackActivityMarker | null): boolean =>
  marker != null && marker.name == playbackActivityMarkerName &&
  sha256Pattern.test(marker.sourceSha256) &&
  Number.isSafeInteger(marker.completedAtMs) && marker.completedAtMs >= 0 &&
  typeof marker.detailsJson == 'string'

export const createDataHandlers = (store: DataStoreAccess, dependencies: DataHandlerDependencies) => {
  let markerCheck: Promise<boolean> | null = null
  const getLegacyActivityDisabled = async(): Promise<boolean> => {
    if (markerCheck != null) return markerCheck
    markerCheck = Promise.resolve()
      .then(async() => dependencies.getPlaybackActivityMigrationMarker())
      .then(marker => {
        const disabled = isAuthoritativePlaybackActivityMarker(marker)
        if (!disabled) markerCheck = null
        return disabled
      })
      .catch(error => {
        markerCheck = null
        throw error
      })
    return markerCheck
  }
  const assertLegacyActivityEnabled = async(): Promise<void> => {
    if (await getLegacyActivityDisabled()) throw new Error('legacy_activity_disabled')
  }

  return {
    get: async(path: unknown) => {
      const key = parseActivityDataKey(path)
      await assertLegacyActivityEnabled()
      return store.get(key)
    },
    set: async(params: unknown) => {
      if (params == null || typeof params != 'object' || Array.isArray(params)) throw new Error('Invalid activity data update')
      const record = params as Record<string, unknown>
      if (Object.keys(record).length != 2 || !Object.hasOwn(record, 'path') || !Object.hasOwn(record, 'data')) {
        throw new Error('Invalid activity data update')
      }
      const key = parseActivityDataKey(record.path)
      await assertLegacyActivityEnabled()
      store.set(key, record.data)
    },
  }
}

export default () => {
  const handlers = createDataHandlers(getStore(STORE_NAMES.DATA), {
    getPlaybackActivityMigrationMarker: async() => global.lx.worker.dbService.getPlaybackActivityMigrationMarker(),
  })
  mainHandle<unknown, unknown>(WIN_MAIN_RENDERER_EVENT_NAME.get_data, async({ params }) => handlers.get(params))

  mainOn<unknown>(WIN_MAIN_RENDERER_EVENT_NAME.save_data, ({ params }) => {
    void handlers.set(params).catch(error => {
      if (!(error instanceof Error) || error.message != 'legacy_activity_disabled') console.error(error)
    })
  })
}
