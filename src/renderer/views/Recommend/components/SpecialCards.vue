<template>
  <section v-if="cards.length" :class="$style.specialSection">
    <div :class="$style.specialGrid">
      <div
        v-for="playlist in cards"
        :key="playlist.id"
        :class="[$style.specialCard, { [$style.activeSpecialCard]: isCardPlaying(playlist), [$style.placeholderSpecialCard]: playlist.isPlaceholder }]"
        role="button"
        :tabindex="playlist.isPlaceholder ? -1 : 0"
        @click="$emit('open', playlist)"
        @keydown.enter="$emit('open', playlist)"
        @keydown.space.prevent="$emit('open', playlist)"
      >
        <span :class="$style.specialCover">
          <img v-if="playlist.img" :src="playlist.img" loading="lazy" decoding="async" draggable="false">
          <span v-else :class="[$style.coverFallback, $style.blankCover]">{{ playlist.name.slice(0, 1) }}</span>
          <cover-play-button
            v-if="!playlist.isPlaceholder"
            :label="getCardPlayLabel(playlist)"
            :playing="isCardPlaying(playlist)"
            @click.stop="$emit('toggle-card-play', playlist)"
          />
        </span>
        <span :class="$style.specialInfo">
          <span v-if="!playlist.isPlaceholder" :class="$style.specialKicker">{{ getSpecialCardKicker(playlist) }}</span>
          <span v-if="playlist.name" :class="$style.specialName">{{ playlist.name }}</span>
          <span v-if="playlist.desc || playlist.author" :class="$style.specialDesc">{{ playlist.desc || playlist.author || '为你准备' }}</span>
        </span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { RecommendCard } from '../types'
import CoverPlayButton from './CoverPlayButton.vue'

defineProps<{
  cards: RecommendCard[]
  isCardPlaying: (playlist: RecommendCard) => boolean
  getCardPlayLabel: (playlist: RecommendCard) => string
  getSpecialCardKicker: (playlist: RecommendCard) => string
}>()

defineEmits<{
  open: [playlist: RecommendCard]
  'toggle-card-play': [playlist: RecommendCard]
}>()
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.specialSection {
  min-width: 0;
}

.specialGrid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.specialCard {
  min-width: 0;
  min-height: 128px;
  display: grid;
  grid-template-columns: clamp(78px, 7.5vw, 96px) minmax(0, 1fr);
  gap: clamp(14px, 1.5vw, 20px);
  align-items: center;
  padding: 15px;
  box-sizing: border-box;
  border-radius: 8px;
  border: 1px solid rgba(128, 128, 128, .13);
  background:
    linear-gradient(135deg, rgba(255, 255, 255, .08), rgba(128, 128, 128, .04)),
    var(--color-main-background);
  color: var(--color-font);
  cursor: pointer;
  box-shadow: 0 10px 26px rgba(0, 0, 0, .08);
  transition: transform @transition-normal, border-color @transition-normal, box-shadow @transition-normal;

  &:hover {
    transform: translateY(-2px);
    border-color: rgba(128, 128, 128, .24);
    box-shadow: 0 14px 32px rgba(0, 0, 0, .12);

    button {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
  }
}

.placeholderSpecialCard {
  cursor: default;
  opacity: .55;
  box-shadow: none;

  &:hover {
    transform: none;
    border-color: rgba(128, 128, 128, .13);
    box-shadow: none;
  }
}

.activeSpecialCard {
  border-color: rgba(75, 178, 112, .46);
}

.specialCover {
  position: relative;
  width: clamp(78px, 7.5vw, 96px);
  aspect-ratio: 1 / 1;
  border-radius: 8px;
  overflow: hidden;
  background-color: rgba(0, 0, 0, .08);

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
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

.blankCover {
  background:
    linear-gradient(135deg, rgba(128, 128, 128, .14), rgba(128, 128, 128, .04)),
    rgba(128, 128, 128, .08);
}

.specialInfo {
  min-width: 0;
  display: flex;
  flex-flow: column nowrap;
}

.specialKicker {
  margin-bottom: 8px;
  color: var(--color-font-label);
  font-size: 11px;
  line-height: 1.1;
  text-transform: uppercase;
  .mixin-ellipsis-1();
}

.specialName {
  display: -webkit-box;
  overflow: hidden;
  color: var(--color-font);
  font-size: clamp(14px, 1.15vw, 18px);
  line-height: 1.22;
  font-weight: 800;
  word-break: break-all;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.specialDesc {
  margin-top: 8px;
  color: var(--color-font-label);
  font-size: 12px;
  line-height: 1.3;
  .mixin-ellipsis-1();
}

@media (max-width: 980px) {
  .specialGrid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .specialGrid {
    grid-template-columns: 1fr;
  }

  .specialCard {
    min-height: 132px;
    grid-template-columns: 100px minmax(0, 1fr);
  }

  .specialCover {
    width: 100px;
    height: 100px;
  }
}
</style>
