import { onBeforeUnmount } from '@common/utils/vueTools'
import {
  createAudio,
} from '@renderer/plugins/player'
import {
  disposePlaybackActionController,
  initializePlaybackActionController,
} from '@renderer/core/player'
import useMediaDevice from './useMediaDevice'
import usePlayerEvent from './usePlayerEvent'
import usePlayer from './usePlayer'
import usePlayStatus from './usePlayStatus'

export default () => {
  createAudio()
  initializePlaybackActionController()

  usePlayerEvent()
  useMediaDevice() // 初始化音频驱动输出设置
  usePlayer()
  const initPlayStatus = usePlayStatus()

  onBeforeUnmount(() => {
    disposePlaybackActionController()
  })

  return () => {
    void initPlayStatus()
  }
}

