<template>
  <material-popup-btn ref="btn_ref" :class="$style.btnContent">
    <button :class="$style.btn" :aria-label="currentPrivateFmMode.name">
      <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" space="preserve">
        <use :xlink:href="currentPrivateFmMode.icon" />
      </svg>
    </button>
    <template #content>
      <div :class="$style.setting">
        <button
          v-for="mode in privateFmModes"
          :key="mode.id"
          :class="[$style.btn, { [$style.active]: mode.id == privateFmModeId }]"
          :aria-label="mode.name"
          @click="toggleMode(mode.id)"
        >
          <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" space="preserve">
            <use :xlink:href="mode.icon" />
          </svg>
        </button>
      </div>
    </template>
  </material-popup-btn>
</template>

<script setup lang="ts">
import { ref } from '@common/utils/vueTools'
import { setPrivateFmMode } from '@renderer/store/privateFm/action'
import { currentPrivateFmMode, privateFmModeId, privateFmModes } from '@renderer/store/privateFm/state'

const btn_ref = ref<{ hide: () => void } | null>(null)

const toggleMode = (mode: LX.Netease.PrivateFmModeId) => {
  btn_ref.value?.hide()
  void setPrivateFmMode(mode)
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.btnContent {
  flex: none;
  width: 30px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.btn {
  flex: none;
  width: 30px;
  height: 32px;
  border: none;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-button-font);
  background-color: transparent;
  cursor: pointer;
  transition: color @transition-fast, opacity @transition-fast;
  opacity: .68;

  svg {
    width: 22px;
    height: 22px;
    fill: currentColor;
    filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.2));
  }

  &:hover,
  &:active {
    opacity: 1;
  }
}

.active {
  color: var(--color-primary);
  opacity: 1;
}

.setting {
  display: flex;
  flex-flow: row nowrap;
  gap: 10px;
}
</style>
