<template>
  <div ref="dom_lists" :class="$style.lists" :style="listSidebarStyle">
    <div :class="$style.listHeader">
      <h2 :class="$style.listsTitle">{{ $t('my_list') }}</h2>
      <div :class="$style.headerBtns">
        <button :class="$style.listsAdd" :aria-label="$t('lists__new_list_btn')" @click="isShowNewList = true">
          <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" height="70%" viewBox="0 0 24 24" space="preserve">
            <use xlink:href="#icon-list-add" />
          </svg>
        </button>
        <button :class="$style.listsAdd" :aria-label="$t('list_update_modal__title')" @click="isShowListUpdateModal = true">
          <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" style="transform: rotate(45deg);" height="70%" viewBox="0 0 24 24" space="preserve">
            <use xlink:href="#icon-refresh" />
          </svg>
        </button>
      </div>
    </div>
    <ul ref="dom_lists_list" class="scroll" :class="[$style.listsContent, { [$style.sortable]: isModDown }]">
      <li
        class="default-list" :class="[$style.listsItem, {[$style.active]: loveList.id == listId}, {[$style.clicked]: rightClickItemIndex == -1}, {[$style.fetching]: fetchingListStatus[loveList.id]}]"
        :aria-label="$t(loveList.name)" :aria-selected="loveList.id == listId"
        @contextmenu="handleListsItemRigthClick($event, -1)" @click="handleListToggle(loveList.id)"
      >
        <span :class="$style.listsLabel">
          <span :class="$style.coverBox">
            <img v-if="getListCover(loveList)" :class="$style.coverImg" :src="getListCover(loveList)" loading="lazy">
            <svg v-else version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 444.87 391.18" space="preserve">
              <use xlink:href="#icon-love" />
            </svg>
          </span>
          <span :class="$style.listName">{{ $t(loveList.name) }}</span>
        </span>
      </li>
      <li
        v-for="(item, index) in userLists"
        :key="item.id" class="user-list"
        :class="[$style.listsItem, {[$style.active]: item.id == listId}, {[$style.clicked]: rightClickItemIndex == index}, {[$style.fetching]: fetchingListStatus[item.id]}]"
        :data-index="index" :aria-label="item.name" :aria-selected="item.id == listId" @contextmenu="handleListsItemRigthClick($event, index)"
      >
        <span :class="$style.listsLabel" @click="handleListToggle(item.id)">
          <span :class="$style.coverBox">
            <img v-if="getListCover(item)" :class="$style.coverImg" :src="getListCover(item)" loading="lazy">
            <svg v-else version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 247.498 247.498" space="preserve">
              <use xlink:href="#icon-musicFolder" />
            </svg>
          </span>
          <span :class="$style.listName">{{ item.name }}</span>
        </span>
        <base-input
          :class="$style.listsInput" type="text" :value="item.name"
          :placeholder="item.name" @keyup.enter="handleSaveListName(index, $event)" @blur="handleSaveListName(index, $event)"
        />
      </li>
      <transition enter-active-class="animated-fast slideInLeft" leave-active-class="animated-fast fadeOut" @after-leave="isNewListLeave = false" @after-enter="$refs.dom_listsNewInput.focus()">
        <li v-if="isShowNewList" :class="[$style.listsItem, $style.listsNew, {[$style.newLeave]: isNewListLeave}]">
          <base-input
            ref="dom_listsNewInput" :class="$style.listsInput" type="text" :placeholder="$t('lists__new_list_input')"
            @keyup.enter="handleCreateList" @blur="handleCreateList"
          />
        </li>
      </transition>
    </ul>
    <base-menu v-model="isShowMenu" :menus="menus" :xy="menuLocation" item-name="name" @menu-click="handleMenuClick" />
    <DuplicateMusicModal v-model:visible="isShowDuplicateMusicModal" :list-info="duplicateListInfo" />
    <ListSortModal v-model:visible="isShowListSortModal" :list-info="sortListInfo" />
    <ListUpdateModal v-model:visible="isShowListUpdateModal" />
  </div>
</template>

<script>
import { openUrl } from '@common/utils/electron'
import { encodePath } from '@common/utils/common'

import musicSdk from '@renderer/utils/musicSdk'
import DuplicateMusicModal from './components/DuplicateMusicModal.vue'
import ListSortModal from './components/ListSortModal.vue'
import ListUpdateModal from './components/ListUpdateModal.vue'

