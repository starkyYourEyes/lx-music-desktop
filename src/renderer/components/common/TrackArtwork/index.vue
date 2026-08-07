<template>
  <div
    ref="root"
    :class="[$style.artwork, { [$style.loading]: resolving }]"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <img
      v-if="artworkUrl"
      :key="`${artworkIdentity}:${artworkUrl}`"
      :src="artworkUrl"
      :data-artwork-identity="artworkIdentity"
      :data-artwork-url="artworkUrl"
      alt=""
      loading="lazy"
      decoding="async"
      draggable="false"
      @error="handleArtworkError"
    >
    <svg-icon v-else name="album" aria-hidden="true" />
  </div>
</template>

<script lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from '@common/utils/vueTools'
import { artworkSession, getArtworkIdentity, getInitialArtworkUrl } from './artworkSession'

type ArtworkVisibilityHandler = () => void

const visibilityHandlers = new Map<Element, ArtworkVisibilityHandler>()
let visibilityObserver: IntersectionObserver | null = null

const unobserveArtworkTarget = (target: Element): void => {
  if (!visibilityHandlers.delete(target)) return
  visibilityObserver?.unobserve(target)
  if (visibilityHandlers.size) return
  visibilityObserver?.disconnect()
  visibilityObserver = null
}

const observeArtworkTarget = (target: Element, onVisible: ArtworkVisibilityHandler): boolean => {
  if (typeof IntersectionObserver == 'undefined') return false
  unobserveArtworkTarget(target)
  visibilityObserver ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const handler = visibilityHandlers.get(entry.target)
      if (!handler) continue
      unobserveArtworkTarget(entry.target)
      handler()
    }
  })
  visibilityHandlers.set(target, onVisible)
  visibilityObserver.observe(target)
  return true
}
</script>

<script setup lang="ts">
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
const artworkIdentity = ref(getArtworkIdentity(props.musicInfo))
let isMounted = false
let isUnmounted = false
let requestToken = 0

const resolveArtwork = async(): Promise<void> => {
  if (isUnmounted) return
  const musicInfo = props.musicInfo
  if (!musicInfo || artworkUrl.value != null || artworkSession.peek(musicInfo) !== undefined) return

  const token = ++requestToken
  resolving.value = true
  const url = await artworkSession.resolve(musicInfo)
  if (token != requestToken) return
  artworkUrl.value = url
  resolving.value = false
}

const unregisterArtworkTarget = (): void => {
  if (root.value) unobserveArtworkTarget(root.value)
}

const registerArtworkTarget = (): void => {
  if (!isMounted || isUnmounted || !root.value || artworkSession.peek(props.musicInfo) !== undefined) return
  if (!observeArtworkTarget(root.value, () => { void resolveArtwork() })) void resolveArtwork()
}

const handleArtworkError = async(event: Event): Promise<void> => {
  if (isUnmounted) return
  const target = event.currentTarget as HTMLImageElement | null
  const musicInfo = props.musicInfo
  const failedUrl = target?.dataset.artworkUrl
  if (
    !musicInfo ||
    !failedUrl ||
    target.dataset.artworkIdentity != getArtworkIdentity(musicInfo) ||
    failedUrl != artworkUrl.value
  ) return

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
  unregisterArtworkTarget()
  artworkIdentity.value = getArtworkIdentity(musicInfo)
  artworkUrl.value = getVisibleArtworkUrl(musicInfo)
  registerArtworkTarget()
})

onMounted(() => {
  isMounted = true
  registerArtworkTarget()
})

onBeforeUnmount(() => {
  isUnmounted = true
  ++requestToken
  unregisterArtworkTarget()
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
