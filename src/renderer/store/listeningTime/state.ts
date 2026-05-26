import { reactive } from '@common/utils/vueTools'
import { createDefaultListeningTimeStats } from '@common/utils/listeningTime'

export const listeningTimeStats = reactive(createDefaultListeningTimeStats())