import { allMusicList, loveList, userLists, fetchingListStatus } from '@renderer/store/list/state'
import { getListMusics, removeUserList } from '@renderer/store/list/action'
import { appSetting } from '@renderer/store/setting'

import { computed, onBeforeUnmount, ref, watch } from '@common/utils/vueTools'
import { useRouter } from '@common/utils/vueRouter'
import { LIST_IDS } from '@common/constants'

import { dialog } from '@renderer/plugins/Dialog'

import { getListUpdateInfo, saveListPrevSelectId } from '@renderer/utils/data'

import { useI18n } from '@renderer/plugins/i18n'


import useShare from './useShare'
import useMenu from './useMenu'
import useListUpdate from './useListUpdate'
import useSort from './useSort'
import useDarg from './useDarg'
import useEditList from './useEditList'
import useListScroll from './useListScroll'
import useDuplicate from './useDuplicate'

const clampSidebarScale = scale => Math.min(130, Math.max(70, Number(scale) || 90))
const toPx = value => `${Math.round(value)}px`
const toFixedPx = value => `${Number(value.toFixed(2))}px`
const buildCoverUrl = coverUrl => {
  if (!coverUrl) return ''
  if (/^(https?:|file:|data:)/.test(coverUrl)) return coverUrl
  return `file:///${encodePath(coverUrl)}`
}

