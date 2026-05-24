<template>
  <div :class="$style.player">
    <div v-if="progressStyle == 'full'" :class="$style.progressTop">
      <common-progress-bar v-if="!isShowPlayerDetail" :class-name="$style.progressBar" :progress="progress" :handle-transition-end="handleTransitionEnd" :is-active-transition="isActiveTransition" />
    </div>

    <div :class="$style.trackSection">
      <div :class="$style.picContent" :aria-label="$t('player__pic_tip')" @contextmenu="handleToMusicLocation" @click="showPlayerDetail">
        <img v-if="musicInfo.pic" :src="musicInfo.pic" decoding="async" @error="imgError">
        <div v-else :class="$style.emptyPic">L<span>X</span></div>
      </div>
      <div :class="$style.infoContent">
        <div :class="$style.title" :aria-label="musicInfo.name + $t('copy_tip')" @click="handleCopy(musicInfo.name)">
          {{ musicInfo.name || 'LX Music' }}
        </div>
        <div :class="$style.singer" :aria-label="musicInfo.singer + $t('copy_tip')" @click="handleCopy(musicInfo.singer)">
          {{ musicInfo.singer || statusText }}
        </div>
      </div>
      <control-btns show-favorite :show-add-to="false" :show-lyric="false" :show-volume="false" :show-play-mode="false" compact />
    </div>

    <div :class="$style.centerSection">
      <control-btns :show-favorite="false" :show-add-to="false" :show-lyric="false" :show-volume="false" show-play-mode compact />
      <div :class="$style.playButtons">
        <button type="button" :class="$style.playBtn" :aria-label="$t('player__prev')" @click="playPrev()">
          <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024" space="preserve">
            <use xlink:href="#icon-prevMusic" />
          </svg>
        </button>
        <button type="button" :class="$style.playBtn" :aria-label="isPlay ? $t('player__pause') : $t('player__play')" @click="togglePlay">
          <svg v-if="isPlay" version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024" space="preserve">
            <use xlink:href="#icon-pause" />
          </svg>
          <svg v-else version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024" space="preserve">
            <use xlink:href="#icon-play" />
          </svg>
        </button>
        <button type="button" :class="$style.playBtn" :aria-label="$t('player__next')" @click="playNext()">
          <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024" space="preserve">
            <use xlink:href="#icon-nextMusic" />
          </svg>
        </button>
      </div>
      <button
        v-if="isPrivateFmMode"
        type="button"
        :class="[$style.queueBtn, $style.privateFmTrashBtn, { [$style.queueBtnActive]: isTrashingPrivateFm }]"
        :aria-label="$t('player__private_fm_trash')"
        :disabled="isTrashingPrivateFm || !playMusicInfo.musicInfo"
        @click="handleTrashPrivateFmMusic"
      >
        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" space="preserve">
          <use xlink:href="#icon-fm-trash" />
        </svg>
      </button>
      <button v-else type="button" :class="[$style.queueBtn, { [$style.queueBtnActive]: isShowPlayQueue }]" :aria-label="$t('player__play_queue')" @click="isShowPlayQueue = !isShowPlayQueue">
        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" space="preserve">
          <use xlink:href="#icon-play-queue" />
        </svg>
      </button>
    </div>

    <div :class="$style.rightSection">
      <div v-if="progressStyle == 'middle'" :class="$style.middleProgress">
        <span>{{ nowPlayTimeStr }}</span>
        <div :class="$style.middleProgressBar">
          <common-progress-bar v-if="!isShowPlayerDetail" :class-name="$style.progressBar" :progress="progress" :handle-transition-end="handleTransitionEnd" :is-active-transition="isActiveTransition" />
        </div>
        <span>{{ maxPlayTimeStr }}</span>
      </div>
      <play-progress v-else-if="progressStyle == 'mini'" />
      <button type="button" :class="[$style.partyBtn, {[$style.partyBtnActive]: !!party.room}]" @click="party.isShowModal = true">
        <span :class="$style.partyDot" />
        <span>{{ party.room ? `房间 ${party.room.roomCode}` : '一起听' }}</span>
      </button>
      <control-btns :show-favorite="false" :show-play-mode="false" />
    </div>

    <play-queue v-if="!isPrivateFmMode" v-model:show="isShowPlayQueue" />
  </div>
