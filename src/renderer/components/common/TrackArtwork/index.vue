<template>
  <div
    ref="root"
    :class="[$style.artwork, { [$style.loading]: resolving }]"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <img
      v-if="artworkUrl"
      :src="artworkUrl"
      alt=""
      loading="lazy"
      decoding="async"
      draggable="false"
      @error="handleArtworkError"
    >
    <svg-icon v-else name="album" aria-hidden="true" />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from '@common/utils/vueTools'
import { artworkSession, getInitialArtworkUrl } from './artworkSession'

const props = defineProps<{
  musicInfo: LX.Music.MusicInfo | null
  size: number
}>()

const root = ref<HTMLElement | null>(null)
const resolving = ref(false)

const getVisibleArtworkUrl = (musicInfo: LX.Music.MusicInfo | null): string | null => {
  const sessionUrl = artworkSession.peek(musicInfo)
  return sessionUrl === undefined ? getInitialArtworkUrl(musicInfo) : sessionUrl
}

const artworkUrl = ref<string | null>(getVisibleArtworkUrl(props.musicInfo))
let observer: IntersectionObserver | null = null
let isIntersecting = false
let requestToken = 0

const resolveArtwork = async(): Promise<void> => {
  const musicInfo = props.musicInfo
  if (!musicInfo || artworkUrl.value) return

  const token = ++requestToken
  resolving.value = true
  const url = await artworkSession.resolve(musicInfo)
  if (token != requestToken) return
  artworkUrl.value = url
  resolving.value = false
}

const handleArtworkError = async(): Promise<void> => {
  const musicInfo = props.musicInfo
  const failedUrl = artworkUrl.value
  if (!musicInfo || !failedUrl) return

  ++requestToken
  resolving.value = false
  artworkUrl.value = null

  // A stored URL can be displayed before resolve() has populated the session cache.
  await artworkSession.resolve(musicInfo)
  artworkSession.fail(musicInfo, failedUrl)
}

watch(() => props.musicInfo, musicInfo => {
  ++requestToken
  resolving.value = false
  artworkUrl.value = getVisibleArtworkUrl(musicInfo)
  if (isIntersecting && !artworkUrl.value) void resolveArtwork()
})

onMounted(() => {
  if (typeof IntersectionObserver == 'undefined') {
    isIntersecting = true
    if (!artworkUrl.value) void resolveArtwork()
    return
  }

  observer = new IntersectionObserver(entries => {
    const entry = entries.find(entry => entry.target == root.value) ?? entries[0]
    isIntersecting = entry?.isIntersecting ?? false
    if (isIntersecting && !artworkUrl.value) void resolveArtwork()
  })
  if (root.value) observer.observe(root.value)
})

onBeforeUnmount(() => {
  ++requestToken
  observer?.disconnect()
  observer = null
})
</script>

<style lang="less" module>
.artwork {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 4px;
  color: var(--color-font-label);
  background-color: var(--color-button-background);

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  :global(.svg-icon) {
    width: 45%;
    height: 45%;
  }
}

.loading {
  animation: artwork-loading 1.6s ease-in-out infinite;
}

@keyframes artwork-loading {
  50% {
    opacity: .68;
  }
}
</style>
