<template>
  <div :class="[$style.aside, { [$style.fullscreen]: isFullscreen }]">
    <ControlBtns v-if="appSetting['common.controlBtnPosition'] == 'left'" />
    <div :class="$style.account" data-account-popover>
      <button type="button" :class="[$style.logo, { [$style.logged]: !!logoProfile?.avatarUrl }]" :aria-label="logoProfile?.nickname || 'LX Music'" @click="handleLogoClick">
        <img v-if="logoProfile?.avatarUrl" :class="$style.avatar" :src="logoProfile.avatarUrl" draggable="false" @error="handleAvatarError">
        <span v-else>L X</span>
      </button>
      <transition enter-active-class="animated fadeIn" leave-active-class="animated fadeOut">
        <div v-if="isShowAccountPopover" :class="$style.accountPopover">
          <div :class="$style.providerRow">
            <span :class="$style.providerMarker" aria-hidden="true">Q</span>
            <span :class="$style.providerInfo">
              <span :class="$style.providerName">QQ 音乐</span>
              <span :class="$style.providerAccount" :title="qqProfile?.nickname || ''">
                {{ qqProfile?.nickname || (qqIsLoggedIn ? '已登录' : '未登录') }}
              </span>
            </span>
            <button
              type="button"
              :class="$style.providerAction"
              :aria-label="qqIsLoggedIn ? '退出 QQ 音乐账号' : '登录 QQ 音乐账号'"
              @click="handleQQMusicAction"
            >{{ qqIsLoggedIn ? '退出' : '登录' }}</button>
          </div>
          <div :class="$style.providerRow">
            <span :class="$style.providerMarker" aria-hidden="true">N</span>
            <span :class="$style.providerInfo">
              <span :class="$style.providerName">网易云音乐</span>
              <span :class="$style.providerAccount" :title="neteaseProfile?.nickname || ''">
                {{ neteaseProfile?.nickname || (neteaseIsLoggedIn ? '已登录' : '未登录') }}
              </span>
            </span>
            <button
              type="button"
              :class="$style.providerAction"
              :aria-label="neteaseIsLoggedIn ? '退出网易云音乐账号' : '登录网易云音乐账号'"
              @click="handleNeteaseAction"
            >{{ neteaseIsLoggedIn ? '退出' : '登录' }}</button>
          </div>
          <button
            v-if="isSettingInAccountMenu"
            type="button"
            :class="[$style.settingsAction, $style.settingsSeparator]"
            :aria-label="$t('setting')"
            @click="handleSettingClick"
          >
            <svg :class="$style.settingsActionIcon" version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 493.23 436.47" aria-hidden="true">
              <use xlink:href="#icon-setting" />
            </svg>
            <span>{{ $t('setting') }}</span>
          </button>
        </div>
      </transition>
    </div>
    <NavBar />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from '@common/utils/vueTools'
import { useRoute, useRouter } from '@common/utils/vueRouter'
import { isFullscreen } from '@renderer/store'
import { appSetting } from '@renderer/store/setting'
import { initNeteaseAccount, isLoggedIn as neteaseIsLoggedIn, logoutNeteaseAccount, profile as neteaseProfile } from '@renderer/store/netease'
import { initQQMusicAccount, isLoggedIn as qqIsLoggedIn, logoutQQMusicAccount, profile as qqProfile } from '@renderer/store/qqMusic'

import ControlBtns from './ControlBtns.vue'
import NavBar from './NavBar.vue'

const route = useRoute()
const router = useRouter()
const isAvatarLoadFailed = ref(false)
const isShowAccountPopover = ref(false)
const logoProfile = computed(() => isAvatarLoadFailed.value ? null : neteaseProfile.value)
const isSettingInAccountMenu = computed(() => appSetting['common.sidebarSettingLocation'] == 'accountMenu')

watch(neteaseProfile, () => {
  isAvatarLoadFailed.value = false
})

const handleAvatarError = () => {
  isAvatarLoadFailed.value = true
}

const handleLogoClick = () => {
  isShowAccountPopover.value = !isShowAccountPopover.value
}

const handleQQMusicAction = async() => {
  isShowAccountPopover.value = false
  if (qqIsLoggedIn.value) {
    await logoutQQMusicAccount()
    return
  }
  if (route.path == '/qq-recommend') window.dispatchEvent(new Event('show-qq-music-login'))
  void router.push({
    path: '/qq-recommend',
    query: {
      login: 'qq',
    },
  }).catch(_ => _)
}

const handleNeteaseAction = async() => {
  isShowAccountPopover.value = false
  if (neteaseIsLoggedIn.value) {
    await logoutNeteaseAccount()
    return
  }
  if (route.path == '/recommend') window.dispatchEvent(new Event('show-netease-login'))
  void router.push({
    path: '/recommend',
    query: {
      login: 'netease',
    },
  }).catch(_ => _)
}

const handleSettingClick = () => {
  isShowAccountPopover.value = false
  void router.push('/setting').catch(_ => _)
}

onMounted(() => {
  void Promise.all([
    initQQMusicAccount().catch(() => null),
    initNeteaseAccount().catch(() => null),
  ])
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
  width: 238px;
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

}

.providerRow {
  position: relative;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) 44px;
  align-items: center;
  column-gap: 8px;
  height: 54px;
  padding: 0 4px;
  box-sizing: border-box;

  & + & {
    border-top: 1px solid var(--color-button-background-hover);
  }
}

.providerMarker {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background-color: var(--color-button-background-hover);
  color: var(--color-primary);
  font-size: 13px;
  font-weight: bold;
}

.providerInfo {
  display: flex;
  flex-flow: column nowrap;
  justify-content: center;
  min-width: 0;
}

.providerName,
.providerAccount {
  display: block;
  min-width: 0;
  .mixin-ellipsis-1();
}

.providerName {
  color: var(--color-font);
  font-size: 13px;
  line-height: 20px;
}

.providerAccount {
  color: var(--color-font-label);
  font-size: 12px;
  line-height: 18px;
}

.providerAction {
  position: relative;
  width: 44px;
  height: 30px;
  padding: 0;
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

.settingsAction {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 44px;
  padding: 0 12px;
  box-sizing: border-box;
  border: 0;
  border-radius: 6px;
  background-color: transparent;
  color: var(--color-font);
  cursor: pointer;
  font-size: 13px;
  text-align: left;
  transition: background-color @transition-normal, color @transition-normal;

  &:hover {
    color: var(--color-primary);
    background-color: var(--color-button-background-hover);
  }

  &:active {
    background-color: var(--color-button-background-active);
  }
}

.settingsSeparator {
  border-top: 1px solid var(--color-button-background-hover);
}

.settingsActionIcon {
  width: 20px;
  height: 20px;
  flex: none;
}

.avatar {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

</style>
