<template>
  <section v-if="songs.length" :class="$style.homeSection">
    <div :class="$style.sectionTitleBar">
      <div>
        <h3>
          <span>{{ title }}</span>
          <button
            :class="$style.sectionPlayBtn"
            type="button"
            :aria-label="isSectionPlaying ? `暂停 ${title}` : `播放 ${title}`"
            @click="$emit('play-all')"
          >
            <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024" space="preserve">
              <use :xlink:href="isSectionPlaying ? '#icon-pause' : '#icon-play'" />
            </svg>
          </button>
        </h3>
        <p v-if="desc">{{ desc }}</p>
      </div>
      <div :class="$style.sectionActions">
        <section-refresh-button v-if="refreshable" :label="refreshLabel" :disabled="refreshing" @click="$emit('refresh')" />
      </div>
    </div>
    <div :class="$style.songGrid">
      <div
        v-for="(song, index) in songs"
        :key="song.id"
        :class="[$style.songCard, { [$style.currentSongCard]: isHomeSongPlaying(song) }]"
        role="button"
        tabindex="0"
        @dblclick="$emit('play', toNumberIndex(index))"
        @click="$emit('play', toNumberIndex(index))"
        @keydown.enter="$emit('play', toNumberIndex(index))"
        @keydown.space.prevent="$emit('play', toNumberIndex(index))"
      >
        <img v-if="song.meta.picUrl" :src="song.meta.picUrl" loading="lazy" decoding="async" draggable="false">
        <span v-else :class="$style.songCoverFallback">{{ song.name.slice(0, 1) }}</span>
        <span :class="$style.songText">
          <span>{{ song.name }}</span>
          <small>
            <em v-if="song.meta.recommendTag">{{ song.meta.recommendTag }}</em>
            <span>{{ song.singer || song.meta.albumName }}</span>
          </small>
        </span>
        <button
          :class="[$style.songLoveBtn, { [$style.loved]: isHomeSongLoved(song) }]"
          type="button"
          :aria-label="isHomeSongLoved(song) ? `取消收藏 ${song.name}` : `收藏 ${song.name}`"
          @click.stop="$emit('toggle-love', song)"
        >
          <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 830.33 740.22" space="preserve">
            <use :xlink:href="isHomeSongLoved(song) ? '#icon-love-fill' : '#icon-love'" />
          </svg>
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import SectionRefreshButton from './SectionRefreshButton.vue'

withDefaults(defineProps<{
  title: string
  desc?: string
  songs: LX.Music.MusicInfoOnline[]
  refreshing?: boolean
  refreshable?: boolean
  refreshLabel?: string
  isSectionPlaying?: boolean
  isHomeSongPlaying: (song: LX.Music.MusicInfoOnline) => boolean
  isHomeSongLoved: (song: LX.Music.MusicInfoOnline) => boolean
}>(), {
  desc: '',
  refreshing: false,
  refreshable: false,
  refreshLabel: '刷新歌曲',
  isSectionPlaying: false,
})

defineEmits<{
  refresh: []
  'play-all': []
  play: [index: number]
  'toggle-love': [song: LX.Music.MusicInfoOnline]
}>()

const toNumberIndex = (index: unknown) => Number(index)
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.homeSection {
  min-width: 0;
}

.sectionTitleBar {
  margin-bottom: 12px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;

  h3 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
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

.sectionActions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.sectionPlayBtn {
  flex: none;
  width: 27px;
  height: 27px;
  padding: 7px;
  border: 0;
  border-radius: 50%;
  color: var(--color-font);
  background-color: rgba(128, 128, 128, .08);
  opacity: .76;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity @transition-fast, transform @transition-fast, background-color @transition-fast;

  svg {
    width: 100%;
    height: 100%;
    fill: currentColor;
  }

  &:hover {
    opacity: 1;
    transform: scale(1.04);
    background-color: rgba(128, 128, 128, .14);
  }
}

.songGrid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 12px;
}

.songCard {
  min-width: 0;
  height: 58px;
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 38px;
  align-items: center;
  gap: 10px;
  padding: 8px 9px;
  box-sizing: border-box;
  border-radius: 8px;
  color: var(--color-font);
  cursor: pointer;
  transition: background-color @transition-normal;

  &:hover,
  &.currentSongCard {
    background-color: rgba(128, 128, 128, .1);

    .songLoveBtn {
      opacity: 1;
    }
  }

  img {
    width: 42px;
    height: 42px;
    border-radius: 7px;
    object-fit: cover;
  }
}

.songCoverFallback {
  width: 42px;
  height: 42px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-font-label);
  background-color: rgba(128, 128, 128, .12);
  font-weight: 700;
}

.songText {
  min-width: 0;
  display: flex;
  flex-flow: column nowrap;

  > span {
    color: var(--color-font);
    font-size: 13px;
    line-height: 1.2;
    font-weight: 700;
    .mixin-ellipsis-1();
  }

  small {
    margin-top: 4px;
    min-width: 0;
    color: var(--color-font-label);
    font-size: 12px;
    line-height: 1.1;
    display: flex;
    align-items: center;
    gap: 6px;
    .mixin-ellipsis-1();

    em {
      flex: none;
      max-width: 92px;
      height: 18px;
      padding: 0 6px;
      border-radius: 5px;
      color: var(--color-primary);
      background-color: var(--color-primary-background-hover);
      font-size: 11px;
      line-height: 18px;
      font-style: normal;
      font-weight: 700;
      .mixin-ellipsis-1();
    }

    span {
      min-width: 0;
      color: inherit;
      font-size: inherit;
      line-height: inherit;
      font-weight: inherit;
      .mixin-ellipsis-1();
    }
  }
}

.songLoveBtn {
  justify-self: center;
  align-self: center;
  width: 36px;
  height: 36px;
  padding: 7px;
  border: 0;
  border-radius: 50%;
  opacity: .58;
  color: var(--color-font);
  background-color: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity @transition-fast, background-color @transition-fast, color @transition-fast;

  svg {
    width: 100%;
    height: 100%;
    fill: currentColor;
  }

  &:hover {
    background-color: rgba(128, 128, 128, .14);
  }
}

.loved {
  color: var(--color-primary);
  opacity: 1;
}

@media (max-width: 980px) {
  .songGrid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .songGrid {
    grid-template-columns: 1fr;
  }
}
</style>
