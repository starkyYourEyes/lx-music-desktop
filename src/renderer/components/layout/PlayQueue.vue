<template>
  <teleport to="#root">
    <transition enter-active-class="animated-fast fadeIn" leave-active-class="animated-fast fadeOut">
      <div v-show="show" :class="$style.mask" @click="emit('update:show', false)">
        <section :class="$style.panel" @click.stop>
          <header :class="$style.header">
            <h2>{{ $t('player__play_queue') }}</h2>
            <span>{{ queueSummary }}</span>
          </header>
          <div class="scroll" :class="$style.content">
            <button
              v-for="item in currentQueueItems"
              :key="item.key"
              type="button"
              :class="[$style.song, $style.current]"
              @click="handlePlayQueueItem(item)"
            >
              <span :class="$style.mark">{{ $t('player__play_queue_current') }}</span>
              <span :class="$style.name">{{ item.musicInfo.name }}</span>
              <span :class="$style.singer">{{ item.musicInfo.singer }}</span>
            </button>
            <template v-if="tempQueueItems.length">
              <p :class="$style.groupTitle">{{ $t('player__play_queue_later') }}</p>
              <button
                v-for="item in tempQueueItems"
                :key="item.key"
                type="button"
                :class="$style.song"
                @click="handlePlayQueueItem(item)"
              >
                <span :class="$style.index">{{ item.displayIndex }}</span>
                <span :class="$style.name">{{ item.musicInfo.name }}</span>
                <span :class="$style.singer">{{ item.musicInfo.singer }}</span>
              </button>
            </template>
            <template v-if="pendingQueueItems.length">
              <p :class="$style.groupTitle">{{ $t('player__play_queue_pending') }}</p>
              <button
                v-for="item in pendingQueueItems"
                :key="item.key"
                type="button"
                :class="$style.song"
                @click="handlePlayQueueItem(item)"
              >
                <span :class="$style.index">{{ item.displayIndex }}</span>
                <span :class="$style.name">{{ item.musicInfo.name }}</span>
                <span :class="$style.singer">{{ item.musicInfo.singer }}</span>
              </button>
            </template>
            <div v-if="!queueItems.length" :class="$style.empty">
              {{ $t('player__play_queue_empty') }}
            </div>
          </div>
        </section>
      </div>
    </transition>
  </teleport>
</template>

<script setup lang="ts">
import { computed } from '@common/utils/vueTools'
import { LIST_IDS } from '@common/constants'
import { playList, playMusicByInfo } from '@renderer/core/player'
import { getList } from '@renderer/store/player/action'
import { playInfo, playMusicInfo, tempPlayList } from '@renderer/store/player/state'

interface QueueItem {
  key: string
  displayIndex: number
  listId: string | null
  listIndex: number
  musicInfo: LX.Music.MusicInfo
  isCurrent: boolean
  isTempPlay: boolean
  isPlayLater: boolean
}

defineProps<{
  show: boolean
}>()

const emit = defineEmits<(event: 'update:show', value: boolean) => void>()

const toMusicInfo = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem): LX.Music.MusicInfo => {
  return 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
}

const createMusicIdentity = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem | null | undefined) => {
  if (!musicInfo) return ''
  const targetMusicInfo = toMusicInfo(musicInfo)
  return `${targetMusicInfo.source}:${targetMusicInfo.id}`
}

const queueItems = computed<QueueItem[]>(() => {
  const items: QueueItem[] = []
  const currentIdentity = createMusicIdentity(playMusicInfo.musicInfo)
  const currentListId = playInfo.playerListId
  const currentList = currentListId ? getList(currentListId) : []

  if (playMusicInfo.musicInfo) {
    items.push({
      key: `current-${currentIdentity}`,
      displayIndex: 0,
      listId: playMusicInfo.listId,
      listIndex: playInfo.playIndex,
      musicInfo: toMusicInfo(playMusicInfo.musicInfo),
      isCurrent: true,
      isTempPlay: playMusicInfo.isTempPlay,
      isPlayLater: false,
    })
  }

  tempPlayList.forEach((item, index) => {
    items.push({
      key: `later-${index}-${createMusicIdentity(item.musicInfo)}`,
      displayIndex: index + 1,
      listId: item.listId,
      listIndex: -1,
      musicInfo: toMusicInfo(item.musicInfo),
      isCurrent: false,
      isTempPlay: true,
      isPlayLater: true,
    })
  })

  if (currentList.length) {
    const startIndex = Math.max(playInfo.playerPlayIndex + 1, 0)
    currentList.slice(startIndex).forEach((musicInfo, index) => {
      const listIndex = startIndex + index
      const identity = createMusicIdentity(musicInfo)
      if (identity && identity == currentIdentity) return
      items.push({
        key: `pending-${listIndex}-${identity}`,
        displayIndex: index + 1,
        listId: currentListId,
        listIndex,
        musicInfo: toMusicInfo(musicInfo),
        isCurrent: false,
        isTempPlay: false,
        isPlayLater: false,
      })
    })
  }

  return items
})

