<template>
  <div :class="$style.playlistGrid">
    <div
      v-for="playlist in playlists"
      :key="playlist.id"
      :class="[$style.playlistCard, { [$style.playerCard]: playlist.isPrivateFm || playlist.isDailyRecommend || playlist.isPrivateRadar }]"
      role="button"
      tabindex="0"
      @click="$emit('open', playlist)"
      @keydown.enter="$emit('open', playlist)"
      @keydown.space.prevent="$emit('open', playlist)"
    >
      <span :class="$style.coverWrap">
        <img v-if="playlist.img" :class="$style.cover" loading="lazy" decoding="async" :src="playlist.img" draggable="false">
        <span v-else :class="$style.coverFallback">{{ playlist.name.slice(0, 1) }}</span>
        <cover-play-button
          v-if="playlist.isPrivateFm || playlist.isDailyRecommend || playlist.isPrivateRadar"
          :label="getCardPlayLabel(playlist)"
          :playing="isCardPlaying(playlist)"
          @click.stop="$emit('toggle-card-play', playlist)"
        />
        <span v-if="playlist.play_count" :class="$style.playCount">
          <svg-icon name="headphones" />
          {{ playlist.play_count }}
        </span>
      </span>
      <span :class="$style.playlistName">{{ playlist.name }}</span>
      <span v-if="playlist.desc || playlist.author" :class="$style.playlistDesc">
        {{ playlist.desc || playlist.author }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { RecommendCard } from '../types'
import CoverPlayButton from './CoverPlayButton.vue'

defineProps<{
  playlists: RecommendCard[]
  isCardPlaying: (playlist: RecommendCard) => boolean
  getCardPlayLabel: (playlist: RecommendCard) => string
}>()

defineEmits<{
  open: [playlist: RecommendCard]
  'toggle-card-play': [playlist: RecommendCard]
}>()
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.playlistGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(174px, 1fr));
  gap: 26px 24px;
  align-items: start;
}

.playlistCard {
  min-width: 0;
  color: var(--color-font);
  text-align: left;
  cursor: pointer;
  display: block;
  transition: opacity @transition-normal, transform @transition-normal;

  &:hover {
    opacity: .82;
    transform: translateY(-1px);

    button {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
  }
}

.playerCard {
  .coverWrap {
    box-shadow: 0 12px 28px rgba(0, 0, 0, .16);

    &:after {
      .mixin-after();
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background: linear-gradient(180deg, rgba(0, 0, 0, .04), rgba(0, 0, 0, .22));
      pointer-events: none;
    }
  }
}

.coverWrap {
  position: relative;
  display: block;
  aspect-ratio: 1 / 1;
  border-radius: 8px;
  overflow: hidden;
  background-color: rgba(0, 0, 0, .08);
  box-shadow: 0 0 2px 0 rgba(0, 0, 0, .18);
}

.cover {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.coverFallback {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-font-label);
  background-color: rgba(128, 128, 128, .12);
  font-weight: 700;
}

.playCount {
  position: absolute;
  top: 7px;
  right: 8px;
  max-width: calc(100% - 16px);
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border-radius: 8px;
  background-color: rgba(0, 0, 0, .38);
  color: #fff;
  font-size: 12px;
  line-height: 1.2;
  backdrop-filter: blur(8px);
  .mixin-ellipsis-1();

  svg {
    flex: none;
    width: 12px;
    height: 12px;
  }
}

.playlistName {
  display: -webkit-box;
  overflow: hidden;
  margin-top: 9px;
  color: var(--color-font);
  font-size: 15px;
  line-height: 1.22;
  font-weight: 700;
  word-break: break-all;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.playlistDesc {
  display: block;
  margin-top: 3px;
  color: var(--color-font-label);
  font-size: 12px;
  line-height: 1.25;
  .mixin-ellipsis-1();
}
</style>
