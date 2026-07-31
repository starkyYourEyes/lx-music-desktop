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

export const createDataHandlers = (store: DataStoreAccess) => ({
  get: (path: unknown) => store.get(parseActivityDataKey(path)),
  set: (params: unknown) => {
    if (params == null || typeof params != 'object' || Array.isArray(params)) throw new Error('Invalid activity data update')
    const record = params as Record<string, unknown>
    if (Object.keys(record).length != 2 || !Object.hasOwn(record, 'path') || !Object.hasOwn(record, 'data')) {
      throw new Error('Invalid activity data update')
    }
    store.set(parseActivityDataKey(record.path), record.data)
  },
})

export default () => {
  const handlers = createDataHandlers(getStore(STORE_NAMES.DATA))
  mainHandle<unknown, unknown>(WIN_MAIN_RENDERER_EVENT_NAME.get_data, async({ params }) => handlers.get(params))

  mainOn<unknown>(WIN_MAIN_RENDERER_EVENT_NAME.save_data, ({ params }) => {
    handlers.set(params)
  })
}
