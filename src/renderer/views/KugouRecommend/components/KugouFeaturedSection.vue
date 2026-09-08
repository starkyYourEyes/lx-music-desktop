<template>
  <section :class="$style.section">
    <div :class="$style.heading">
      <div>
        <h3>{{ title }}</h3>
        <p>{{ description }}</p>
      </div>
      <section-refresh-button :label="refreshLabel" :disabled="loading" @click="$emit('retry')" />
    </div>
    <div v-if="loading && !songs.length" :class="$style.skeleton" />
    <div v-else-if="error" :class="$style.message" role="status">
      <span>{{ error }}</span>
      <button type="button" @click="$emit('retry')">{{ retryText }}</button>
    </div>
    <p v-else-if="!songs.length" :class="$style.empty">{{ emptyText }}</p>
    <div
      v-else
      :class="[$style.card, { [$style.playing]: playing }]"
      role="button"
      tabindex="0"
      @click="$emit('play')"
      @keydown.enter="$emit('play')"
      @keydown.space.prevent="$emit('play')"
    >
      <span :class="$style.cover">
        <img v-if="songs[0].meta.picUrl" :src="songs[0].meta.picUrl" loading="lazy" decoding="async" draggable="false">
        <span v-else :class="$style.coverFallback">{{ songs[0].name.slice(0, 1) }}</span>
        <cover-play-button :label="playLabel" :playing="playing" @click.stop="$emit('play')" />
      </span>
      <span :class="$style.info">
        <small>{{ providerName }}</small>
        <strong>{{ songs[0].name }}</strong>
        <span>{{ songs[0].singer || songs[0].meta.albumName }}</span>
        <span :class="$style.queue">{{ queueText }}</span>
      </span>
    </div>
  </section>
</template>

<script setup lang="ts">
import CoverPlayButton from '@renderer/views/Recommend/components/CoverPlayButton.vue'
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
  queueText: string
  playing: boolean
}>()

defineEmits<{
  retry: []
  play: []
}>()
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
  h3 { margin: 0; color: var(--color-font); font-size: 19px; line-height: 1.25; font-weight: 800; }
  p { margin: 5px 0 0; color: var(--color-font-label); font-size: 12px; line-height: 1.35; }
}
.card {
  width: min(520px, 100%);
  height: 172px;
  display: grid;
  grid-template-columns: 172px minmax(0, 1fr);
  padding: 0;
  border: 0;
  border-radius: 8px;
  overflow: hidden;
  color: var(--color-font);
  background-color: rgba(128, 128, 128, .07);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .12);
  text-align: left;
  cursor: pointer;
  transition: transform @transition-fast, box-shadow @transition-fast, background-color @transition-fast;
  &:hover, &:focus-visible { transform: translateY(-2px); background-color: rgba(128, 128, 128, .1); box-shadow: 0 8px 20px rgba(0, 0, 0, .13); button { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
  &.playing { box-shadow: 0 0 0 2px rgba(22, 149, 241, .6), 0 8px 20px rgba(0, 0, 0, .12); }
}
.cover { position: relative; min-width: 0; overflow: hidden; background-color: rgba(128, 128, 128, .1); img, .coverFallback { width: 100%; height: 100%; } img { display: block; object-fit: cover; } }
.coverFallback { display: flex; align-items: center; justify-content: center; color: var(--color-font-label); font-size: 34px; font-weight: 800; }
.info {
  min-width: 0;
  display: flex;
  flex-flow: column nowrap;
  justify-content: center;
  padding: 22px;
  box-sizing: border-box;
  small { color: #168be0; font-size: 11px; font-weight: 700; }
  strong { margin-top: 8px; overflow: hidden; color: var(--color-font); font-size: 20px; line-height: 1.25; white-space: nowrap; text-overflow: ellipsis; }
  > span { margin-top: 6px; overflow: hidden; color: var(--color-font-label); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
  .queue { margin-top: 18px; color: #168be0; }
}
.message {
  min-height: 36px; margin-bottom: 12px; padding: 7px 10px; box-sizing: border-box; border-left: 3px solid #1695f1; color: var(--color-font-label); background-color: rgba(128, 128, 128, .08); display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px;
  button { padding: 4px 9px; border: 0; border-radius: 6px; color: #168be0; background-color: rgba(22, 149, 241, .1); cursor: pointer; }
}
.empty { min-height: 72px; margin: 0; display: flex; align-items: center; justify-content: center; color: var(--color-font-label); font-size: 13px; }
.skeleton { width: min(520px, 100%); height: 172px; border-radius: 8px; background-color: rgba(128, 128, 128, .11); animation: pulse 1.3s ease-in-out infinite alternate; }
@keyframes pulse { from { opacity: .48; } to { opacity: .9; } }
@media (max-width: 620px) { .card { height: 148px; grid-template-columns: 148px minmax(0, 1fr); } .info { padding: 16px; } }
</style>
