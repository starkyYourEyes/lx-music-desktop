<template lang="pug">
transition(enter-active-class="animated slideInRight" leave-active-class="animated slideOutDown" @after-enter="handleAfterEnter" @after-leave="handleAfterLeave")
  div(v-if="isShowPlayerDetail" :class="[$style.container, { fullscreen: isFullscreen }]" @contextmenu="handleContextMenu")
    div(:class="$style.bg")
    //- div(:class="$style.bg" :style="bgStyle")
    //- div(:class="$style.bg2")
    ControlBtnsLeftHeader(v-if="appSetting['common.controlBtnPosition'] == 'left'")
    ControlBtnsRightHeader(v-else)
    div(:class="[$style.main, {[$style.showComment]: isShowPlayComment}]")
      Turntable(:class="$style.turntable")
      section(:class="$style.lyricPanel")
        header(:class="$style.trackHeader")
          h1(:title="musicInfo.name") {{ musicInfo.name || 'LX Music' }}
          div(:class="$style.trackMeta")
            span(v-if="musicInfo.singer" :title="musicInfo.singer") {{ musicInfo.singer }}
            span(v-if="musicInfo.album" :title="musicInfo.album") {{ musicInfo.album }}
        transition(enter-active-class="animated fadeIn" leave-active-class="animated fadeOut")
          LyricPlayer(v-if="visibled" :class="$style.lyricPlayer")
      music-comment(v-if="visibled" :class="$style.comment" :show="isShowPlayComment" :music-info="playMusicInfo.musicInfo" @close="hideComment")
    transition(enter-active-class="animated fadeIn" leave-active-class="animated fadeOut")
      play-bar(v-if="visibled")
    PartyModal
    transition(enter-active-class="animated-slow fadeIn" leave-active-class="animated-slow fadeOut")
      common-audio-visualizer(v-if="appSetting['player.audioVisualization'] && visibled")
</template>


<script>
import { ref, watch } from '@common/utils/vueTools'
import { isFullscreen } from '@renderer/store'
import {
  isShowPlayerDetail,
  isShowPlayComment,
  musicInfo,
  playMusicInfo,
} from '@renderer/store/player/state'
import {
  setShowPlayerDetail,
  setShowPlayComment,
  setShowPlayLrcSelectContentLrc,
} from '@renderer/store/player/action'
import LyricPlayer from './LyricPlayer.vue'
import PlayBar from './PlayBar.vue'
import Turntable from './Turntable.vue'
import PartyModal from './PartyModal.vue'
import MusicComment from './components/MusicComment/index.vue'
import ControlBtnsLeftHeader from './ControlBtnsLeftHeader.vue'
import ControlBtnsRightHeader from './ControlBtnsRightHeader.vue'
import { registerAutoHideMounse, unregisterAutoHideMounse } from './autoHideMounse'
import { appSetting } from '@renderer/store/setting'
import { closeWindow, maxWindow, minWindow, setFullScreen } from '@renderer/utils/ipc'

export default {
  name: 'CorePlayDetail',
  components: {
    ControlBtnsLeftHeader,
    ControlBtnsRightHeader,
    LyricPlayer,
    PlayBar,
    Turntable,
    PartyModal,
    MusicComment,
  },
  setup() {
    const visibled = ref(false)

    let clickTime = 0

    const hide = () => {
      setShowPlayerDetail(false)
    }
    const handleContextMenu = () => {
      if (window.performance.now() - clickTime > 400) {
        clickTime = window.performance.now()
        return
      }
      clickTime = 0
      hide()
    }

    const hideComment = () => {
      setShowPlayComment(false)
    }

    const handleAfterEnter = () => {
      if (isFullscreen.value) registerAutoHideMounse()

      visibled.value = true
    }

    const handleAfterLeave = () => {
      setShowPlayLrcSelectContentLrc(false)
      hideComment(false)
      visibled.value = false

      unregisterAutoHideMounse()
    }

    watch(isFullscreen, isFullscreen => {
      (isFullscreen ? registerAutoHideMounse : unregisterAutoHideMounse)()
    })


    return {
      appSetting,
      playMusicInfo,
      isShowPlayerDetail,
      isShowPlayComment,
      musicInfo,
      hide,
      handleContextMenu,
      hideComment,
      handleAfterEnter,
      handleAfterLeave,
      visibled,
      isFullscreen,
      fullscreenExit() {
        void setFullScreen(false).then((fullscreen) => {
          isFullscreen.value = fullscreen
        })
      },
      min() {
        minWindow()
      },
      max() {
        maxWindow()
      },
      close() {
        closeWindow()
      },
    }
  },
}
</script>


