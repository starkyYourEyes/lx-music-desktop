<template>
  <button
    type="button"
    :class="$style.coverPlayBtn"
    :aria-label="label"
  >
    <svg v-if="playing" version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024" space="preserve">
      <use xlink:href="#icon-pause" />
    </svg>
    <svg v-else version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024" space="preserve">
      <use xlink:href="#icon-play" />
    </svg>
  </button>
</template>

<script setup lang="ts">
defineProps<{
  label: string
  playing: boolean
}>()
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.coverPlayBtn {
  position: absolute;
  z-index: 2;
  left: 50%;
  top: 50%;
  width: 42px;
  height: 42px;
  padding: 12px;
  border: 0;
  border-radius: 50%;
  color: #fff;
  background-color: rgba(0, 0, 0, .38);
  opacity: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transform: translate(-50%, -50%) scale(.86);
  backdrop-filter: blur(10px);
  filter: drop-shadow(0 6px 14px rgba(0, 0, 0, .28));
  transition: opacity @transition-fast, transform @transition-fast, background-color @transition-fast;

  svg {
    width: 100%;
    height: 100%;
    fill: currentColor;
  }

  &:hover {
    background-color: rgba(0, 0, 0, .52);
  }
}
</style>
