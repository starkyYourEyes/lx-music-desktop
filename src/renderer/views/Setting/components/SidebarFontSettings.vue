<template>
  <div :class="$style.fontSettings">
    <div v-for="item in SIDEBAR_FONT_SETTINGS" :key="item.id" :data-sidebar-font="item.id">
      <label :id="`sidebar_font_${item.id}_label`" :for="`sidebar_font_${item.id}`" :class="$style.label">{{ $t(`setting__basic_sidebar_font_${item.id}`) }}</label>
      <div :class="$style.controls">
        <input
          :id="`sidebar_font_${item.id}`" :class="$style.range" type="range" :min="SIDEBAR_FONT_SIZE_MIN" :max="SIDEBAR_FONT_SIZE_MAX" step="1"
          :aria-labelledby="`sidebar_font_${item.id}_label`" :value="sizeOf(item)" @input="setSize(item, $event.target.value)"
        >
        <base-input
          :class="$style.number" type="number" :min="SIDEBAR_FONT_SIZE_MIN" :max="SIDEBAR_FONT_SIZE_MAX" step="1"
          :aria-labelledby="`sidebar_font_${item.id}_label`" :model-value="inputs[item.id]"
          @update:model-value="inputs[item.id] = $event" @change="setSize(item, $event)"
        />
        <span :class="$style.unit">px</span>
        <button
          type="button" :class="$style.reset" :disabled="sizeOf(item) == item.defaultValue"
          :aria-label="$t('setting__basic_sidebar_font_reset', { name: $t(`setting__basic_sidebar_font_${item.id}`) })"
          :title="$t('setting__basic_sidebar_font_reset', { name: $t(`setting__basic_sidebar_font_${item.id}`) })" @click="resetSize(item)"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24"><use xlink:href="#icon-refresh" /></svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import { reactive, watch } from '@common/utils/vueTools'
import { appSetting, mergeSetting, updateSetting } from '@renderer/store/setting'
import { SIDEBAR_FONT_SETTINGS, SIDEBAR_FONT_SIZE_MIN, SIDEBAR_FONT_SIZE_MAX, normalizeSidebarFontSize } from '@common/utils/sidebarFontSize'

export default {
  name: 'SidebarFontSettings',
  setup() {
    const inputs = reactive({})
    const sizeOf = item => normalizeSidebarFontSize(appSetting[item.key], item.defaultValue)
    for (const item of SIDEBAR_FONT_SETTINGS) {
      watch(() => appSetting[item.key], () => { inputs[item.id] = sizeOf(item) }, { immediate: true })
    }
    const setSize = (item, value) => {
      const size = normalizeSidebarFontSize(value, item.defaultValue)
      inputs[item.id] = size
      const patch = { [item.key]: size }
      mergeSetting(patch)
      updateSetting(patch)
    }
    const resetSize = item => { setSize(item, item.defaultValue) }
    return { SIDEBAR_FONT_SETTINGS, SIDEBAR_FONT_SIZE_MIN, SIDEBAR_FONT_SIZE_MAX, inputs, sizeOf, setSize, resetSize }
  },
}
</script>

<style lang="less" module>
.fontSettings {
  margin-top: 16px;
  min-width: 0;
}
.label {
  display: block;
  margin: 12px 0 6px;
  line-height: 1.4;
}
.controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 64px auto 28px;
  align-items: center;
  gap: 8px;
  width: 360px;
  max-width: 100%;
}
.range {
  width: 100%;
  min-width: 0;
  margin: 0;
  accent-color: var(--color-primary);
  cursor: pointer;
}
.number {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  text-align: center;
}
.unit { color: var(--color-font-label); }
.reset {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  color: var(--color-primary);
  background: transparent;
  cursor: pointer;
  svg { width: 16px; height: 16px; }
  &:hover:not(:disabled) { background-color: var(--color-primary-background-hover); }
  &:disabled { opacity: .4; cursor: default; }
  &:focus-visible { outline: 1px solid var(--color-primary); outline-offset: -1px; }
}
</style>