</template>

<script>
import { ref, watch } from '@common/utils/vueTools'
import { useRouter } from '@common/utils/vueRouter'
import { clipboardWriteText } from '@common/utils/electron'
import ControlBtns from './ControlBtns.vue'
import PlayProgress from './PlayProgress.vue'
import PlayQueue from '../PlayQueue.vue'
import usePlayProgress from '@renderer/utils/compositions/usePlayProgress'
import {
  statusText,
  musicInfo,
  isShowPlayerDetail,
  isPlay,
  playInfo,
  playMusicInfo,
} from '@renderer/store/player/state'
import {
  setMusicInfo,
  setShowPlayerDetail,
} from '@renderer/store/player/action'
import { togglePlay, playNext, playPrev } from '@renderer/core/player'
import { LIST_IDS } from '@common/constants'
import { party } from '@renderer/store/party'
import { isPrivateFmMode } from '@renderer/store/privateFm/state'
import { trashNeteasePrivateFmMusic } from '@renderer/utils/ipc'

export default {
  name: 'ModernPlayBar',
  components: {
    ControlBtns,
    PlayProgress,
    PlayQueue,
  },
  props: {
    progressStyle: {
      type: String,
      default: 'mini',
    },
  },
  setup() {
    const router = useRouter()
    const isShowPlayQueue = ref(false)
    const isTrashingPrivateFm = ref(false)
    const {
      nowPlayTimeStr,
      maxPlayTimeStr,
      progress,
      isActiveTransition,
      handleTransitionEnd,
    } = usePlayProgress()

    const showPlayerDetail = () => {
      if (!playMusicInfo.musicInfo) return
      setShowPlayerDetail(true)
    }

    const handleCopy = (text) => {
      if (!text) return
      clipboardWriteText(text)
    }

    const imgError = () => {
      setMusicInfo({ pic: null })
    }

    const handleToMusicLocation = () => {
      const listId = playMusicInfo.listId
      if (!listId || listId == LIST_IDS.DOWNLOAD || !playMusicInfo.musicInfo) return
      if (playInfo.playIndex == -1) return
      void router.push({
        path: '/list',
        query: {
          id: listId,
          scrollIndex: playInfo.playIndex,
        },
      })
    }

    const getCurrentMusicInfo = () => {
      const currentMusicInfo = playMusicInfo.musicInfo
      if (!currentMusicInfo) return null
      return 'progress' in currentMusicInfo ? currentMusicInfo.metadata.musicInfo : currentMusicInfo
    }

    const handleTrashPrivateFmMusic = async() => {
      if (isTrashingPrivateFm.value) return
      const currentMusicInfo = getCurrentMusicInfo()
      if (!currentMusicInfo) return

      isTrashingPrivateFm.value = true
      try {
        await trashNeteasePrivateFmMusic(currentMusicInfo)
        await playNext(true)
      } catch (err) {
        console.warn('Trash private FM music failed:', err)
      } finally {
        isTrashingPrivateFm.value = false
      }
    }

    watch(isPrivateFmMode, isFmMode => {
      if (isFmMode) isShowPlayQueue.value = false
    })

    return {
      musicInfo,
      playMusicInfo,
      nowPlayTimeStr,
      maxPlayTimeStr,
      progress,
      isActiveTransition,
      handleTransitionEnd,
      handleCopy,
      imgError,
      statusText,
      showPlayerDetail,
      isPlay,
      togglePlay,
      playNext,
      playPrev,
      handleToMusicLocation,
      isShowPlayerDetail,
      isShowPlayQueue,
      isPrivateFmMode,
      isTrashingPrivateFm,
      handleTrashPrivateFmMusic,
      party,
    }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.player {
  position: relative;
  height: @height-player;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: minmax(250px, 1fr) minmax(260px, auto) minmax(250px, 1fr);
  align-items: center;
  gap: 18px;
  contain: strict;
  padding: 9px 24px 9px;
  z-index: 2;

  * {
    box-sizing: border-box;
  }

  &:before {
    .mixin-after();
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    background-color: var(--color-surface-background);
    backdrop-filter: saturate(180%) blur(24px);
    border-top: 1px solid rgba(128, 128, 128, 0.12);
    z-index: -1;
  }
}

.progressTop {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  padding-bottom: 6px;

  .progressBar {
    height: 2px;
    border-radius: 0;
  }
}

.trackSection,
.centerSection,
.rightSection {
  min-width: 0;
  display: flex;
  align-items: center;
}

.trackSection {
  justify-self: stretch;
  gap: 10px;
}

.centerSection {
  justify-self: center;
  justify-content: center;
  gap: 18px;
}

.rightSection {
  justify-self: end;
  justify-content: flex-end;
  gap: 14px;
}

.picContent {
  flex: none;
  width: 54px;
  height: 54px;
  display: flex;
  justify-content: center;
  cursor: pointer;
  opacity: 1;
  transition: opacity @transition-fast;

  &:hover {
    opacity: .82;
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 50%;
    box-shadow: 0 8px 18px rgba(0, 0, 0, 0.16);
  }
}

.emptyPic {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background-color: var(--color-primary-light-900-alpha-200);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-primary-light-400-alpha-200);
  user-select: none;
  font-size: 19px;
  font-family: Consolas, "Courier New", monospace;

  span {
    padding-left: 3px;
  }
}

.infoContent {
  flex: 0 1 auto;
  min-width: 86px;
  max-width: min(240px, calc(100% - 108px));
  display: flex;
  flex-flow: column nowrap;
  justify-content: center;
  align-items: flex-start;
  line-height: 1.4;
}

.title {
  max-width: 100%;
  font-size: 14px;
  color: var(--color-font);
  .mixin-ellipsis-1();
  cursor: default;
}

.singer {
  max-width: 100%;
  margin-top: 3px;
  font-size: 12px;
  color: var(--color-font-label);
  .mixin-ellipsis-1();
  cursor: default;
}

.playButtons {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
}

.playBtn,
.queueBtn {
  flex: none;
  border: none;
  background-color: transparent;
  color: var(--color-button-font);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: opacity @transition-fast, color @transition-fast, background-color @transition-fast, transform @transition-fast;

  svg {
    width: 100%;
    height: 100%;
    fill: currentColor;
    filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.2));
  }

  &:hover {
    opacity: .82;
  }

  &:active {
    opacity: .68;
    transform: scale(.97);
  }
}

