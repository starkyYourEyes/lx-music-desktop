<template>
  <section v-if="cards.length" :class="$style.section">
    <div :class="$style.featureStrip">
      <div
        v-for="(card, index) in cards"
        :key="card.id"
        :class="[
          $style.featureCard,
          index == 0 ? $style.leadCard : $style.compactCard,
          { [$style.activeCard]: isCardPlaying(card) },
        ]"
        role="button"
        tabindex="0"
        @click="$emit('open', card)"
        @keydown.enter.self="$emit('open', card)"
        @keydown.space.self.prevent="$emit('open', card)"
      >
        <span :class="$style.cover">
          <img v-if="card.img" :src="card.img" loading="eager" decoding="async" draggable="false">
          <span v-else :class="$style.coverFallback">{{ card.name.slice(0, 1) }}</span>
          <cover-play-button
            :label="getCardPlayLabel(card)"
            :playing="isCardPlaying(card)"
            @click.stop="$emit('toggle-play', card)"
          />
        </span>
        <span :class="$style.info">
          <small>{{ getCardKicker(card) }}</small>
          <strong>{{ card.name }}</strong>
          <span>{{ card.desc || card.author || 'QQ Music' }}</span>
        </span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import CoverPlayButton from '@renderer/views/Recommend/components/CoverPlayButton.vue'
import type { RecommendCard } from '@renderer/views/Recommend/types'

defineProps<{
  cards: RecommendCard[]
  isCardPlaying: (card: RecommendCard) => boolean
  getCardPlayLabel: (card: RecommendCard) => string
  getCardKicker: (card: RecommendCard) => string
}>()

defineEmits<{
  open: [card: RecommendCard]
  'toggle-play': [card: RecommendCard]
}>()
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.section {
  min-width: 0;
}

.featureStrip {
  min-width: 0;
  display: flex;
  gap: 16px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 2px 2px 4px;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.featureCard {
  flex: none;
  min-width: 0;
  height: 258px;
  border-radius: 8px;
  overflow: hidden;
  color: var(--color-font);
  background-color: rgba(128, 128, 128, .07);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .12);
  cursor: pointer;
  transition: transform @transition-normal, box-shadow @transition-normal, background-color @transition-normal;

  &:hover,
  &:focus-visible {
    transform: translateY(-2px);
    background-color: rgba(128, 128, 128, .1);
    box-shadow: 0 10px 24px rgba(0, 0, 0, .14);

    button {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
  }
}

.activeCard {
  box-shadow: 0 0 0 2px var(--color-primary-alpha-600), 0 10px 24px rgba(0, 0, 0, .12);
}

.leadCard {
  width: clamp(330px, 33vw, 520px);
  display: grid;
  grid-template-columns: minmax(150px, .9fr) minmax(180px, 1.1fr);
  grid-template-areas: 'info cover';
  align-items: stretch;

  .cover {
    grid-area: cover;
    border-radius: 0;
  }

  .info {
    grid-area: info;
    justify-content: center;
    padding: 24px;

    strong {
      font-size: 26px;
      line-height: 1.2;
    }

    > span {
      margin-top: 10px;
      white-space: normal;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
    }
  }
}

.compactCard {
  width: clamp(150px, 15vw, 220px);
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;

  .cover {
    min-height: 0;
  }
}

.cover {
  position: relative;
  display: block;
  min-width: 0;
  overflow: hidden;
  background-color: rgba(0, 0, 0, .08);

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform @transition-normal;
  }
}

.featureCard:hover .cover img {
  transform: scale(1.025);
}

.coverFallback {
  width: 100%;
  height: 100%;
  min-height: 154px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-font-label);
  background-color: rgba(128, 128, 128, .12);
  font-size: 36px;
  font-weight: 800;
}

.info {
  min-width: 0;
  display: flex;
  flex-flow: column nowrap;
  padding: 12px 13px 14px;
  box-sizing: border-box;

  small {
    margin-bottom: 6px;
    color: var(--color-primary);
    font-size: 11px;
    line-height: 1.15;
    font-weight: 700;
    .mixin-ellipsis-1();
  }

  strong {
    color: var(--color-font);
    font-size: 15px;
    line-height: 1.22;
    font-weight: 800;
    .mixin-ellipsis-1();
  }

  > span {
    margin-top: 5px;
    overflow: hidden;
    color: var(--color-font-label);
    font-size: 12px;
    line-height: 1.3;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}

@media (max-width: 900px) {
  .featureCard {
    height: 230px;
  }

  .leadCard {
    width: 390px;
  }

  .compactCard {
    width: 164px;
  }
}

@media (max-width: 620px) {
  .featureCard {
    height: 214px;
  }

  .leadCard {
    width: min(84vw, 360px);
    grid-template-columns: minmax(130px, .9fr) minmax(150px, 1.1fr);

    .info {
      padding: 18px;

      strong {
        font-size: 21px;
      }
    }
  }

  .compactCard {
    width: 152px;
  }
}
</style>