const currentQueueItems = computed(() => queueItems.value.filter(item => item.isCurrent))
const tempQueueItems = computed(() => queueItems.value.filter(item => item.isPlayLater))
const pendingQueueItems = computed(() => queueItems.value.filter(item => !item.isCurrent && !item.isPlayLater))
const queueSummary = computed(() => {
  const count = pendingQueueItems.value.length + tempQueueItems.value.length
  return count ? window.i18n.t('player__play_queue_count', { num: count }) : window.i18n.t('player__play_queue_empty')
})

const handlePlayQueueItem = (item: QueueItem) => {
  if (item.isCurrent) return
  if (!item.isPlayLater && item.listId && item.listId != LIST_IDS.PLAY_LATER && item.listIndex > -1) {
    playList(item.listId, item.listIndex)
    emit('update:show', false)
    return
  }

  playMusicByInfo(item.musicInfo, {
    listId: item.listId,
    isTempPlay: true,
    clearTempList: false,
  })
  emit('update:show', false)
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.mask {
  position: absolute;
  inset: 0;
  z-index: 30;
  pointer-events: auto;
}

.panel {
  position: absolute;
  right: 18px;
  bottom: 92px;
  width: min(390px, calc(100vw - 36px));
  height: min(430px, calc(100vh - 132px));
  min-height: 240px;
  display: flex;
  flex-flow: column nowrap;
  overflow: hidden;
  border-radius: 8px;
  background-color: var(--color-surface-background);
  border: 1px solid var(--color-glass-border);
  box-shadow: 0 16px 46px rgba(0, 0, 0, 0.18);
  backdrop-filter: saturate(180%) blur(24px);
}

.header {
  flex: none;
  min-height: 54px;
  padding: 12px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: var(--color-list-header-border-bottom);

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    color: var(--color-font);
  }

  span {
    min-width: 0;
    font-size: 12px;
    color: var(--color-font-label);
    .mixin-ellipsis-1();
  }
}

.content {
  flex: auto;
  min-height: 0;
  padding: 8px;
  box-sizing: border-box;
}

.song {
  width: 100%;
  min-height: 42px;
  border: none;
  border-radius: 6px;
  padding: 7px 8px;
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  grid-template-areas:
    "index name"
    "index singer";
  gap: 2px 8px;
  background-color: transparent;
  color: var(--color-font);
  text-align: left;
  cursor: pointer;
  transition: background-color @transition-fast, opacity @transition-fast;

  &:hover {
    background-color: var(--color-button-background-hover);
  }

  &:active {
    opacity: .72;
  }
}

.current {
  background-color: var(--color-button-background);
  cursor: default;

  &:hover {
    background-color: var(--color-button-background);
  }
}

.index,
.mark {
  grid-area: index;
  align-self: center;
  justify-self: center;
  color: var(--color-font-label);
  font-size: 12px;
}

.mark {
  color: var(--color-primary);
  font-weight: 700;
}

.name {
  grid-area: name;
  font-size: 13px;
  line-height: 1.3;
  .mixin-ellipsis-1();
}

.singer {
  grid-area: singer;
  font-size: 12px;
  line-height: 1.3;
  color: var(--color-font-label);
  .mixin-ellipsis-1();
}

.groupTitle {
  margin: 12px 8px 5px;
  font-size: 12px;
  color: var(--color-font-label);
}

.empty {
  height: 100%;
  min-height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-font-label);
  font-size: 13px;
}
</style>
