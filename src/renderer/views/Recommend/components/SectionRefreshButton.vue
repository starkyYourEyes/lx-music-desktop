<template>
  <button :class="$style.sectionRefreshBtn" type="button" :disabled="disabled" :aria-label="label">
    <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" space="preserve">
      <use xlink:href="#icon-refresh" />
    </svg>
  </button>
</template>

<script setup lang="ts">
defineProps<{
  label: string
  disabled?: boolean
}>()
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.sectionRefreshBtn {
  flex: none;
  width: 34px;
  height: 34px;
  padding: 8px;
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

  &:disabled {
    cursor: default;
    opacity: .38;
  }
}
</style>