export default {
  name: 'MyLists',
  components: {
    DuplicateMusicModal,
    ListSortModal,
    ListUpdateModal,
  },
  props: {
    listId: {
      type: String,
      required: true,
    },
  },
  emits: ['show-menu'],
  setup(props, { emit }) {
    const router = useRouter()
    const t = useI18n()

    const dom_lists_list = ref(null)
    const rightClickItemIndex = ref(-10)
    const coverVersion = ref(0)
    const userListProfiles = ref({})
    const listSidebarStyle = computed(() => {
      const scale = clampSidebarScale(appSetting['list.myListSidebarScale']) / 100
      return {
        '--my-list-sidebar-width': `${22 * scale}%`,
        '--my-list-sidebar-min-width': toPx(198 * scale),
        '--my-list-sidebar-max-width': toPx(260 * scale),
        '--my-list-item-min-height': toPx(58 * scale),
        '--my-list-item-margin-y': toPx(Math.max(2, 4 * scale)),
        '--my-list-item-margin-x': toPx(Math.max(5, 8 * scale)),
        '--my-list-item-padding-y': toPx(Math.max(6, 8 * scale)),
        '--my-list-item-padding-x': toPx(Math.max(7, 10 * scale)),
        '--my-list-item-gap': toPx(Math.max(7, 10 * scale)),
        '--my-list-cover-size': toPx(42 * scale),
        '--my-list-cover-radius': toPx(Math.max(6, 8 * scale)),
        '--my-list-name-font-size': toFixedPx(Math.max(11, 13 * scale)),
        '--my-list-input-height': toPx(42 * scale),
        '--my-list-input-padding-left': toPx(52 * scale),
      }
    })

    const { handleImportList, handleExportList } = useShare()
    const { isShowListUpdateModal, handleUpdateSourceList } = useListUpdate()
    const { isShowListSortModal, sortListInfo, handleSortList } = useSort()
    const { isShowDuplicateMusicModal, duplicateListInfo, handleDuplicateList } = useDuplicate()
    const { handleRename, handleSaveListName, isShowNewList, isNewListLeave, handleCreateList } = useEditList({ dom_lists_list })
    useListScroll({ dom_lists_list })

    const handleOpenSourceDetailPage = async(listInfo) => {
      const { source, sourceListId } = listInfo
      if (!sourceListId) return
      let url
      if (/board__/.test(sourceListId)) {
        const id = sourceListId.replace(/board__/, '')
        url = musicSdk[source].leaderboard.getDetailPageUrl(id)
      } else if (musicSdk[source]?.songList?.getDetailPageUrl) {
        url = await musicSdk[source].songList.getDetailPageUrl(sourceListId)
      }
      if (!url) return
      void openUrl(url)
    }

    const handleRemove = (listInfo) => {
      void dialog.confirm({
        message: t('lists__remove_tip', { name: listInfo.name }),
        confirmButtonText: t('lists__remove_tip_button'),
      }).then(isRemove => {
        if (!isRemove) return
        void removeUserList([listInfo.id])
        if (props.listId == listInfo.id) {
          handleListToggle(LIST_IDS.LOVE)
        }
      })
    }

    const {
      menus,
      menuLocation,
      isShowMenu,
      showMenu,
      menuClick,
    } = useMenu({
      emit,

      handleImportList,
      handleExportList,
      handleUpdateSourceList,
      handleOpenSourceDetailPage,
      handleSortList,
      handleDuplicateList,
      handleRename,
      handleRemove,
    })

    const handleListsItemRigthClick = (event, index) => {
      rightClickItemIndex.value = index
      showMenu(event, index)
    }

    const handleListToggle = (id) => {
      if (id == props.listId) return
      router.replace({
        path: '/list',
        query: { id },
      }).catch(_ => _)
    }

    const handleMenuClick = (action) => {
      if (rightClickItemIndex.value < -1) return
      let index = rightClickItemIndex.value
      rightClickItemIndex.value = -10
      menuClick(action, index)
    }

    const { isModDown } = useDarg({ dom_lists_list, handleMenuClick, handleSaveListName })

    const refreshUserListProfiles = () => {
      void getListUpdateInfo().then(info => {
        userListProfiles.value = Object.fromEntries(Object.entries(info).map(([id, item]) => [id, item.profile ?? {}]))
        coverVersion.value++
      })
    }

    const getCustomCover = (listInfo) => {
      return userListProfiles.value[listInfo.id]?.coverUrl ?? listInfo.coverUrl ?? listInfo.cover ?? listInfo.meta?.coverUrl ?? listInfo.meta?.cover ?? ''
    }

    const getListCover = (listInfo) => {
      // Keep coverVersion as a lightweight render trigger after async list preloading.
      const version = coverVersion.value
      void version
      const customCover = getCustomCover(listInfo)
      if (customCover) return buildCoverUrl(customCover)
      const firstMusic = allMusicList.get(listInfo.id)?.[0]
      return firstMusic?.meta?.picUrl ?? ''
    }

    const preloadListCovers = () => {
      const ids = [loveList.id, ...userLists.map(l => l.id)]
      void Promise.all(ids.map(async id => getListMusics(id).catch(() => []))).then(() => {
        coverVersion.value++
      })
    }

    const handleMyListUpdate = (ids) => {
      if (!ids.some(id => id == loveList.id || userLists.some(l => l.id == id))) return
      refreshUserListProfiles()
      coverVersion.value++
    }

    watch(() => props.listId, (listId) => {
      if (listId == LIST_IDS.LOVE || userLists.some(l => l.id == listId)) saveListPrevSelectId(listId)
    })

    watch(() => userLists.map(l => l.id).join(','), () => {
      if (props.listId == loveList.id || userLists.some(l => l.id == props.listId)) return
      void router.replace({
        path: '/list',
        query: {
          id: loveList.id,
        },
      })
    })

    watch(() => userLists.map(l => l.id).join(','), preloadListCovers, { immediate: true })
    refreshUserListProfiles()

    window.app_event.on('myListUpdate', handleMyListUpdate)
    onBeforeUnmount(() => {
      window.app_event.off('myListUpdate', handleMyListUpdate)
    })

    return {
      rightClickItemIndex,
      loveList,
      userLists,
      fetchingListStatus,
      listSidebarStyle,
      getListCover,
      dom_lists_list,
      isShowListUpdateModal,
      isShowListSortModal,
      sortListInfo,
      isShowDuplicateMusicModal,
      duplicateListInfo,
      handleSaveListName,
      isShowNewList,
      isNewListLeave,
      handleCreateList,
      handleListsItemRigthClick,
      isShowMenu,
      handleMenuClick,
      menus,
      menuLocation,
      handleListToggle,
      isModDown,
      hideMenu: handleMenuClick,
    }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

@lists-item-height: 58px;
.lists {
  flex: none;
  width: var(--my-list-sidebar-width, 19.8%);
  min-width: var(--my-list-sidebar-min-width, 178px);
  max-width: var(--my-list-sidebar-max-width, 234px);
  display: flex;
  flex-flow: column nowrap;
}
.listHeader {
  position: relative;
  display: flex;
  flex-flow: row nowrap;
  border-bottom: var(--color-list-header-border-bottom);
  &:hover {
    .listsAdd {
      opacity: 1;
    }
  }
}
.listsTitle {
  flex: auto;
  font-size: 12px;
  line-height: 38px;
  padding: 0 10px;
  .mixin-ellipsis-1();
}
.headerBtns {
  flex: none;
  display: flex;
}
.listsAdd {
  // position: absolute;
  // right: 0;
  margin-top: 6px;
  background: none;
  height: 30px;
  border: none;
  outline: none;
  border-radius: @radius-border;
  cursor: pointer;
  opacity: .1;
  transition: opacity @transition-normal;
  color: var(--color-button-font);
  svg {
    vertical-align: bottom;
  }
  &:active {
    opacity: .7 !important;
  }
  &:hover {
    opacity: .6 !important;
  }
}
.listsContent {
  flex: auto;
  min-width: 0;
  overflow-y: scroll !important;
  scrollbar-width: thin;
  scrollbar-color: rgba(128, 128, 128, .22) transparent;
  // border-right: 1px solid rgba(0, 0, 0, 0.12);

  &::-webkit-scrollbar {
    width: 4px;
    height: 4px;
    background-color: transparent;
  }

  &::-webkit-scrollbar-track {
    background-color: transparent;
  }

  &::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background-color: rgba(128, 128, 128, .2);
  }

  &::-webkit-scrollbar-thumb:hover {
    background-color: rgba(128, 128, 128, .34);
  }

  &.sortable {
    * {
      -webkit-user-drag: element;
    }

    .listsItem {
      &:hover, &.active, &.selected, &.clicked {
        background-color: transparent !important;
      }

      &.dragingItem {
        background-color: var(--color-primary-background-hover) !important;
      }
    }
  }
}
.listsItem {
  position: relative;
  transition: .3s ease;
  transition-property: color, background-color, opacity;
  background-color: transparent;
  border-radius: 8px;
  margin: var(--my-list-item-margin-y, 4px) var(--my-list-item-margin-x, 8px);
  &:not(.active) {
    &:hover {
      background-color: var(--color-primary-background-hover);
      cursor: pointer;
    }
  }
  &.active {
    // background-color:
    color: var(--color-primary);
    background-color: var(--color-primary-background-hover);
  }
  &.selected {
    background-color: var(--color-primary-font-active);
  }
  &.clicked {
    background-color: var(--color-primary-background-hover);
  }
  &.fetching {
    opacity: .5;
  }
  &.editing {
    padding: 8px 10px;
    background-color: var(--color-primary-background-hover);
    .listsLabel {
      display: none;
    }
    .listsInput {
      display: block;
    }
  }
}
.listsLabel {
  min-height: var(--my-list-item-min-height, @lists-item-height);
  padding: var(--my-list-item-padding-y, 8px) var(--my-list-item-padding-x, 10px);
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: var(--my-list-item-gap, 10px);
  font-size: var(--my-list-name-font-size, 13px);
  line-height: 1.25;
}
.coverBox {
  flex: none;
  width: var(--my-list-cover-size, 42px);
  height: var(--my-list-cover-size, 42px);
  border-radius: var(--my-list-cover-radius, 8px);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-primary);
  background-color: var(--color-primary-background-hover);
  box-shadow: inset 0 0 0 1px rgba(128, 128, 128, .12);

  svg {
    width: 58%;
    height: 58%;
    opacity: .72;
  }
}
.coverImg {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.listName {
  flex: auto;
  min-width: 0;
  color: var(--color-font);
  font-size: var(--my-list-name-font-size, 13px);
  font-weight: 600;
  line-height: 1.25;
  .mixin-ellipsis-2();

  .active & {
    color: var(--color-primary);
  }
}
.listsInput {
  width: 100%;
  height: var(--my-list-input-height, 42px);
  // border: none;
  padding: 0 0 0 var(--my-list-input-padding-left, 52px);
  // padding-bottom: 1px;
  line-height: var(--my-list-input-height, 42px);
  background: none !important;
  border-radius: 0;
  // outline: none;
  font-size: var(--my-list-name-font-size, 13px);
  display: none;
  // font-family: inherit;
}

.listsNew {
  padding: 0 10px;
  background-color: var(--color-primary-background-hover) !important;
  .listsInput {
    display: block;
  }
}
.newLeave {
  margin-top: -@lists-item-height;
  z-index: -1;
}


</style>