<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

@control-btn-width: @height-toolbar * .26;

:global(.auto-hide-cursor),
:global(.auto-hide-cursor *) {
  cursor: none !important;
}

.container {
  position: absolute;
  display: flex;
  flex-flow: column nowrap;
  width: 100%;
  height: 100%;
  top: 0;
  left: 0;
  background-color: var(--color-content-background);
  z-index: 10;
  // -webkit-app-region: drag;
  overflow: hidden;
  border-radius: @radius-border;
  color: var(--color-font);
  // border-left: 12px solid var(--color-primary-alpha-900);
  -webkit-app-region: no-drag;
  contain: strict;

  box-sizing: border-box;

  * {
    box-sizing: border-box;
  }
}
.bg {
  position: absolute;
  width: 100%;
  height: 100%;
  top: 0;
  left: 0;
  background: var(--background-image) var(--background-image-position) no-repeat;
  background-size: var(--background-image-size);
  // background-size: 110% 110%;
  // filter: blur(60px);
  opacity: .82;
  filter: saturate(.78);
  z-index: -1;
  &:before {
    content: '';
    display: block;
    width: 100%;
    height: 100%;
    background-color: var(--color-app-background);
  }
  &:after {
    position: absolute;
    left: 0;
    top: 0;
    content: '';
    display: block;
    width: 100%;
    height: 100%;
    background-color: var(--color-main-background);
  }
}
// .bg2 {
//   position: absolute;
//   width: 100%;
//   height: 100%;
//   top: 0;
//   left: 0;
//   z-index: -1;
//   background-color: rgba(255, 255, 255, .8);
// }

.main {
  flex: auto;
  min-height: 0;
  overflow: hidden;
  display: flex;
  gap: clamp(18px, 3vw, 52px);
  margin: 0 clamp(20px, 4vw, 68px);
  position: relative;

  &.showComment {
    gap: 16px;

    .turntable {
      flex-basis: 18%;
    }

    .lyricPanel {
      flex: 0 0 30%;
    }

    .trackHeader {
      h1 {
        font-size: clamp(16px, 2vw, 22px);
      }
    }

    .comment {
      opacity: 1;
      pointer-events: auto;
      transform: scaleX(1);
    }

    :global(.lyricSelectContent) {
      font-size: 14px;
    }
  }
}

.turntable {
  flex: 0 1 40%;
  min-width: 0;
  transition: flex-basis @transition-normal;
}

.lyricPanel {
  flex: 1 1 60%;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  transition: flex-basis @transition-normal;
}

.trackHeader {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 9px;
  padding: clamp(8px, 2vh, 20px) 20px clamp(12px, 2vh, 22px);

  h1 {
    margin: 0;
    width: 100%;
    overflow: hidden;
    color: var(--color-font);
    font-size: clamp(22px, 3vw, 34px);
    font-weight: 650;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.trackMeta {
  display: flex;
  min-width: 0;
  width: 100%;
  justify-content: center;
  gap: 18px;
  color: var(--color-font-label);

  span {
    min-width: 0;
    overflow: hidden;
    font-size: 13px;
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;

    + span::before {
      content: '·';
      margin-right: 18px;
      opacity: .6;
    }
  }
}

.lyricPlayer {
  flex: auto;
  min-height: 0;
}

.comment {
  position: absolute;
  right: 0;
  top: 0;
  width: calc(50% - 12px);
  height: 100%;
  opacity: 0;
  pointer-events: none;
  transform: scaleX(0);
}

@media (max-width: 900px) {
  .main {
    gap: 16px;
    margin: 0 18px;
  }

  .turntable {
    flex-basis: 36%;
  }

  .lyricPanel {
    flex-basis: 64%;
  }

  .trackMeta {
    gap: 8px;

    span + span::before {
      margin-right: 8px;
    }
  }
}

@media (max-height: 650px) {
  .trackHeader {
    gap: 5px;
    padding-top: 0;
    padding-bottom: 8px;
  }
}

:global(.fullscreen) {
  .main {
    margin: 0 clamp(28px, 6vw, 110px);
  }
}

</style>
