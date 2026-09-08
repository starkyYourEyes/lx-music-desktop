import { reactive } from '@common/utils/vueTools'
import type { PlatformPlaylistGroup, PlatformPlaylistGroupKey } from './types'

export const platformPlaylistStatuses = reactive<Record<PlatformPlaylistGroupKey, PlatformPlaylistGroup>>({
  'netease:created': { provider: 'netease', kind: 'created', accountKey: null, lastAccountKey: null, status: 'idle', lists: [] },
  'netease:collected': { provider: 'netease', kind: 'collected', accountKey: null, lastAccountKey: null, status: 'idle', lists: [] },
  'qq_music:created': { provider: 'qq_music', kind: 'created', accountKey: null, lastAccountKey: null, status: 'idle', lists: [] },
  'qq_music:collected': { provider: 'qq_music', kind: 'collected', accountKey: null, lastAccountKey: null, status: 'idle', lists: [] },
  'kugou:created': { provider: 'kugou', kind: 'created', accountKey: null, lastAccountKey: null, status: 'idle', lists: [] },
  'kugou:collected': { provider: 'kugou', kind: 'collected', accountKey: null, lastAccountKey: null, status: 'idle', lists: [] },
})
