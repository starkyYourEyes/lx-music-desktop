<template>
  <div :class="$style.menu">
    <ul :class="$style.list" role="toolbar">
      <li v-for="(item, index) in mainMenus" v-show="item.enable" :key="item.to" :class="[$style.navItem, { [$style.separator]: index == 1 }]" role="presentation">
        <router-link :class="[$style.link, {[$style.active]: $route.meta.name == item.name}]" role="tab" :aria-selected="$route.meta.name == item.name" :to="item.to" :aria-label="item.tips">
          <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" :viewBox="item.iconSize" :height="item.size" :width="item.size" space="preserve">
            <use :xlink:href="item.icon" />
          </svg>
        </router-link>
      </li>
    </ul>
    <ul :class="[$style.list, $style.bottomMenus]" role="toolbar">
      <li v-for="item in bottomMenus" v-show="item.enable" :key="item.to" :class="$style.navItem" role="presentation">
        <router-link :class="[$style.link, {[$style.active]: $route.meta.name == item.name}]" role="tab" :aria-selected="$route.meta.name == item.name" :to="item.to" :aria-label="item.tips">
          <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" :viewBox="item.iconSize" :height="item.size" :width="item.size" space="preserve">
            <use :xlink:href="item.icon" />
          </svg>
        </router-link>
      </li>
    </ul>
  </div>
</template>

<script lang="ts">
import { appSetting } from '@renderer/store/setting'
import { useI18n } from '@root/lang'
import { computed } from '@common/utils/vueTools'

const iconSize = '32px'
const menuList = [
  {
    to: '/recommend',
    tips: 'recommend',
    icon: '#icon-thumbs-up',
    iconSize: '0 0 512 512',
    name: 'Recommend',
  },
  {
    to: '/list',
    tips: 'my_list',
    icon: '#icon-love',
    iconSize: '0 0 444.87 391.18',
    name: 'List',
  },
  {
    to: '/cloud-disk',
    tips: 'cloud_disk',
    icon: '#icon-cloud-outline',
    iconSize: '0 0 24 24',
    name: 'CloudDisk',
  },
  {
    to: '/recent-play',
    tips: 'recent_play',
    icon: '#icon-recent-play',
    iconSize: '0 0 24 24',
    name: 'RecentPlay',
  },
  {
    to: '/download',
    tips: 'download',
    icon: '#icon-download-2',
    iconSize: '0 0 425.2 425.2',
    name: 'Download',
  },
  {
    to: '/setting',
    tips: 'setting',
    icon: '#icon-setting',
    iconSize: '0 0 493.23 436.47',
    name: 'Setting',
  },
] as const

export default {
  name: 'NavBar',
  setup() {
    const t = useI18n()

    const menus = computed(() => menuList.map(item => ({
      ...item,
      tips: t(item.tips),
      size: iconSize,
      enable: item.name == 'Download' ? appSetting['download.enable'] : true,
    })))
    const mainMenus = computed(() => menus.value.filter(item => item.name != 'Setting'))
    const bottomMenus = computed(() => menus.value.filter(item => item.name == 'Setting'))

    return {
      appSetting,
      mainMenus,
      bottomMenus,
    }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.menu {
  flex: auto;
  display: flex;
  flex-flow: column nowrap;
  align-items: stretch;
  min-height: 0;
}
.list {
  -webkit-app-region: no-drag;
  width: 100%;
  &:last-child {
    margin-bottom: 0;
  }
}
.navItem {
  position: relative;
  margin: 10px 0;
  &:before {
    content: '';
    display: block;
    width: 100%;
    padding-bottom: 84%;
  }
}
.separator {
  margin-top: 28px;

  &:after {
    content: '';
    position: absolute;
    top: -16px;
    left: 50%;
    width: 28px;
    height: 1px;
    border-radius: 999px;
    background: linear-gradient(90deg, transparent, rgba(128, 128, 128, .36), transparent);
    transform: translateX(-50%);
  }
}
.bottomMenus {
  margin-top: auto;
}
.link {
  position: absolute;
  left: 0%;
  top: 0%;
  width: 62px;
  height: 62px;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  box-sizing: border-box;
  transition: @transition-fast;
  transition-property: background-color, box-shadow, color, opacity;
  color: var(--color-nav-font);
  cursor: pointer;
  text-align: center;
  outline: none;
  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 16px;
  .mixin-ellipsis-1();
  &:before {
    .mixin-after();
    left: 50%;
    top: auto;
    bottom: 6px;
    width: 18px;
    height: 3px;
    background-color: var(--color-primary-dark-200-alpha-700);
    border-radius: 999px;
    transform: translate(-50%, 7px) scaleX(.35);
    opacity: 0;
    transition: @transition-fast;
    transition-property: transform, opacity;
  }

  &.active {
    background-color: rgba(255, 255, 255, 0.72);
    box-shadow: var(--shadow-soft);

    &:before {
      transform: translate(-50%, 0) scaleX(1);
      opacity: 1;
    }

    &:hover {
      background-color: rgba(255, 255, 255, 0.86);
    }
  }

  &:hover {
    color: var(--color-nav-font);

    &:not(.active) {
      opacity: .8;
      background-color: rgba(255, 255, 255, 0.38);
    }
  }
  &:active:not(.active) {
    opacity: .6;
    background-color: var(--color-primary-light-300-alpha-600);
  }
}
</style>
