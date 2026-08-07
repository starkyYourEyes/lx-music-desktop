<template>
  <div :class="$style.cell">
    <common-track-artwork :music-info="musicInfo" :size="artworkSize" />
    <div :class="$style.text">
      <div :class="$style.titleLine">
        <span class="select" :class="$style.title" :aria-label="title">{{ title }}</span>
        <slot />
      </div>
      <span class="select" :class="$style.artist" :aria-label="artist">{{ artist }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  musicInfo: LX.Music.MusicInfo | null
  title: string
  artist: string
  artworkSize: number
}>()
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.cell {
  width: 100%;
  height: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.text {
  min-width: 0;
  flex: auto;
  display: flex;
  flex-flow: column nowrap;
  justify-content: center;
  gap: 3px;
}

.titleLine {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
}

.title {
  min-width: 0;
  .mixin-ellipsis-1();
}

.artist {
  color: var(--color-font-label);
  font-size: .86em;
  .mixin-ellipsis-1();
}
</style>
