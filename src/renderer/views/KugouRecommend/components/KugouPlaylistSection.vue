<template>
  <section :class="$style.section">
    <div :class="$style.heading">
      <div>
        <h3>{{ title }}</h3>
        <p v-if="description">{{ description }}</p>
      </div>
      <section-refresh-button :label="refreshLabel" :disabled="loading" @click="$emit('retry')" />
    </div>

    <div v-if="loading && !playlists.length" :class="$style.grid">
      <span v-for="index in 6" :key="index" :class="$style.skeletonCard">
        <span :class="$style.skeletonCover" />
        <span :class="$style.skeletonLine" />
      </span>
    </div>
    <div v-else-if="error" :class="$style.message" role="status">
      <span>{{ error }}</span>
      <button type="button" @click="$emit('retry')">{{ retryText }}</button>
    </div>
    <p v-else-if="!playlists.length" :class="$style.empty">{{ emptyText }}</p>
    <div v-else :class="$style.grid">
      <div
        v-for="playlist in playlists"
        :key="playlist.id"
        :class="$style.card"
        role="button"
        tabindex="0"
        @click="$emit('open', playlist)"
        @keydown.enter.self="$emit('open', playlist)"
        @keydown.space.self.prevent="$emit('open', playlist)"
      >
        <span :class="$style.cover">
          <img v-if="playlist.img" :src="playlist.img" loading="lazy" decoding="async" draggable="false">
          <span v-else :class="$style.coverFallback">{{ playlist.name.slice(0, 1) }}</span>
          <span v-if="playlist.playCount" :class="$style.playCount">{{ playlist.playCount }}</span>
          <cover-play-button
            :label="getPlaylistPlayLabel(playlist)"
            :playing="isPlaylistPlaying(playlist)"
            @click.stop="$emit('toggle-play', playlist)"
          />
        </span>
        <strong>{{ playlist.name }}</strong>
        <small>{{ playlist.description || playlist.author }}</small>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import CoverPlayButton from '@renderer/views/Recommend/components/CoverPlayButton.vue'
import SectionRefreshButton from '@renderer/views/Recommend/components/SectionRefreshButton.vue'

defineProps<{
  title: string
  description: string
  playlists: LX.KuGouMusic.RecommendPlaylist[]
  loading: boolean
  error: string
  emptyText: string
  retryText: string
  refreshLabel: string
  isPlaylistPlaying: (playlist: LX.KuGouMusic.RecommendPlaylist) => boolean
  getPlaylistPlayLabel: (playlist: LX.KuGouMusic.RecommendPlaylist) => string
}>()

defineEmits<{
  retry: []
  open: [playlist: LX.KuGouMusic.RecommendPlaylist]
  'toggle-play': [playlist: LX.KuGouMusic.RecommendPlaylist]
}>()
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.section { min-width: 0; }
.heading {
  margin-bottom: 13px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;

  h3 { margin: 0; color: var(--color-font); font-size: 19px; line-height: 1.25; font-weight: 800; }
  p { margin: 5px 0 0; color: var(--color-font-label); font-size: 12px; line-height: 1.35; }
}
.grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 16px;
}
.card {
  min-width: 0;
  color: var(--color-font);
  cursor: pointer;
  transition: transform @transition-fast, opacity @transition-fast;

  &:hover, &:focus-visible {
    opacity: .92;
    transform: translateY(-2px);
    button { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  }
  strong, small { display: block; overflow: hidden; word-break: break-all; }
  strong { margin-top: 9px; font-size: 13px; line-height: 1.32; font-weight: 700; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  small { margin-top: 4px; color: var(--color-font-label); font-size: 11px; line-height: 1.3; white-space: nowrap; text-overflow: ellipsis; }
}
.cover {
  position: relative;
  display: block;
  aspect-ratio: 1 / 1;
  border-radius: 8px;
  overflow: hidden;
  background-color: rgba(128, 128, 128, .1);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .14);

  img, .coverFallback { width: 100%; height: 100%; }
  img { display: block; object-fit: cover; }
}
.coverFallback { display: flex; align-items: center; justify-content: center; color: var(--color-font-label); font-size: 30px; font-weight: 800; }
.playCount { position: absolute; right: 7px; bottom: 7px; z-index: 1; color: #fff; font-size: 11px; text-shadow: 0 1px 5px rgba(0, 0, 0, .9); }
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
.skeletonCard { animation: pulse 1.3s ease-in-out infinite alternate; }
.skeletonCover { display: block; aspect-ratio: 1 / 1; border-radius: 8px; background-color: rgba(128, 128, 128, .13); }
.skeletonLine { display: block; width: 82%; height: 12px; margin-top: 10px; border-radius: 4px; background-color: rgba(128, 128, 128, .12); }
@keyframes pulse { from { opacity: .5; } to { opacity: 1; } }
@media (max-width: 980px) { .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 680px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; } }
</style>
