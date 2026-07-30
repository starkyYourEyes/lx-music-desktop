<template lang="pug">
div(:class="$style.stage")
  div(:class="[$style.tonearm, { [$style.tonearmPlaying]: isPlay }]" aria-hidden="true")
    span(:class="$style.pivot")
    span(:class="$style.arm")
    span(:class="$style.head")
  div(:class="$style.deck" aria-hidden="true")
    div(:class="[$style.record, { [$style.playing]: isPlay }]")
      div(:class="$style.label")
        img(v-if="musicInfo.pic" :src="musicInfo.pic" decoding="async" @error="handleImageError")
        div(v-else :class="$style.emptyPic") L<span>X</span>
        span(:class="$style.spindle")
</template>

<script setup>
import { isPlay, musicInfo } from '@renderer/store/player/state'
import { setMusicInfo } from '@renderer/store/player/action'

const handleImageError = () => {
  setMusicInfo({ pic: null })
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  padding: clamp(46px, 7vh, 76px) 8px 8px;
  isolation: isolate;
  container-type: size;
}

.deck {
  position: relative;
  width: min(82%, 430px);
  aspect-ratio: 1;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background:
    radial-gradient(circle at 34% 28%, rgba(255, 255, 255, .12), transparent 34%),
    var(--color-primary-light-900-alpha-300);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, .08),
    0 20px 52px rgba(0, 0, 0, .18);
}

.record {
  position: relative;
  width: 94%;
  aspect-ratio: 1;
  border-radius: 50%;
  background:
    repeating-radial-gradient(circle at center, transparent 0 3px, rgba(255, 255, 255, .035) 4px, transparent 5px 7px),
    radial-gradient(circle at 36% 30%, #303332 0, #121514 42%, #050706 72%, #1d211f 100%);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, .1),
    inset 0 0 38px rgba(0, 0, 0, .72),
    0 10px 24px rgba(0, 0, 0, .32);
  animation: recordSpin 18s linear infinite;
  animation-play-state: paused;

  &::before {
    content: '';
    position: absolute;
    inset: 4%;
    border: 1px solid rgba(255, 255, 255, .045);
    border-radius: inherit;
    box-shadow:
      0 0 0 7px rgba(0, 0, 0, .08),
      0 0 0 15px rgba(255, 255, 255, .018),
      0 0 0 24px rgba(0, 0, 0, .08);
  }
}

.playing {
  animation-play-state: running;
}

.label {
  position: absolute;
  inset: 19%;
  overflow: hidden;
  border-radius: 50%;
  background: var(--color-primary-light-900-alpha-700);
  box-shadow:
    0 0 0 5px rgba(0, 0, 0, .3),
    inset 0 0 18px rgba(0, 0, 0, .16);

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.emptyPic {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: clamp(24px, 4vw, 42px);
  font-weight: 300;
  color: var(--color-font);
  background:
    linear-gradient(145deg, var(--color-primary-light-600-alpha-500), var(--color-main-background));

  span {
    color: var(--color-primary);
    font-weight: 700;
  }
}

.spindle {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 10px;
  height: 10px;
  border: 3px solid rgba(255, 255, 255, .86);
  border-radius: 50%;
  background: #8b9691;
  box-shadow: 0 1px 5px rgba(0, 0, 0, .45);
  transform: translate(-50%, -50%);
}

.tonearm {
  position: absolute;
  z-index: 2;
  top: clamp(12px, 2.5vh, 28px);
  left: 38%;
  width: min(48%, 238px);
  height: 88px;
  color: var(--color-font-label);
  pointer-events: none;
  filter: drop-shadow(0 3px 5px rgba(0, 0, 0, .2));
  transform: rotate(4deg);
  transform-origin: 0 0;
  transition: transform 360ms cubic-bezier(.2, .75, .25, 1);
}

.tonearmPlaying {
  transform: rotate(40deg);
}

.pivot {
  position: absolute;
  left: 0;
  top: 0;
  width: 23px;
  height: 23px;
  border: 6px solid currentColor;
  border-radius: 50%;
  background: var(--color-content-background);
  box-shadow: inset 0 0 0 3px rgba(255, 255, 255, .58);
}

.arm {
  position: absolute;
  left: 18px;
  top: 14px;
  width: calc(100% - 35px);
  height: 7px;
  border-radius: 999px;
  background: currentColor;
  transform: rotate(17deg);
  transform-origin: left center;
}

.head {
  position: absolute;
  right: -2px;
  bottom: 1px;
  width: 31px;
  height: 15px;
  border-radius: 3px;
  background: currentColor;
  box-shadow: inset -5px 0 rgba(255, 255, 255, .3);
  transform: rotate(7deg);
}

@keyframes recordSpin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 900px), (max-height: 650px) {
  .stage {
    padding-top: 24px;
  }

  .tonearm {
    display: none;
  }
}

@container (max-width: 260px) {
  .stage {
    padding-top: 8px;
  }

  .deck {
    width: 96%;
  }

  .tonearm {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .record {
    animation: none;
  }

  .tonearm {
    transition: none;
  }
}
</style>
