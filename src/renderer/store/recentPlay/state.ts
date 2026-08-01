import { shallowReactive } from '@common/utils/vueTools'
import type { RecentTrackV1 } from '@common/storage/playback'

export const recentPlayList = shallowReactive<RecentTrackV1[]>([])
