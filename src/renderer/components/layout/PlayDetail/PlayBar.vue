<template>
  <div :class="$style.footer">
    <div :class="$style.footerLeft">
      <control-btns />
      <div :class="$style.progressContainer">
        <div :class="$style.progressContent">
          <common-progress-bar
            :class-name="$style.progress"
            :progress="progress"
            :handle-transition-end="handleTransitionEnd"
            :is-active-transition="isActiveTransition"
          />
        </div>
      </div>
      <div :class="$style.timeLabel"><span :class="$style.status" style="margin-right: 15px">{{ status }}</span><span>{{ nowPlayTimeStr }}</span><span style="margin: 0 5px;">/</span><span>{{ maxPlayTimeStr }}</span></div>
    </div>
    <div :class="$style.playControl">
      <div :class="[$style.playBtn, { [$style.playBtnActive]: isShowPlayQueue }]" :aria-label="$t('player__play_queue')" @click="isShowPlayQueue = !isShowPlayQueue">
        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" height="100%" viewBox="0 0 24 24" space="preserve">
          <use xlink:href="#icon-play-queue" />
        </svg>
      </div>
      <div :class="$style.playBtn" :aria-label="$t('player__prev')" @click="playPrev()">
        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" height="100%" viewBox="0 0 1024 1024" space="preserve">
          <use xlink:href="#icon-prevMusic" />
        </svg>
      </div>
      <div :class="$style.playBtn" :aria-label="isPlay ? $t('player__pause') : $t('player__play')" @click="togglePlay">
        <svg v-if="isPlay" version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" height="100%" viewBox="0 0 1024 1024" space="preserve">
          <use xlink:href="#icon-pause" />
        </svg>
        <svg v-else version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" height="100%" viewBox="0 0 1024 1024" space="preserve">
          <use xlink:href="#icon-play" />
        </svg>
      </div>
      <div :class="$style.playBtn" :aria-label="$t('player__next')" @click="playNext()">
        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" height="100%" viewBox="0 0 1024 1024" space="preserve">
          <use xlink:href="#icon-nextMusic" />
        </svg>
      </div>
      <button type="button" :class="[$style.partyBtn, {[$style.partyBtnActive]: !!party.room}]" @click="party.isShowModal = true">
        <span :class="$style.partyDot" />
        <span>{{ party.room ? `房间 ${party.room.roomCode}` : '一起听' }}</span>
      </button>
    </div>
    <play-queue v-model:show="isShowPlayQueue" />
  </div>
</template>

<script setup>
import { ref } from '@common/utils/vueTools'
import { playNext, playPrev, togglePlay } from '@renderer/core/player'
import { party } from '@renderer/store/party'
import { status, isPlay } from '@renderer/store/player/state'
import usePlayProgress from '@renderer/utils/compositions/usePlayProgress'

import ControlBtns from './components/ControlBtns.vue'
import PlayQueue from '../PlayQueue.vue'

const isShowPlayQueue = ref(false)
const {
  nowPlayTimeStr,
  maxPlayTimeStr,
  progress,
  isActiveTransition,
  handleTransitionEnd,
} = usePlayProgress()

</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.footer {
  flex: 0 0 100px;
  overflow: hidden;
  display: flex;
  align-items: center;
}
.footerLeft {
  flex: auto;
  display: flex;
  flex-flow: column nowrap;
  padding: 13px 13px 13px 30px;
  overflow: hidden;
}

.progressContainer {
  width: 100%;
  position: relative;
  padding: 3px 0;
}

.progressContent {
  position: relative;
  height: 16px;
  padding: 5px 0;
  width: 100%;
}
.progress {
  height: 100%;
}

.barTransition {
  transition-property: transform;
  transition-timing-function: ease-out;
  transition-duration: 0.2s;
}
.timeLabel {
  width: 100%;
  height: 18px;
  display: flex;
  span {
    font-size: 13px;
  }
}
.status {
  flex: auto;
}

.playControl {
  flex: none;
  height: 100%;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 0 25px;
  color: var(--color-button-font);
}
.partyBtn {
  margin-left: 14px;
  border: none;
  outline: none;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 10px 16px;
  border-radius: 999px;
  cursor: pointer;
  color: var(--color-button-font);
  background:
    linear-gradient(135deg, var(--color-primary-light-100-alpha-800), var(--color-main-background));
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.12);
  transition: transform 0.2s ease, opacity 0.2s ease, box-shadow 0.2s ease;
  font-size: 13px;
  white-space: nowrap;

  &:hover {
    opacity: 0.92;
    transform: translateY(-1px);
  }

  &:active {
    opacity: 0.84;
    transform: translateY(0);
  }
}

.partyBtnActive {
  box-shadow: 0 12px 26px rgba(0, 0, 0, 0.18);
}

.partyDot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: linear-gradient(135deg, #19c37d, #47d1ff);
  box-shadow: 0 0 0 4px rgba(25, 195, 125, 0.14);
}
.playBtn {
  height: 40%;
  padding: 5px;
  cursor: pointer;
  flex: none;
  // transition: @transition-normal;
  // transition-property: color;
  color: var(--color-button-font);
  transition: opacity 0.2s ease;
  opacity: 1;
  cursor: pointer;

  +.playBtn {
    margin-left: 10px;
  }
  svg {
    fill: currentColor;
    filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.2));
  }
  &:hover {
    opacity: 0.8;
  }
  &:active {
    opacity: 0.6;
  }
}

.playBtnActive {
  opacity: 1;
  color: var(--color-primary);
}

</style>
