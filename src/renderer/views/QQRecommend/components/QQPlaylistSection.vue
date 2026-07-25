<template>
  <section v-if="loading || playlists.length" :class="$style.section">
    <div :class="$style.heading">
      <div>
        <h3>{{ title }}</h3>
        <p v-if="description">{{ description }}</p>
      </div>
    </div>
    <div :class="$style.carousel">
      <button
        :class="[$style.navButton, $style.previousButton]"
        type="button"
        :aria-label="`向左浏览${title}`"
        :disabled="!canScrollPrevious"
        @click="scroll(-1)"
      >
        <svg-icon name="angle-right-solid" />
      </button>
      <div ref="scroller" :class="$style.scroller" @scroll="updateScrollState">
        <template v-if="loading && !playlists.length">
          <span v-for="index in 6" :key="index" :class="$style.skeletonCard">
            <span :class="$style.skeletonCover" />
            <span :class="$style.skeletonLine" />
          </span>
        </template>
        <div
          v-for="playlist in playlists"
          v-else
          :key="playlist.id"
          :class="$style.playlistCard"
          role="button"
          tabindex="0"
          @click="$emit('open', playlist)"
          @keydown.enter.self="$emit('open', playlist)"
          @keydown.space.self.prevent="$emit('open', playlist)"
        >
          <span :class="$style.cover">
            <img :src="playlist.img" loading="lazy" decoding="async" draggable="false">
            <span v-if="playlist.playCount" :class="$style.playCount">{{ playlist.playCount }}</span>
            <cover-play-button
              :label="getPlaylistPlayLabel(playlist)"
              :playing="isPlaylistPlayingList(playlist)"
              @click.stop="$emit('toggle-play', playlist)"
            />
          </span>
          <strong>{{ playlist.name }}</strong>
        </div>
      </div>
      <button
        :class="[$style.navButton, $style.nextButton]"
        type="button"
        :aria-label="`向右浏览${title}`"
        :disabled="!canScrollNext"
        @click="scroll(1)"
      >
        <svg-icon name="angle-right-solid" />
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from '@common/utils/vueTools'
import CoverPlayButton from '@renderer/views/Recommend/components/CoverPlayButton.vue'

const props = withDefaults(defineProps<{
  title: string
  description?: string
  playlists: LX.QQMusic.RecommendPlaylist[]
  loading?: boolean
  isPlaylistPlayingList: (playlist: LX.QQMusic.RecommendPlaylist) => boolean
  getPlaylistPlayLabel: (playlist: LX.QQMusic.RecommendPlaylist) => string
}>(), {
  description: '',
  loading: false,
})

defineEmits<{
  open: [playlist: LX.QQMusic.RecommendPlaylist]
  'toggle-play': [playlist: LX.QQMusic.RecommendPlaylist]
}>()

const scroller = ref<HTMLElement | null>(null)
const canScrollPrevious = ref(false)
const canScrollNext = ref(false)
let resizeObserver: ResizeObserver | null = null

const updateScrollState = () => {
  const el = scroller.value
  if (!el) return
  const max = Math.max(0, el.scrollWidth - el.clientWidth)
  canScrollPrevious.value = el.scrollLeft > 1
  canScrollNext.value = el.scrollLeft < max - 1
}

const scroll = (direction: -1 | 1) => {
  const el = scroller.value
  const card = el?.firstElementChild as HTMLElement | null
  if (!el || !card) return
  const gap = Number.parseFloat(window.getComputedStyle(el).columnGap) || 0
  el.scrollBy({ left: direction * (card.offsetWidth + gap) * 2, behavior: 'smooth' })
  window.setTimeout(updateScrollState, 280)
}

onMounted(() => {
  resizeObserver = new ResizeObserver(updateScrollState)
  if (scroller.value) resizeObserver.observe(scroller.value)
  void nextTick(updateScrollState)
})

onBeforeUnmount(() => resizeObserver?.disconnect())

watch(() => props.playlists, async() => {
  await nextTick()
  updateScrollState()
}, { deep: true })
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.section {
  min-width: 0;
}

.heading {
  margin-bottom: 13px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;

  h3 {
    margin: 0;
    color: var(--color-font);
    font-size: 19px;
    line-height: 1.25;
    font-weight: 800;
  }

  p {
    margin: 5px 0 0;
    color: var(--color-font-label);
    font-size: 12px;
    line-height: 1.35;
  }
}

.carousel {
  position: relative;
  min-width: 0;
  margin: 0 -38px;
  padding: 0 38px;

  &:hover .navButton:not(:disabled) {
    opacity: .82;
  }
}

.scroller {
  min-width: 0;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: max(142px, calc((100% - 80px) / 6));
  gap: 16px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 2px 2px 3px;
  scrollbar-width: none;
  scroll-behavior: smooth;

  &::-webkit-scrollbar {
    display: none;
  }
}

.playlistCard {
  min-width: 0;
  color: var(--color-font);
  cursor: pointer;
  transition: transform @transition-normal, opacity @transition-normal;

  &:hover,
  &:focus-visible {
    transform: translateY(-2px);
    opacity: .92;

    button {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
  }

  strong {
    display: -webkit-box;
    overflow: hidden;
    margin-top: 9px;
    color: var(--color-font);
    font-size: 13px;
    line-height: 1.32;
    font-weight: 700;
    word-break: break-all;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
}

.cover {
  position: relative;
  display: block;
  aspect-ratio: 1 / 1;
  border-radius: 8px;
  overflow: hidden;
  background-color: rgba(128, 128, 128, .1);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .16);

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.playCount {
  position: absolute;
  right: 7px;
  bottom: 7px;
  z-index: 1;
  max-width: calc(100% - 14px);
  overflow: hidden;
  color: #fff;
  font-size: 11px;
  line-height: 1.2;
  text-shadow: 0 1px 5px rgba(0, 0, 0, .9);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.navButton {
  position: absolute;
  z-index: 3;
  top: 50%;
  width: 38px;
  height: 64px;
  padding: 9px;
  border: 0;
  color: var(--color-font);
  background-color: transparent;
  opacity: 0;
  cursor: pointer;
  transform: translateY(-62%);
  transition: color @transition-fast, opacity @transition-fast;

  svg {
    width: 100%;
    height: 100%;
    fill: currentColor;
  }

  &:hover,
  &:focus-visible {
    color: var(--color-primary);
    opacity: 1;
  }

  &:disabled {
    opacity: 0;
    cursor: default;
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

.skeletonCard {
  display: block;
  animation: pulse 1.3s ease-in-out infinite alternate;
}

.skeletonCover {
  display: block;
  aspect-ratio: 1 / 1;
  border-radius: 8px;
  background-color: rgba(128, 128, 128, .13);
}

.skeletonLine {
  display: block;
  width: 82%;
  height: 12px;
  margin-top: 10px;
  border-radius: 4px;
  background-color: rgba(128, 128, 128, .12);
}

@keyframes pulse {
  from { opacity: .5; }
  to { opacity: 1; }
}

@media (max-width: 900px) {
  .scroller {
    grid-auto-columns: max(138px, calc((100% - 48px) / 4));
  }
}

@media (max-width: 620px) {
  .carousel {
    margin: 0 -24px;
    padding: 0 24px;
  }

  .scroller {
    grid-auto-columns: max(132px, calc((100% - 16px) / 2));
    gap: 14px;
  }

  .navButton {
    width: 28px;
  }
}
</style>
