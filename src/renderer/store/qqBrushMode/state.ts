import { ref, shallowReactive } from '@common/utils/vueTools'

export const isQQBrushMode = ref(false)
export const qqBrushModeQueue = shallowReactive<LX.Music.MusicInfo_tx[]>([])
export const qqBrushModeOwnerAccountKey = ref<string | null>(null)
export const qqBrushModeGeneration = ref(0)
export const isLoadingQQBrushMode = ref(false)
