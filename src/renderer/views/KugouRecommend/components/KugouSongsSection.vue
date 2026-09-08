<template>
  <section :class="$style.section">
    <div :class="$style.heading">
      <div>
        <h3>
          <span>{{ title }}</span>
          <button
            :class="$style.playButton"
            type="button"
            :aria-label="playLabel"
            :disabled="!songs.length"
            @click="$emit('play-all')"
          >
            <svg viewBox="0 0 1024 1024" aria-hidden="true">
              <use :xlink:href="playing ? '#icon-pause' : '#icon-play'" />
            </svg>
          </button>
        </h3>
        <p v-if="description">{{ description }}</p>
      </div>
      <section-refresh-button :label="refreshLabel" :disabled="loading" @click="$emit('retry')" />
    </div>

    <div v-if="loading && !songs.length" :class="$style.grid">
      <span v-for="index in 9" :key="index" :class="$style.skeleton" />
    </div>
    <div v-else-if="error" :class="$style.message" role="status">
      <span>{{ error }}</span>
      <button type="button" @click="$emit('retry')">{{ retryText }}</button>
    </div>
    <p v-else-if="!songs.length" :class="$style.empty">{{ emptyText }}</p>
    <div v-else :class="$style.grid">
      <button
        v-for="(song, index) in songs.slice(0, 9)"
        :key="song.id"
        :class="[$style.song, { [$style.current]: isSongPlaying(song) }]"
        type="button"
        @click="$emit('play', toIndex(index))"
      >
        <img v-if="song.meta.picUrl" :src="song.meta.picUrl" loading="lazy" decoding="async" draggable="false">
        <span v-else :class="$style.coverFallback">{{ song.name.slice(0, 1) }}</span>
        <span :class="$style.text">
          <strong>{{ song.name }}</strong>
          <small>{{ song.singer || song.meta.albumName || providerName }}</small>
        </span>
        <svg v-if="isSongPlaying(song)" :class="$style.playingIcon" viewBox="0 0 1024 1024" aria-hidden="true">
          <use xlink:href="#icon-pause" />
        </svg>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import SectionRefreshButton from '@renderer/views/Recommend/components/SectionRefreshButton.vue'

defineProps<{
  title: string
  description: string
  songs: LX.Music.MusicInfo_kg[]
  loading: boolean
  error: string
  emptyText: string
  retryText: string
  refreshLabel: string
  playLabel: string
  providerName: string
  playing: boolean
  isSongPlaying: (song: LX.Music.MusicInfo_kg) => boolean
}>()

defineEmits<{
  retry: []
  play: [index: number]
  'play-all': []
}>()

const toIndex = (index: unknown) => Number(index)
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.section { min-width: 0; }
.heading {
  margin-bottom: 12px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;

  h3 { margin: 0; display: flex; align-items: center; gap: 9px; color: var(--color-font); font-size: 19px; line-height: 1.25; font-weight: 800; }
  p { margin: 5px 0 0; color: var(--color-font-label); font-size: 12px; line-height: 1.35; }
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
  cursor: pointer;
  transition: color @transition-fast, background-color @transition-fast, transform @transition-fast;

  svg { width: 100%; height: 100%; fill: currentColor; }
  &:hover:not(:disabled) { color: #1695f1; background-color: rgba(22, 149, 241, .1); transform: scale(1.04); }
  &:disabled { cursor: default; opacity: .35; }
}
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 20px; }
.song {
  min-width: 0;
  height: 60px;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 24px;
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

  &:hover, &:focus-visible, &.current { background-color: rgba(128, 128, 128, .1); }
  &:hover { transform: translateY(-1px); }
  img, .coverFallback { width: 48px; height: 48px; border-radius: 7px; }
  img { display: block; object-fit: cover; }
}
.coverFallback { display: flex; align-items: center; justify-content: center; color: var(--color-font-label); background-color: rgba(128, 128, 128, .12); font-weight: 800; }
.text {
  min-width: 0;
  display: flex;
  flex-flow: column nowrap;
  strong, small { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  strong { color: var(--color-font); font-size: 13px; line-height: 1.25; font-weight: 700; }
  small { margin-top: 5px; color: var(--color-font-label); font-size: 12px; line-height: 1.15; }
}
.playingIcon { width: 17px; height: 17px; fill: #1695f1; }
.message {
  min-height: 36px;
  margin-bottom: 12px;
  padding: 7px 10px;
  box-sizing: border-box;
  border-left: 3px solid #1695f1;
  color: var(--color-font-label);
  background-color: rgba(128, 128, 128, .08);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  button { padding: 4px 9px; border: 0; border-radius: 6px; color: #168be0; background-color: rgba(22, 149, 241, .1); cursor: pointer; }
}
.empty { min-height: 72px; margin: 0; display: flex; align-items: center; justify-content: center; color: var(--color-font-label); font-size: 13px; }
.skeleton { height: 60px; border-radius: 8px; background-color: rgba(128, 128, 128, .11); animation: pulse 1.3s ease-in-out infinite alternate; }
@keyframes pulse { from { opacity: .48; } to { opacity: .9; } }
@media (max-width: 980px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 680px) { .grid { grid-template-columns: 1fr; gap: 7px; } }
</style>