.playBtn {
  width: 34px;
  height: 34px;
  padding: 4px;
}

.queueBtn {
  width: 30px;
  height: 30px;
  padding: 3px;
}

.queueBtnActive {
  color: var(--color-primary);
}

.privateFmTrashBtn:disabled {
  cursor: default;
  opacity: .42;
  transform: none;
}

.middleProgress {
  flex: 0 1 260px;
  min-width: 160px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-550);
  font-size: 12px;
}

.middleProgressBar {
  flex: 1 1 auto;
  min-width: 80px;
  position: relative;
  padding: 8px 0;

  .progressBar {
    height: 4px;
  }
}

.partyBtn {
  flex: none;
  border: none;
  outline: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  cursor: pointer;
  color: var(--color-button-font);
  background-color: rgba(255, 255, 255, 0.26);
  transition: opacity @transition-fast, background-color @transition-fast;
  font-size: 12px;
  white-space: nowrap;

  &:hover {
    opacity: 0.9;
    background-color: rgba(255, 255, 255, 0.42);
  }

  &:active {
    opacity: 0.76;
  }
}

.partyBtnActive {
  color: var(--color-primary);
}

.partyDot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: linear-gradient(135deg, #19c37d, #47d1ff);
  box-shadow: 0 0 0 4px rgba(25, 195, 125, 0.14);
}

@media (max-width: 980px) {
  .player {
    grid-template-columns: minmax(180px, 1fr) auto auto;
    gap: 12px;
    padding-left: 14px;
    padding-right: 14px;
  }

  .rightSection {
    gap: 8px;
  }

  .partyBtn,
  .middleProgress {
    display: none;
  }
}

@media (max-width: 720px) {
  .player {
    grid-template-columns: minmax(130px, 1fr) auto;
  }

  .centerSection {
    gap: 12px;
  }

  .rightSection {
    display: none;
  }

  .playButtons {
    gap: 10px;
  }

  .playBtn {
    width: 30px;
    height: 30px;
  }

  .queueBtn {
    width: 26px;
    height: 26px;
  }
}

</style>
