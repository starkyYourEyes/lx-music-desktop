<template>
  <div :class="$style.recentPlay">
    <div :class="$style.header">
      <div :class="$style.heading">
        <h2>{{ $t('recent_play') }}</h2>
        <p>{{ recentPlayList.length }} / {{ RECENT_PLAY_LIMIT }}</p>
      </div>
    </div>
    <div :class="$style.list">
      <div class="thead">
        <table>
          <thead>
            <tr>
              <th class="num" style="width: 5%;">#</th>
              <th class="nobreak">{{ $t('music_name') }}</th>
              <th class="nobreak" style="width: 22%;">{{ $t('music_singer') }}</th>
              <th class="nobreak" style="width: 22%;">{{ $t('music_album') }}</th>
              <th class="nobreak" style="width: 9%;">{{ $t('music_time') }}</th>
              <th class="nobreak" style="width: 8%;">{{ $t('list_sort_modal_by_source') }}</th>
              <th class="nobreak" style="width: 16%;">{{ $t('action') }}</th>
            </tr>
          </thead>
        </table>
      </div>
      <div v-if="recentPlayList.length" :class="$style.content">
        <base-virtualized-list
          :list="recentPlayItems"
          key-name="recentPlayKey"
          :item-height="listItemHeight"
          container-class="scroll"
          content-class="list"
        >
          <template #default="{ item, index }">
            <div
              class="list-item"
              :class="{ [$style.playing]: isCurrentMusic(item), active: selectedIndex == index }"
              @click="handleListItemClick(index)"
            >
              <div class="list-item-cell no-select" :class="$style.num" style="flex: 0 0 5%;">
                <transition name="play-active">
                  <div v-if="isCurrentMusic(item)" :class="$style.playIcon">
                    <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" height="50%" viewBox="0 0 287.386 287.386" space="preserve">
                      <use xlink:href="#icon-testPlay" />
                    </svg>
                  </div>
                  <div v-else class="num">{{ index + 1 }}</div>
                </transition>
              </div>
              <div class="list-item-cell auto name">
                <span class="select name" :aria-label="item.name">{{ item.name }}</span>
                <span v-if="item.meta?._qualitys?.flac24bit" class="no-select badge badge-theme-primary">{{ $t('tag__lossless_24bit') }}</span>
                <span v-else-if="item.meta?._qualitys?.ape || item.meta?._qualitys?.flac || item.meta?._qualitys?.wav" class="no-select badge badge-theme-primary">{{ $t('tag__lossless') }}</span>
                <span v-else-if="item.meta?._qualitys?.['320k']" class="no-select badge badge-theme-secondary">{{ $t('tag__high_quality') }}</span>
              </div>
              <div class="list-item-cell" style="flex: 0 0 22%;"><span class="select" :aria-label="item.singer">{{ item.singer || '--/--' }}</span></div>
              <div class="list-item-cell" style="flex: 0 0 22%;"><span class="select" :aria-label="item.meta?.albumName">{{ item.meta?.albumName || '--/--' }}</span></div>
              <div class="list-item-cell" style="flex: 0 0 9%;"><span class="no-select">{{ item.interval || '--/--' }}</span></div>
              <div class="list-item-cell" style="flex: 0 0 8%;"><span class="no-select">{{ getSourceName(item.source) }}</span></div>
              <div class="list-item-cell" style="flex: 0 0 16%; padding-left: 0; padding-right: 0;">
                <material-list-buttons :index="index" :download-btn="false" @btn-click="handleListBtnClick" />
              </div>
            </div>
          </template>
        </base-virtualized-list>
      </div>
      <div v-else :class="$style.noItem">
        <p>{{ $t('no_item') }}</p>
      </div>
    </div>
    <common-list-add-modal v-model:show="isShowListAdd" :music-info="selectedAddMusicInfo" teleport="#view" />
  </div>
</template>

<script setup>
import { computed, ref } from '@common/utils/vueTools'
import { useI18n } from '@root/lang'
import { playMusicByInfo } from '@renderer/core/player'
import { playMusicInfo } from '@renderer/store/player/state'
import { RECENT_PLAY_LIMIT } from '@renderer/store/recentPlay/action'
import { recentPlayList } from '@renderer/store/recentPlay/state'
import { appSetting } from '@renderer/store/setting'

const listItemHeight = 50
const selectedIndex = ref(-1)
const isShowListAdd = ref(false)
const selectedAddMusicInfo = ref(null)
const t = useI18n()

let clickTime = 0
let clickIndex = -1

const recentPlayItems = computed(() => recentPlayList.map(musicInfo => ({
  ...musicInfo,
  recentPlayKey: createMusicIdentity(musicInfo),
})))

const currentMusicInfo = computed(() => {
  const musicInfo = playMusicInfo.musicInfo
  return musicInfo && 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
})

const createMusicIdentity = (musicInfo) => {
  if (!musicInfo) return ''
  return `${musicInfo.source}:${musicInfo.id}`
}

const isCurrentMusic = (musicInfo) => {
  return createMusicIdentity(musicInfo) === createMusicIdentity(currentMusicInfo.value)
}

const getSourceName = (source) => {
  const key = appSetting['common.sourceNameType'] == 'alias' ? `source_alias_${source}` : `source_${source}`
  return t(key)
}

const handlePlayMusic = (index) => {
  const musicInfo = recentPlayItems.value[index]
  if (!musicInfo) return
  playMusicByInfo(musicInfo, {
    listId: null,
    isTempPlay: true,
    clearTempList: false,
  })
}

const doubleClickPlay = (index) => {
  if (
    window.performance.now() - clickTime > 400 ||
    clickIndex !== index
  ) {
    clickTime = window.performance.now()
    clickIndex = index
    return
  }
  handlePlayMusic(index)
  clickTime = 0
  clickIndex = -1
}

const handleListItemClick = (index) => {
  selectedIndex.value = index
  doubleClickPlay(index)
}

const handleShowListAddModal = (index) => {
  const musicInfo = recentPlayItems.value[index]
  if (!musicInfo) return
  selectedAddMusicInfo.value = musicInfo
  isShowListAdd.value = true
}

const handleListBtnClick = ({ action, index }) => {
  switch (action) {
    case 'play':
      handlePlayMusic(index)
      break
    case 'listAdd':
      handleShowListAddModal(index)
      break
  }
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.recentPlay {
  position: relative;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-flow: column nowrap;
}

.header {
  flex: none;
  padding: 22px 24px 8px;
}

.heading {
  display: flex;
  align-items: flex-end;
  gap: 12px;

  h2 {
    margin: 0;
    font-size: 30px;
    line-height: 1.2;
    color: var(--color-font);
    font-weight: 800;
  }

  p {
    margin: 0 0 4px;
    font-size: 13px;
    color: var(--color-font-label);
  }
}

.list {
  flex: auto;
  min-height: 0;
  display: flex;
  flex-flow: column nowrap;
  font-size: 14px;
}

.content {
  flex: auto;
  min-height: 0;
}

.num {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.playIcon {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-button-font);
  opacity: .7;
}

.playing {
  color: var(--color-button-font);
}

.noItem {
  position: relative;
  flex: auto;
  min-height: 0;
  display: flex;
  justify-content: center;
  align-items: center;

  p {
    font-size: 24px;
    color: var(--color-font-label);
  }
}
</style>
