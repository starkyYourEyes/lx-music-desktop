<template>
  <section v-if="playlists.length" :class="$style.homeSection">
    <div :class="$style.sectionTitleBar">
      <div :class="$style.titleText">
        <h3>{{ title }}</h3>
        <p>{{ desc }}</p>
      </div>
      <section-refresh-button
        v-if="refreshable"
        :class="$style.refreshBtn"
        label="刷新推荐歌单"
        :disabled="refreshing"
        @click="$emit('refresh')"
      />
    </div>
    <div :class="$style.horizontalSection">
      <button
        :class="[$style.scrollBtn, $style.scrollBtnLeft, { [$style.disabledScrollBtn]: !canScrollLeft }]"
        type="button"
        :aria-label="`向左浏览${title}`"
        :disabled="!canScrollLeft"
        @click="scrollHorizontal(-1)"
      >
        <span :class="[$style.scrollIcon, $style.scrollIconLeft]" aria-hidden="true" />
      </button>
      <div ref="scrollRef" :class="$style.horizontalScroller" @scroll="updateScrollState">
        <div
          v-for="playlist in playlists"
          :key="playlist.id"
          :class="cardType == 'radar' ? $style.verticalPlaylistCard : $style.stripCard"
          role="button"
          tabindex="0"
          @click="$emit('open', playlist)"
          @keydown.enter="$emit('open', playlist)"
          @keydown.space.prevent="$emit('open', playlist)"
        >
          <span :class="cardType == 'radar' ? $style.verticalCover : $style.stripCover">
            <img v-if="playlist.img" :src="playlist.img" loading="lazy" decoding="async" draggable="false">
            <span v-else :class="$style.coverFallback">{{ playlist.name.slice(0, 1) }}</span>
            <cover-play-button
              :label="getPlaylistPlayLabel(playlist)"
              :playing="isPlaylistPlayingList(playlist) && isPlay"
              @click.stop="$emit('toggle-play', playlist)"
            />
          </span>
          <span :class="cardType == 'radar' ? $style.verticalName : $style.stripName">{{ playlist.name }}</span>
          <span v-if="cardType == 'radar'" :class="$style.verticalDesc">{{ playlist.desc || playlist.author || '私人雷达' }}</span>
        </div>
      </div>
      <button
        :class="[$style.scrollBtn, $style.scrollBtnRight, { [$style.disabledScrollBtn]: !canScrollRight }]"
        type="button"
        :aria-label="`向右浏览${title}`"
        :disabled="!canScrollRight"
        @click="scrollHorizontal(1)"
      >
        <span :class="[$style.scrollIcon, $style.scrollIconRight]" aria-hidden="true" />
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from '@common/utils/vueTools'
import { isPlay } from '@renderer/store/player/state'
import CoverPlayButton from './CoverPlayButton.vue'
import SectionRefreshButton from './SectionRefreshButton.vue'

const props = withDefaults(defineProps<{
  title: string
  desc: string
  playlists: LX.Netease.Playlist[]
  cardType?: 'radar' | 'strip'
  refreshable?: boolean
  refreshing?: boolean
  isPlaylistPlayingList: (playlist: LX.Netease.Playlist) => boolean
  getPlaylistPlayLabel: (playlist: LX.Netease.Playlist) => string
}>(), {
  cardType: 'strip',
  refreshable: false,
  refreshing: false,
})

defineEmits<{
  open: [playlist: LX.Netease.Playlist]
  'toggle-play': [playlist: LX.Netease.Playlist]
  refresh: []
}>()

const scrollRef = ref<HTMLElement | null>(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)
let resizeObserver: ResizeObserver | null = null

const updateScrollState = () => {
  const el = scrollRef.value
  if (!el) {
    canScrollLeft.value = false
    canScrollRight.value = false
    return
  }

  const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
  canScrollLeft.value = el.scrollLeft > 1
  canScrollRight.value = el.scrollLeft < maxScrollLeft - 1
}

const getSingleCardScrollDistance = (el: HTMLElement) => {
  const firstCard = el.firstElementChild as HTMLElement | null
  const cardWidth = firstCard?.offsetWidth ?? 0
  const columnGap = Number.parseFloat(window.getComputedStyle(el).columnGap)
  return cardWidth + (Number.isFinite(columnGap) ? columnGap : 0)
}

