import { ref, shallowReactive } from '@common/utils/vueTools'

export const isQQGuessLikeMode = ref(false)
export const qqGuessLikeQueue = shallowReactive<LX.Music.MusicInfo_tx[]>([])
export const qqGuessLikeOwnerAccountKey = ref<string | null>(null)
export const qqGuessLikeGeneration = ref(0)
export const isLoadingQQGuessLike = ref(false)
