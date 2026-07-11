<template>
  <div :class="$style.footer">
    <div :class="$style.progressTrack">
      <common-progress-bar
        :class-name="$style.progress"
        :progress="progress"
        :handle-transition-end="handleTransitionEnd"
        :is-active-transition="isActiveTransition"
      />
    </div>
    <div :class="$style.footerLeft">
      <span :class="$style.status">{{ status }}</span>
      <span :class="$style.time">{{ nowPlayTimeStr }} / {{ maxPlayTimeStr }}</span>
    </div>
    <div :class="$style.footerCenter">
      <button type="button" :class="$style.playBtn" :aria-label="$t('player__prev')" @click="playPrev()">
        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024" space="preserve">
          <use xlink:href="#icon-prevMusic" />
        </svg>
      </button>
      <button type="button" :class="[$style.playBtn, $style.playBtnPrimary]" :aria-label="isPlay ? $t('player__pause') : $t('player__play')" @click="togglePlay">
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
      <button type="button" :class="[$style.playBtn, $style.queueBtn, { [$style.playBtnActive]: isShowPlayQueue }]" :aria-label="$t('player__play_queue')" @click="isShowPlayQueue = !isShowPlayQueue">
        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" space="preserve">
          <use xlink:href="#icon-play-queue" />
        </svg>
      </button>
    </div>
    <div :class="$style.footerRight">
      <control-btns />
      <button type="button" :class="[$style.partyBtn, {[$style.partyBtnActive]: !!party.room}]" @click="party.isShowModal = true">
        <span :class="$style.partyDot" />
        <span :class="$style.partyLabel">{{ party.room ? `房间 ${party.room.roomCode}` : '一起听' }}</span>
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
  position: relative;
  z-index: 2;
  flex: 0 0 92px;
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto minmax(180px, 1fr);
  align-items: center;
  gap: 20px;
  padding: 14px 28px 8px;

  &::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-top: 1px solid rgba(128, 128, 128, .14);
    background: var(--color-surface-background, var(--color-content-background));
    backdrop-filter: saturate(160%) blur(22px);
  }
}

.progressTrack {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 12px;
  padding-top: 5px;
}

.progress {
  height: 3px;
}

.footerLeft {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: hidden;
}

.status {
  overflow: hidden;
  color: var(--color-font);
  font-size: 13px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time {
  color: var(--color-font-label);
  font-size: 12px;
  line-height: 1.35;
  white-space: nowrap;
}

.footerCenter {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.footerRight {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.partyBtn {
  flex: none;
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 11px;
  border: none;
  border-radius: 6px;
  outline: none;
  color: var(--color-button-font);
  background: var(--color-primary-light-900-alpha-500);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  transition: background-color .2s ease, opacity .2s ease;

  &:hover {
    background: var(--color-primary-light-900-alpha-700);
  }

  &:active {
    opacity: .72;
  }

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
}

.partyBtnActive {
  color: var(--color-primary);
}

.partyDot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 3px var(--color-primary-alpha-100);
}

.playBtn {
  flex: none;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  padding: 7px;
  border: none;
  border-radius: 50%;
  color: var(--color-button-font);
  background: transparent;
  cursor: pointer;
  transition: background-color .2s ease, color .2s ease, opacity .2s ease;

  svg {
    width: 100%;
    height: 100%;
    fill: currentColor;
  }

  &:hover {
    background: var(--color-button-background-hover);
  }

  &:active {
    opacity: .65;
  }

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
}

.playBtnPrimary {
  width: 48px;
  height: 48px;
  padding: 13px;
  color: var(--color-button-font-selected);
  background: var(--color-primary-alpha-200);

  &:hover {
    background: var(--color-primary-alpha-300);
  }
}

.queueBtn {
  margin-left: 2px;
}

.playBtnActive {
  color: var(--color-primary);
}

@media (max-width: 1100px) {
  .footer {
    grid-template-columns: minmax(140px, 1fr) auto minmax(220px, 1fr);
    gap: 14px;
    padding-right: 20px;
    padding-left: 20px;
  }

  .partyLabel {
    display: none;
  }
}

@media (max-width: 900px) {
  .footer {
    grid-template-columns: minmax(100px, 1fr) auto minmax(200px, 1fr);
    gap: 10px;
    padding-right: 14px;
    padding-left: 14px;
  }

  .footerRight {
    gap: 5px;
  }

  .playBtn {
    width: 32px;
    height: 32px;
  }

  .playBtnPrimary {
    width: 44px;
    height: 44px;
  }
}

</style>
