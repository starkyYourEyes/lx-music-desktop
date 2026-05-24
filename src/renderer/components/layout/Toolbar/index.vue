<template>
  <div :class="[$style.toolbar, { [$style.fullscreen]: isFullscreen }, appSetting['common.controlBtnPosition'] == 'left' ? $style.controlBtnLeft : $style.controlBtnRight]">
    <div :class="$style.leftTools">
      <button type="button" :class="$style.backBtn" aria-label="返回上一级" title="返回上一级" @click="handleBack">
        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" height="54%" viewBox="0 0 451.847 451.847" space="preserve">
          <use xlink:href="#icon-left" />
        </svg>
      </button>
      <SearchInput />
    </div>
    <div v-if="appSetting['common.controlBtnPosition'] == 'left'" :class="$style.logo">L X</div>
    <ControlBtns v-else />
  </div>
</template>

<script setup>
import { isFullscreen } from '@renderer/store'
import { appSetting } from '@renderer/store/setting'
import { useRouter } from '@common/utils/vueRouter'
import ControlBtns from './ControlBtns.vue'
import SearchInput from './SearchInput.vue'

const router = useRouter()
const handleBack = () => {
  router.back()
}

</script>


<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.toolbar {
  display: flex;
  height: @height-toolbar;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px 0 18px;
  -webkit-app-region: drag;
  z-index: 2;
  background-color: var(--color-surface-background);
  backdrop-filter: saturate(180%) blur(20px);
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);

  &.fullscreen {
    -webkit-app-region: no-drag;
    .logo {
      display: none;
    }
  }

  &.controlBtnLeft {
    .control {
      display: none;
    }
  }
  &.controlBtnRight {
    justify-content: space-between;
  }
}

.leftTools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}

.backBtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  padding: 0;
  border: none;
  border-radius: 8px;
  outline: none;
  background: transparent;
  color: var(--color-font-label);
  cursor: pointer;
  transition: background-color .2s ease, color .2s ease;
  -webkit-app-region: no-drag;

  &:hover {
    color: var(--color-primary);
    background-color: var(--color-button-background-hover);
  }
}

.logo {
  box-sizing: border-box;
  padding: 0 @height-toolbar * .4;
  height: @height-toolbar;
  color: var(--color-primary);
  flex: none;
  text-align: center;
  line-height: @height-toolbar;
  font-weight: bold;
  // -webkit-app-region: no-drag;
}

</style>
