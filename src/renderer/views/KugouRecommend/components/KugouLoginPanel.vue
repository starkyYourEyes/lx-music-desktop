<template>
  <div :class="$style.overlay">
    <div :class="$style.panel">
      <button :class="$style.close" type="button" :aria-label="closeLabel" @click="$emit('close')">x</button>
      <div :class="$style.qr">
        <img v-if="qrImg" :src="qrImg" draggable="false" @load="$emit('qr-load', $event)">
        <span v-else>{{ isCreatingQr ? creatingText : emptyText }}</span>
      </div>
      <h3>{{ title }}</h3>
      <p :class="$style.instruction">{{ instruction }}</p>
      <p :class="$style.status">{{ qrStatusText }}</p>
      <base-btn min :disabled="isCreatingQr" @click="$emit('refresh')">{{ refreshText }}</base-btn>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  instruction: string
  qrImg: string
  qrStatusText: string
  isCreatingQr: boolean
  creatingText: string
  emptyText: string
  refreshText: string
  closeLabel: string
}>()

defineEmits<{
  close: []
  refresh: []
  'qr-load': [event: Event]
}>()
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.overlay { position: absolute; inset: 0; z-index: 4; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; background-color: rgba(20, 28, 31, .28); backdrop-filter: blur(8px); }
.panel {
  position: relative; width: min(360px, 100%); padding: 28px; box-sizing: border-box; border: 1px solid rgba(128, 128, 128, .14); border-radius: 8px; color: var(--color-font); background-color: var(--color-main-background); box-shadow: 0 18px 42px rgba(31, 38, 35, .18); text-align: center;
  h3 { margin: 18px 0 8px; font-size: 18px; }
  p { min-height: 20px; color: var(--color-font-label); font-size: 13px; line-height: 1.5; }
}
.instruction { min-height: 40px; margin: 0 0 4px; }
.status { margin: 0 0 16px; }
.close { position: absolute; top: 10px; right: 12px; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; color: var(--color-font-label); background: transparent; font-size: 22px; line-height: 28px; cursor: pointer; &:hover { color: var(--color-font); background-color: rgba(128, 128, 128, .1); } }
.qr { width: 218px; height: 218px; margin: 0 auto; border-radius: 8px; overflow: hidden; color: var(--color-font-label); background-color: #fff; box-shadow: inset 0 0 0 1px rgba(128, 128, 128, .1); display: flex; align-items: center; justify-content: center; img { display: block; width: 100%; height: 100%; } }
</style>
