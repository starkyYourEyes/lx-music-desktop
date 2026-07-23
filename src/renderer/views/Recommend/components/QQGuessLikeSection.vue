<template>
  <section v-if="!isLoggedIn && visibleWhenLoggedOut" :class="$style.stateSection">
    <div :class="$style.stateCopy">
      <h3>猜你喜欢</h3>
      <p>登录 QQ 音乐后获取猜你喜欢</p>
    </div>
    <base-btn min @click="$emit('login')">登录 QQ 音乐</base-btn>
  </section>

  <similar-songs-section
    v-else-if="isLoggedIn && songs.length"
    title="猜你喜欢"
    desc="推荐内容来自 QQ 音乐"
    :songs="songs"
    refreshable
    refresh-label="刷新 QQ 音乐猜你喜欢"
    :refreshing="isRefreshing"
    :is-section-playing="isSectionPlaying"
    :is-home-song-playing="isSongPlaying"
    :is-home-song-loved="isSongLoved"
    @refresh="$emit('refresh')"
    @play-all="$emit('play-all')"
    @play="$emit('play', $event)"
    @toggle-love="$emit('toggle-love', $event)"
  />

  <section v-else-if="isLoggedIn" :class="$style.stateSection">
    <div :class="$style.stateCopy">
      <h3>猜你喜欢</h3>
      <p v-if="isLoading || isRefreshing">正在从 QQ 音乐加载猜你喜欢...</p>
      <p v-else-if="loadError">{{ loadError }}</p>
      <p v-else>暂无猜你喜欢歌曲</p>
    </div>
    <base-btn v-if="loadError && !(isLoading || isRefreshing)" min @click="$emit('retry')">重试</base-btn>
  </section>
</template>

<script setup lang="ts">
import SimilarSongsSection from './SimilarSongsSection.vue'

withDefaults(defineProps<{
  visibleWhenLoggedOut: boolean
  isLoggedIn: boolean
  songs: LX.Music.MusicInfoOnline[]
  isLoading: boolean
  isRefreshing: boolean
  loadError: string
  isSectionPlaying?: boolean
  isSongPlaying: (song: LX.Music.MusicInfoOnline) => boolean
  isSongLoved: (song: LX.Music.MusicInfoOnline) => boolean
}>(), {
  isSectionPlaying: false,
})

defineEmits<{
  login: []
  retry: []
  refresh: []
  'play-all': []
  play: [index: number]
  'toggle-love': [song: LX.Music.MusicInfoOnline]
}>()
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.stateSection {
  min-width: 0;
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.stateCopy {
  min-width: 0;

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
    font-size: 13px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
}

@media (max-width: 480px) {
  .stateSection {
    align-items: flex-start;
    flex-flow: column nowrap;
    gap: 10px;
  }
}
</style>
