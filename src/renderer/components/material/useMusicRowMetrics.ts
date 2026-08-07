import { computed } from '@common/utils/vueTools'
import { isFullscreen } from '@renderer/store'
import { appSetting } from '@renderer/store/setting'
import { getFontSizeWithScreen } from '@renderer/utils'

export const calculateMusicRowMetrics = (fontSize: number) => {
  const rowHeight = Math.round(Math.min(72, Math.max(52, fontSize * 3.75)))
  return { rowHeight, artworkSize: rowHeight - 16 }
}

export const useMusicRowMetrics = () => {
  const metrics = computed(() => calculateMusicRowMetrics(
    isFullscreen.value ? getFontSizeWithScreen() : appSetting['common.fontSize'],
  ))

  return {
    listItemHeight: computed(() => metrics.value.rowHeight),
    artworkSize: computed(() => metrics.value.artworkSize),
  }
}
