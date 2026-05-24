<template>
  <div :class="[$style.aside, { [$style.fullscreen]: isFullscreen }]">
    <ControlBtns v-if="appSetting['common.controlBtnPosition'] == 'left'" />
    <div v-else :class="$style.account" data-account-popover>
      <button type="button" :class="[$style.logo, { [$style.logged]: !!logoProfile?.avatarUrl }]" :aria-label="logoProfile?.nickname || 'LX Music'" @click="handleLogoClick">
        <img v-if="logoProfile?.avatarUrl" :class="$style.avatar" :src="logoProfile.avatarUrl" draggable="false" @error="handleAvatarError">
        <span v-else>L X</span>
      </button>
      <transition enter-active-class="animated fadeIn" leave-active-class="animated fadeOut">
        <div v-if="isShowAccountPopover" :class="$style.accountPopover">
          <div v-if="logoProfile?.nickname" :class="$style.accountName">{{ logoProfile.nickname }}</div>
          <button type="button" @click="handleAccountAction">{{ isLoggedIn ? '退出登录' : '登录网易云' }}</button>
        </div>
      </transition>
    </div>
    <NavBar />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from '@common/utils/vueTools'
import { useRouter } from '@common/utils/vueRouter'
import { isFullscreen } from '@renderer/store'
import { appSetting } from '@renderer/store/setting'
import { initNeteaseAccount, isLoggedIn, logoutNeteaseAccount, profile as neteaseProfile } from '@renderer/store/netease'

import ControlBtns from './ControlBtns.vue'
import NavBar from './NavBar.vue'

const router = useRouter()
const isAvatarLoadFailed = ref(false)
const isShowAccountPopover = ref(false)
const logoProfile = computed(() => isAvatarLoadFailed.value ? null : neteaseProfile.value)

watch(neteaseProfile, () => {
  isAvatarLoadFailed.value = false
})

const handleAvatarError = () => {
  isAvatarLoadFailed.value = true
}

const handleLogoClick = () => {
  isShowAccountPopover.value = !isShowAccountPopover.value
}

const handleAccountAction = async() => {
  isShowAccountPopover.value = false
  if (isLoggedIn.value) {
    await logoutNeteaseAccount()
    return
  }
  window.dispatchEvent(new Event('show-netease-login'))
  void router.push({
    path: '/recommend',
    query: {
      login: '1',
    },
  }).catch(_ => _)
}

onMounted(() => {
  void initNeteaseAccount().catch(() => null)
  window.addEventListener('click', handleWindowClick, true)
})

const handleWindowClick = (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest('[data-account-popover]')) return
  isShowAccountPopover.value = false
}

onBeforeUnmount(() => {
  window.removeEventListener('click', handleWindowClick, true)
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

.account {
  position: relative;
  margin: 6px auto 14px;
  -webkit-app-region: no-drag;
}

.logo {
  box-sizing: border-box;
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

.accountPopover {
  position: absolute;
  left: 68px;
  top: 4px;
  z-index: 8;
  width: 132px;
  padding: 8px;
  box-sizing: border-box;
  border-radius: 8px;
  background-color: var(--color-main-background);
  box-shadow: var(--shadow-soft);
  color: var(--color-font);

  &:before {
    content: '';
    position: absolute;
    left: -6px;
    top: 18px;
    width: 12px;
    height: 12px;
    background-color: inherit;
    transform: rotate(45deg);
  }

  button {
    position: relative;
    width: 100%;
    height: 32px;
    border: 0;
    border-radius: 6px;
    background-color: transparent;
    color: var(--color-font);
    cursor: pointer;
    font-size: 13px;
    transition: background-color @transition-normal, color @transition-normal;

    &:hover {
      color: var(--color-primary);
      background-color: var(--color-button-background-hover);
    }

    &:active {
      background-color: var(--color-button-background-active);
    }
  }
}

.accountName {
  position: relative;
  margin-bottom: 8px;
  color: var(--color-font-label);
  font-size: 12px;
  line-height: 1.3;
  .mixin-ellipsis-1();
}

.avatar {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

</style>
