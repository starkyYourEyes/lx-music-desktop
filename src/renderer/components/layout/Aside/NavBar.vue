<template>
  <div :class="$style.menu">
    <ul :class="$style.list" role="toolbar">
      <li v-for="item in menus" v-show="item.enable" :key="item.to" :class="$style.navItem" role="presentation">
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

const iconSize = '34px'
const menuList = [
  {
    to: '/search',
    tips: 'search',
    icon: '#icon-search-2',
    iconSize: '0 0 425.2 425.2',
    name: 'Search',
  },
  {
    to: '/recommend',
    tips: 'recommend',
    icon: '#icon-thumbs-up',
    iconSize: '0 0 512 512',
    name: 'Recommend',
  },
  {
    to: '/songList/list',
    tips: 'song_list',
    icon: '#icon-album',
    iconSize: '0 0 425.2 425.2',
    name: 'SongList',
  },
  {
    to: '/leaderboard',
    tips: 'leaderboard',
    icon: '#icon-leaderboard',
    iconSize: '0 0 425.22 425.2',
    name: 'Leaderboard',
  },
  {
    to: '/list',
    tips: 'my_list',
    icon: '#icon-love',
    iconSize: '0 0 444.87 391.18',
    name: 'List',
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

    return {
      appSetting,
      menus,
    }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.menu {
  flex: auto;
  display: flex;
  align-items: center;
  // &.controlBtnLeft {
  //   display: flex;
  //   flex-flow: column nowrap;
  //   justify-content: center;
  //   padding-bottom: @control-btn-height;
  // }
  // padding: 5px;
}
.list {
  -webkit-app-region: no-drag;
  width: 100%;
  // margin-bottom: 15px;
  &:last-child {
    margin-bottom: 0;
  }
  // background-color: pink;
  // dt {
  //   padding-left: 5px;
  //   font-size: 11px;
  //   transition: @transition-normal;
  //   transition-property: color;
  //   color: @color-theme-font-label;
  //   .mixin-ellipsis-1();
  // }
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
.link {
  position: absolute;
  left: 0%;
  top: 0%;
  width: 64px;
  height: 64px;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  // left: 15%;
  // top: 15%;
  // width: 70%;
  // height: 70%;
  // display: block;
  box-sizing: border-box;
  // text-decoration: none;
  // border-radius: 20%;

  // padding: 18px 3px;
  // margin: 5px 0;
  // border-left: 5px solid transparent;
  transition: @transition-fast;
  transition-property: background-color, box-shadow, color, opacity;
  color: var(--color-nav-font);
  cursor: pointer;
  // font-size: 11.5px;
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
    // border-left-color: @color-theme-active;
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

// .icon {
//   // margin-bottom: 5px;
//   &> svg {
//     width: 32%;
//   }
// }

</style>
