<template>
  <section v-if="loading || songs.length" :class="$style.section">
    <div :class="$style.heading">
      <h3>
        <span>{{ title }}</span>
        <button
          :class="$style.playButton"
          type="button"
          :aria-label="isSectionPlaying ? `暂停 ${title}` : `播放 ${title}`"
          :disabled="!songs.length"
          @click="$emit('play-all')"
        >
          <svg viewBox="0 0 1024 1024" aria-hidden="true">
            <use :xlink:href="isSectionPlaying ? '#icon-pause' : '#icon-play'" />
          </svg>
        </button>
      </h3>
    </div>
    <div :class="$style.carousel">
      <button
        :class="[$style.navButton, $style.previousButton]"
        type="button"
        aria-label="上一组相关歌曲"
        :disabled="pageCount < 2"
        @click="handlePrevious"
      >
        <svg-icon name="angle-right-solid" />
      </button>
      <div v-if="loading && !songs.length" :class="$style.songGrid">
        <span v-for="index in 9" :key="index" :class="$style.skeletonSong" />
      </div>
      <div v-else :class="$style.songGrid">
        <button
          v-for="(song, index) in songs"
          :key="song.id"
          :class="[$style.song, { [$style.currentSong]: isSongPlaying(song) }]"
          type="button"
          @click="$emit('play', toIndex(index))"
        >
          <img v-if="song.meta.picUrl" :src="song.meta.picUrl" loading="lazy" decoding="async" draggable="false">
          <span v-else :class="$style.coverFallback">{{ song.name.slice(0, 1) }}</span>
          <span :class="$style.songText">
            <strong>{{ song.name }}</strong>
            <small>{{ song.singer || song.meta.albumName || 'QQ Music' }}</small>
          </span>
          <svg v-if="isSongPlaying(song)" :class="$style.playingIcon" viewBox="0 0 1024 1024" aria-hidden="true">
            <use xlink:href="#icon-pause" />
          </svg>
        </button>
      </div>
      <button
        :class="[$style.navButton, $style.nextButton]"
        type="button"
        aria-label="下一组相关歌曲"
        :disabled="pageCount < 2"
        @click="handleNext"
      >
        <svg-icon name="angle-right-solid" />
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  title: string
  songs: LX.Music.MusicInfo_tx[]
  pageCount: number
  loading?: boolean
  isSectionPlaying?: boolean
  isSongPlaying: (song: LX.Music.MusicInfo_tx) => boolean
}>(), {
  loading: false,
  isSectionPlaying: false,
})

const emit = defineEmits<{
  previous: []
  next: []
  play: [index: number]
  'play-all': []
}>()

const handlePrevious = () => {
  emit('previous')
}
const handleNext = () => {
  emit('next')
}
const toIndex = (index: unknown) => Number(index)
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.section {
  min-width: 0;
}

.heading {
  margin-bottom: 12px;

  h3 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 9px;
    color: var(--color-font);
    font-size: 19px;
    line-height: 1.25;
    font-weight: 800;
  }
}

.playButton {
  flex: none;
  width: 29px;
  height: 29px;
  padding: 7px;
  border: 0;
  border-radius: 50%;
  color: var(--color-font);
  background-color: rgba(128, 128, 128, .1);
  opacity: .8;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: color @transition-fast, background-color @transition-fast, transform @transition-fast;

  svg {
    width: 100%;
    height: 100%;
    fill: currentColor;
  }

  &:hover:not(:disabled) {
    color: var(--color-primary);
    background-color: var(--color-primary-background-hover);
    transform: scale(1.04);
  }

  &:disabled {
    cursor: default;
    opacity: .35;
  }
}

.carousel {
  position: relative;
  min-width: 0;
  margin: 0 -38px;
  padding: 0 38px;
}

.songGrid {
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-template-rows: repeat(3, 60px);
  grid-auto-flow: column;
  gap: 8px 20px;
}

.song {
  min-width: 0;
  height: 60px;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 26px;
  align-items: center;
  gap: 10px;
  padding: 6px 8px 6px 6px;
  box-sizing: border-box;
  border: 0;
  border-radius: 8px;
  color: var(--color-font);
  background-color: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color @transition-fast, transform @transition-fast;

  &:hover,
  &:focus-visible,
  &.currentSong {
    background-color: rgba(128, 128, 128, .1);
  }

  &:hover {
    transform: translateY(-1px);
  }

  img,
  .coverFallback {
    width: 48px;
    height: 48px;
    border-radius: 7px;
  }

  img {
    display: block;
    object-fit: cover;
  }
}

.coverFallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-font-label);
  background-color: rgba(128, 128, 128, .12);
  font-weight: 800;
}

.songText {
  min-width: 0;
  display: flex;
  flex-flow: column nowrap;

  strong,
  small {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  strong {
    color: var(--color-font);
    font-size: 13px;
    line-height: 1.25;
    font-weight: 700;
  }

  small {
    margin-top: 5px;
    color: var(--color-font-label);
    font-size: 12px;
    line-height: 1.15;
  }
}

.playingIcon {
  width: 17px;
  height: 17px;
  fill: var(--color-primary);
}

.navButton {
  position: absolute;
  z-index: 3;
  top: 50%;
  width: 38px;
  height: 76px;
  padding: 9px;
  border: 0;
  color: var(--color-font-label);
  background-color: transparent;
  opacity: .62;
  cursor: pointer;
  transform: translateY(-50%);
  transition: color @transition-fast, opacity @transition-fast;

  svg {
    width: 100%;
    height: 100%;
    fill: currentColor;
  }

  &:hover:not(:disabled),
  &:focus-visible:not(:disabled) {
    color: var(--color-primary);
    opacity: 1;
  }

  &:disabled {
    cursor: default;
    opacity: .18;
  }
}

.previousButton {
  left: 0;

  svg {
    transform: rotate(180deg);
  }
}

.nextButton {
  right: 0;
}

.skeletonSong {
  height: 60px;
  border-radius: 8px;
  background-color: rgba(128, 128, 128, .11);
  animation: pulse 1.3s ease-in-out infinite alternate;
}

@keyframes pulse {
  from { opacity: .48; }
  to { opacity: .9; }
}

@media (max-width: 980px) {
  .songGrid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-rows: none;
    grid-auto-flow: row;
  }
}

@media (max-width: 680px) {
  .carousel {
    margin: 0 -24px;
    padding: 0 24px;
  }

  .songGrid {
    grid-template-columns: 1fr;
    gap: 7px;
  }

  .navButton {
    width: 28px;
  }
}
</style>
