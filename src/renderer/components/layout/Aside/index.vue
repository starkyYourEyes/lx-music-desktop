<template>
  <div :class="[$style.aside, { [$style.fullscreen]: isFullscreen }]">
    <ControlBtns v-if="appSetting['common.controlBtnPosition'] == 'left'" />
    <button v-else type="button" :class="[$style.logo, { [$style.logged]: !!logoProfile?.avatarUrl }]" :aria-label="logoProfile?.nickname || 'LX Music'" @click="handleLogoClick">
      <img v-if="logoProfile?.avatarUrl" :class="$style.avatar" :src="logoProfile.avatarUrl" draggable="false" @error="handleAvatarError">
      <span v-else>L X</span>
    </button>
    <NavBar />
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from '@common/utils/vueTools'
import { useRouter } from '@common/utils/vueRouter'
import { isFullscreen } from '@renderer/store'
import { appSetting } from '@renderer/store/setting'
import { initNeteaseAccount, profile as neteaseProfile } from '@renderer/store/netease'

import ControlBtns from './ControlBtns.vue'
import NavBar from './NavBar.vue'

const router = useRouter()
const isAvatarLoadFailed = ref(false)
const logoProfile = computed(() => isAvatarLoadFailed.value ? null : neteaseProfile.value)

watch(neteaseProfile, () => {
  isAvatarLoadFailed.value = false
})

const handleAvatarError = () => {
  isAvatarLoadFailed.value = true
}

const handleLogoClick = () => {
  void router.push('/recommend')
}

onMounted(() => {
  void initNeteaseAccount().catch(() => null)
})

</script>


<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.aside {
  // box-shadow: 0 0 5px rgba(0, 0, 0, .3);
  transition: @transition-normal;
  transition-property: background-color;
  // background-color: @color-theme-sidebar;
  // background-color: @color-aside-background;
  // border-right: 2px solid var(--color-primary);
  -webkit-app-region: drag;
  -webkit-user-select: none;
  display: flex;
  flex-flow: column nowrap;
  padding: 8px 8px 12px;
  box-sizing: border-box;

  &.fullscreen {
    -webkit-app-region: no-drag;
    .logo {
      display: none;
    }
  }
}

.logo {
  box-sizing: border-box;
  margin: 6px auto 14px;
  height: 60px;
  width: 60px;
  color: var(--color-nav-font);
  opacity: .9;
  flex: none;
  text-align: center;
  line-height: 60px;
  font-weight: bold;
  border-radius: 16px;
  border: 0;
  padding: 0;
  background-color: rgba(255, 255, 255, 0.42);
  box-shadow: var(--shadow-soft);
  backdrop-filter: saturate(180%) blur(18px);
  cursor: pointer;
  overflow: hidden;
  -webkit-app-region: no-drag;
  transition: @transition-fast;
  transition-property: transform, box-shadow, background-color, opacity;

  &:hover {
    background-color: rgba(255, 255, 255, 0.72);
    transform: translateY(-1px);
  }

  &:active {
    opacity: .8;
    transform: translateY(0);
  }

  &.logged {
    background-color: rgba(255, 255, 255, 0.72);
  }
}

.avatar {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

</style>
