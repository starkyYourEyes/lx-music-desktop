import { computed, ref, shallowReactive } from '@common/utils/vueTools'

export const PRIVATE_FM_LIST_ID = 'wy_private_fm'
export const PRIVATE_FM_TEMP_LIST_ID = `wy__${PRIVATE_FM_LIST_ID}`

export const privateFmModes: Array<{
  id: LX.Netease.PrivateFmModeId
  name: string
  icon: string
}> = [
  { id: 'DEFAULT', name: '默认漫游', icon: '#icon-fm-infinity' },
  { id: 'FAMILIAR', name: '熟悉漫游', icon: '#icon-fm-familiar' },
  { id: 'EXPLORE', name: '探索漫游', icon: '#icon-fm-explore' },
  { id: 'EXERCISE', name: '运动漫游', icon: '#icon-fm-exercise' },
  { id: 'FOCUS', name: '专注漫游', icon: '#icon-fm-focus' },
  { id: 'NIGHT_EMO', name: '夜晚漫游', icon: '#icon-fm-night' },
]

export const isPrivateFmMode = ref(false)
export const privateFmModeId = ref<LX.Netease.PrivateFmModeId>('DEFAULT')
export const privateFmQueue = shallowReactive<LX.Music.MusicInfoOnline[]>([])
export const isLoadingPrivateFm = ref(false)

export const currentPrivateFmMode = computed(() => {
  return privateFmModes.find(mode => mode.id == privateFmModeId.value) ?? privateFmModes[0]
})