const scrollHorizontal = (direction: -1 | 1) => {
  const el = scrollRef.value
  if (!el) return
  if (direction < 0 && !canScrollLeft.value) return
  if (direction > 0 && !canScrollRight.value) return
  el.scrollBy({
    left: direction * getSingleCardScrollDistance(el),
    behavior: 'smooth',
  })
  window.setTimeout(updateScrollState, 260)
}

onMounted(() => {
  resizeObserver = new ResizeObserver(updateScrollState)
  if (scrollRef.value) resizeObserver.observe(scrollRef.value)
  void nextTick(updateScrollState)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

watch(() => props.playlists, () => {
  void nextTick(updateScrollState)
}, { deep: true })

defineExpose({
  scrollToStart: () => scrollRef.value?.scrollTo({ left: 0 }),
})
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.homeSection {
  min-width: 0;
}

.sectionTitleBar {
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 12px;

  h3 {
    margin: 0;
    font-size: 19px;
    line-height: 1.25;
    color: var(--color-font);
    font-weight: 800;
  }

  p {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--color-font-label);
  }
}

.titleText {
  min-width: 0;
}

.refreshBtn {
  margin-left: auto;
}

.horizontalSection {
  position: relative;
  min-width: 0;
  padding-right: 38px;

  &:hover {
    .scrollBtn {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

.horizontalScroller {
  min-width: 0;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: clamp(138px, 14vw, 174px);
  gap: 16px;
  overflow-x: auto;
  overflow-y: hidden;
  scroll-behavior: smooth;
  padding: 2px 2px 0;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.scrollBtn {
  z-index: 3;
  width: 22px;
  height: 74px;
  padding: 0;
  border: 0;
  color: var(--color-font);
  background-color: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity @transition-fast, color @transition-fast;

  &:hover {
    color: var(--color-primary);
  }

  &:disabled {
    cursor: default;
    color: var(--color-font-label);
    opacity: .24;

    &:hover {
      color: var(--color-font-label);
    }
  }
}

.scrollBtn {
  position: absolute;
  top: clamp(69px, 7vw, 87px);
  opacity: 0;
  pointer-events: none;
  transform: translateY(-50%);
}

.scrollIcon {
  position: relative;
  display: block;
  width: 12px;
  height: 58px;

  &::before,
  &::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 3px;
    height: 34px;
    border-radius: 999px;
    background-color: currentColor;
  }
}

.scrollIconLeft {
  &::before {
    transform-origin: 50% 100%;
    transform: translate(-50%, -100%) rotate(28deg);
  }

  &::after {
    transform-origin: 50% 0;
    transform: translate(-50%, 0) rotate(-28deg);
  }
}

.scrollIconRight {
  &::before {
    transform-origin: 50% 100%;
    transform: translate(-50%, -100%) rotate(-28deg);
  }

  &::after {
    transform-origin: 50% 0;
    transform: translate(-50%, 0) rotate(28deg);
  }
}

.disabledScrollBtn {
  color: var(--color-font-label);
}

.scrollBtnLeft {
  left: -37px;
}

.scrollBtnRight {
  right: 8px;
}

.verticalPlaylistCard,
.stripCard {
  min-width: 0;
  color: var(--color-font);
  cursor: pointer;
  transition: transform @transition-normal, opacity @transition-normal;

  &:hover {
    transform: translateY(-1px);
    opacity: .9;

    button {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
  }
}

.verticalCover,
.stripCover {
  position: relative;
  display: block;
  aspect-ratio: 1 / 1;
  border-radius: 8px;
  overflow: hidden;
  background-color: rgba(0, 0, 0, .08);
  box-shadow: 0 0 2px rgba(0, 0, 0, .18);

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

.verticalName,
.stripName {
  display: -webkit-box;
  overflow: hidden;
  margin-top: 9px;
  color: var(--color-font);
  font-size: 13px;
  line-height: 1.26;
  font-weight: 700;
  word-break: break-all;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.verticalDesc {
  display: block;
  margin-top: 4px;
  color: var(--color-font-label);
  font-size: 12px;
  line-height: 1.22;
  .mixin-ellipsis-1();
}
</style>
