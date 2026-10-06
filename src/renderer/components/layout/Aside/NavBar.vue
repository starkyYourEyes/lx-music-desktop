<template>
  <div :class="$style.menu">
    <div class="scroll" :class="[$style.mainMenus, { [$style.scrollbarHidden]: !appSetting['common.isShowSidebarScrollbar'] }]">
      <ul :class="[$style.list, $style.providers]" role="toolbar">
        <li v-for="item in providerMenus" :key="item.to" :class="$style.navItem" role="presentation">
          <router-link :class="[$style.link, $style.providerLink, { [$style.active]: isActive(item.name) }]" :to="item.to" :aria-label="item.tips" :aria-current="isActive(item.name) ? 'page' : undefined">
            <img :class="$style.providerLogo" :src="item.logo" alt="" draggable="false">
          </router-link>
        </li>
      </ul>
      <ul :class="[$style.list, $style.pages]" role="toolbar">
        <li v-for="item in mainMenus" v-show="item.enable" :key="item.to" :class="$style.navItem" role="presentation">
          <router-link
            :class="[$style.link, { [$style.active]: isActive(item.name) }]" :to="item.to"
            :aria-label="item.tips" :aria-current="isActive(item.name) ? 'page' : undefined"
          >
            <svg :class="$style.pageIcon" xmlns="http://www.w3.org/2000/svg" :viewBox="item.iconSize" aria-hidden="true"><use :xlink:href="item.icon" /></svg>
            <span :class="$style.label">{{ item.tips }}</span>
          </router-link>
        </li>
      </ul>
    </div>
    <MyList :list-id="activeListId" />
    <ul v-if="!isSettingInAccountMenu" :class="[$style.list, $style.bottomMenus]" role="toolbar">
      <li v-for="item in bottomMenus" :key="item.to" :class="$style.navItem" role="presentation">
        <router-link :class="[$style.link, { [$style.active]: isActive(item.name) }]" :to="item.to" :aria-label="item.tips" :aria-current="isActive(item.name) ? 'page' : undefined">
          <svg :class="$style.pageIcon" xmlns="http://www.w3.org/2000/svg" :viewBox="item.iconSize" aria-hidden="true"><use :xlink:href="item.icon" /></svg>
          <span :class="$style.label">{{ item.tips }}</span>
        </router-link>
      </li>
    </ul>
  </div>
</template>

<script lang="ts">
import { getFeatureForPath, isFeatureEnabled } from '@common/performance/featurePolicy'
import { appSetting } from '@renderer/store/setting'
import { useI18n } from '@root/lang'
import { computed } from '@common/utils/vueTools'
import { useRoute } from '@common/utils/vueRouter'
import MyList from '@renderer/views/List/MyList/index.vue'
import neteaseMusicLogo from '@renderer/assets/images/providers/netease-music.svg'
import qqMusicLogo from '@renderer/assets/images/providers/qq-music.svg'
import kugouMusicLogo from '@renderer/assets/images/providers/kugou-music.svg'

const providers = [
  { to: '/recommend', tips: 'netease_recommend', logo: neteaseMusicLogo, name: 'Recommend' },
  { to: '/qq-recommend', tips: 'qq_recommend', logo: qqMusicLogo, name: 'QQRecommend' },
  { to: '/kg-recommend', tips: 'kugou_recommend', logo: kugouMusicLogo, name: 'KugouRecommend' },
] as const

const menuList = [
  { to: '/cloud-disk', tips: 'cloud_disk', icon: '#icon-cloud-outline', iconSize: '0 0 24 24', name: 'CloudDisk' },
  { to: '/local-music', tips: 'local_music', icon: '#icon-musicFolder', iconSize: '0 0 247.498 247.498', name: 'LocalMusic' },
  { to: '/recent-play', tips: 'recent_play', icon: '#icon-recent-play', iconSize: '0 0 24 24', name: 'RecentPlay' },
  { to: '/download', tips: 'download', icon: '#icon-download-2', iconSize: '0 0 425.2 425.2', name: 'Download' },
  { to: '/setting', tips: 'setting', icon: '#icon-setting', iconSize: '0 0 493.23 436.47', name: 'Setting' },
] as const

export default {
  name: 'NavBar',
  components: { MyList },
  setup() {
    const t = useI18n()
    const route = useRoute()
    const activeListId = computed(() => route.path == '/list' && typeof route.query.id == 'string' ? route.query.id : '')
    const isActive = (name: string) => route.meta.name == name
    const providerMenus = computed(() => providers.filter(item => isFeatureEnabled(appSetting, getFeatureForPath(item.to)!)).map(item => ({ ...item, tips: t(item.tips) })))
    const menus = computed(() => menuList.map(item => ({
      ...item,
      tips: t(item.tips),
      enable: item.name == 'Download' ? appSetting['download.enable'] : true,
    })))
    const mainMenus = computed(() => menus.value.filter(item => item.name != 'Setting'))
    const bottomMenus = computed(() => menus.value.filter(item => item.name == 'Setting'))
    const isSettingInAccountMenu = computed(() => appSetting['common.sidebarSettingLocation'] == 'accountMenu')
    return { appSetting, activeListId, isActive, providerMenus, mainMenus, bottomMenus, isSettingInAccountMenu }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.menu {
  flex: auto;
  display: flex;
  flex-flow: column nowrap;
  min-height: 0;
  min-width: 0;
  -webkit-app-region: no-drag;
}
.list {
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}
.mainMenus {
  flex: 0 1 auto;
  min-height: 0;
  overflow-y: auto;

  &.scrollbarHidden::-webkit-scrollbar {
    width: 0;
    height: 0;
  }
}
.providers {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sidebar-gap);
  padding-bottom: var(--sidebar-gap);
}
.pages {
  display: flex;
  flex-flow: column nowrap;
  gap: calc(3px * var(--sidebar-scale));
  padding-bottom: var(--sidebar-gap);
}
.navItem {
  min-width: 0;
  flex: none;
}
.bottomMenus {
  flex: none;
  padding-top: calc(6px * var(--sidebar-scale));
  border-top: var(--color-list-header-border-bottom);
}
.link {
  width: 100%;
  min-height: calc(36px * var(--sidebar-scale));
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: var(--sidebar-gap);
  padding: calc(6px * var(--sidebar-scale)) var(--sidebar-gap);
  border-radius: 8px;
  color: var(--color-nav-font);
  cursor: pointer;
  text-decoration: none;
  transition: background-color @transition-fast, box-shadow @transition-fast, color @transition-fast;

  &.active {
    background-color: rgba(255, 255, 255, .72);
    box-shadow: var(--shadow-soft);
    &:hover { background-color: rgba(255, 255, 255, .86); }
  }
  &:hover {
    color: var(--color-nav-font);
    &:not(.active) { background-color: rgba(255, 255, 255, .38); }
  }
  &:active:not(.active) { background-color: var(--color-primary-light-300-alpha-600); }
  &:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; }
}
.providerLink {
  height: calc(50px * var(--sidebar-scale));
  justify-content: center;
  background-color: var(--color-primary-background-hover);
}
.providerLogo {
  display: block;
  width: calc(30px * var(--sidebar-scale));
  height: calc(30px * var(--sidebar-scale));
  object-fit: contain;
}
.pageIcon {
  flex: none;
  width: calc(20px * var(--sidebar-scale));
  height: calc(20px * var(--sidebar-scale));
}
.label {
  min-width: 0;
  font-size: var(--sidebar-navigation-font-size);
  line-height: 1.4;
  overflow-wrap: anywhere;
}
</style>
