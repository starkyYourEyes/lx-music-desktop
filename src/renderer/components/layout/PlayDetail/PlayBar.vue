<template>
  <div :class="$style.footer">
    <div :class="$style.progressTrack" :style="{ '--progress-position': progressPosition }">
      <common-progress-bar
        :class-name="$style.progress"
        :progress="progress"
        :handle-transition-end="handleTransitionEnd"
        :is-active-transition="isActiveTransition"
      />
      <span :class="$style.progressMarker" aria-hidden="true" />
      <span :class="$style.progressTooltip" aria-hidden="true">{{ nowPlayTimeStr }} / {{ maxPlayTimeStr }}</span>
      <span :class="$style.progressTime">{{ nowPlayTimeStr }} / {{ maxPlayTimeStr }}</span>
    </div>
    <div :class="$style.footerLeft">
      <div :class="$style.trackInfo">
        <span :class="$style.trackTitle">{{ musicInfo.name || 'LX Music' }}</span>
        <span :class="$style.trackSinger">{{ musicInfo.singer || statusText }}</span>
      </div>
      <player-control-btns show-favorite :show-add-to="false" :show-lyric="false" :show-volume="false" :show-play-mode="false" compact />
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
import { computed, ref } from '@common/utils/vueTools'
import { playNext, playPrev, togglePlay } from '@renderer/core/player'
import { party } from '@renderer/store/party'
import { isPlay, musicInfo, statusText } from '@renderer/store/player/state'
import usePlayProgress from '@renderer/utils/compositions/usePlayProgress'

import ControlBtns from './components/ControlBtns.vue'
import PlayerControlBtns from '../PlayBar/ControlBtns.vue'
import PlayQueue from '../PlayQueue.vue'

const isShowPlayQueue = ref(false)
const {
  progress,
  nowPlayTimeStr,
  maxPlayTimeStr,
  isActiveTransition,
  handleTransitionEnd,
} = usePlayProgress()

const progressPosition = computed(() => `${Math.min(Math.max(progress.value || 0, 0), 1) * 100}%`)

</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.footer {
  position: relative;
  z-index: 2;
  flex: 0 0 72px;
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto minmax(180px, 1fr);
  align-items: center;
  gap: 20px;
  padding: 10px 28px 4px;

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
  --progress-position: 0%;
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 10px;
  padding-top: 4px;
}

.progress {
  height: 3px;
}

.progressMarker {
  position: absolute;
  z-index: 2;
  left: clamp(4px, var(--progress-position), calc(100% - 4px));
  top: 5.5px;
  width: 8px;
  height: 8px;
  box-sizing: border-box;
  border: 2px solid var(--color-primary);
  border-radius: 50%;
  background: var(--color-content-background);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .28);
  transform: translate(-50%, -50%);
  pointer-events: none;
  transition: left .2s ease-out;
}

.progressTooltip {
  position: absolute;
  z-index: 3;
  left: clamp(50px, var(--progress-position), calc(100% - 50px));
  bottom: 12px;
  padding: 4px 7px;
  border: 1px solid rgba(128, 128, 128, .18);
  border-radius: 4px;
  color: var(--color-font);
  background: var(--color-content-background);
  box-shadow: 0 4px 12px rgba(0, 0, 0, .16);
  opacity: 0;
  visibility: hidden;
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
  transform: translate(-50%, 2px);
  pointer-events: none;
  transition: left .2s ease-out, opacity .15s ease, transform .15s ease;
}

.progressTime {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
  pointer-events: none;
}

.progressTrack:hover .progressTooltip {
  visibility: visible;
  opacity: 1;
  transform: translate(-50%, 0);
}

.footerLeft {
  min-width: 0;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  overflow: hidden;
}

.trackInfo {
  flex: 0 1 260px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow: hidden;
}

.trackTitle,
.trackSinger {
  overflow: hidden;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trackTitle {
  color: var(--color-font);
  font-size: 13px;
}

.trackSinger {
  color: var(--color-font-label);
  font-size: 12px;
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
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
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
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  padding: 6px;
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
  width: 42px;
  height: 42px;
  padding: 11px;
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
    width: 30px;
    height: 30px;
  }

  .playBtnPrimary {
    width: 38px;
    height: 38px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .progressMarker,
  .progressTooltip {
    transition: none;
  }
}

</style>
