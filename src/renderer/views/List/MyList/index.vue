<template>
  <div ref="dom_lists" :class="$style.lists">
    <div :class="$style.listHeader">
      <h2 :class="$style.listsTitle">{{ $t('my_list') }}</h2>
      <div :class="$style.headerBtns">
        <button :class="$style.listsAdd" :aria-label="$t('lists__new_list_btn')" @click="handleShowNewList">
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
    <button
      type="button" :class="[$style.listsItem, $style.favorites, { [$style.active]: listId == loveList.id, [$style.clicked]: rightClickItemId == loveList.id }]"
      :data-list-id="loveList.id" :aria-label="$t('sidebar_favorites')" :aria-current="listId == loveList.id ? 'page' : undefined"
      @click="handleListToggle(loveList.id)" @contextmenu="handleFavoritesRightClick"
    >
      <span :class="$style.listsLabel">
        <span :class="$style.coverBox">
          <img v-if="getListCover(loveList)" :class="$style.coverImg" :src="getListCover(loveList)" alt="" loading="lazy">
          <svg v-else xmlns="http://www.w3.org/2000/svg" viewBox="0 0 247.498 247.498" aria-hidden="true"><use xlink:href="#icon-musicFolder" /></svg>
        </span>
        <span :class="$style.listName">{{ $t('sidebar_favorites') }}</span>
      </span>
    </button>
    <div ref="dom_lists_list" class="scroll" :class="[$style.listsContent, { [$style.sortable]: isModDown, [$style.scrollbarHidden]: !appSetting['common.isShowSidebarScrollbar'] }]">
      <ul ref="dom_mine_list" class="my-list-group" :class="$style.groupRoot" data-group="mine">
        <li class="my-list-group-heading">
          <button type="button" :class="$style.groupHeading" :aria-expanded="String(!collapsed.mine)" @click="toggle('mine')">
            <span :class="[$style.groupDisclosure, { [$style.groupCollapsed]: collapsed.mine }]">&#9662;</span>
            <span :class="$style.groupName">{{ $t('lists__group_mine') }}</span>
            <span :class="$style.groupCount">{{ groups.mine.count }}</span>
          </button>
        </li>
        <template v-if="!collapsed.mine">
          <li v-for="item in groups.mine.lists" :key="item.id" class="user-list" :class="[$style.listsItem, {[$style.active]: item.id == listId}, {[$style.clicked]: rightClickItemId == item.id}, {[$style.fetching]: fetchingListStatus[item.id]}]" :data-list-id="item.id" :aria-label="item.name" :aria-selected="item.id == listId" @contextmenu="handleListsItemRigthClick($event, item)">
            <span :class="$style.listsLabel" @click="handleListToggle(item.id)"><span :class="$style.coverBox"><img v-if="getListCover(item)" :class="$style.coverImg" :src="getListCover(item)" loading="lazy"><svg v-else version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 247.498 247.498" space="preserve"><use xlink:href="#icon-musicFolder" /></svg></span><span :class="$style.listName">{{ item.name }}</span></span>
            <base-input :class="$style.listsInput" type="text" :value="item.name" :placeholder="item.name" @keyup.enter="handleSaveListName" @blur="handleSaveListName" />
          </li>
          <transition enter-active-class="animated-fast slideInLeft" leave-active-class="animated-fast fadeOut" @after-leave="isNewListLeave = false" @after-enter="$refs.dom_listsNewInput.focus()">
            <li v-if="isShowNewList" class="new-list-input" :class="[$style.listsItem, $style.listsNew, {[$style.newLeave]: isNewListLeave}]"><base-input ref="dom_listsNewInput" :class="$style.listsInput" type="text" :placeholder="$t('lists__new_list_input')" @keyup.enter="handleCreateList" @blur="handleCreateList" /></li>
          </transition>
        </template>
      </ul>
      <ul ref="dom_external_list" class="my-list-group" :class="$style.groupRoot" data-group="external">
        <li class="my-list-group-heading">
          <button type="button" :class="$style.groupHeading" :aria-expanded="String(!collapsed.external)" @click="toggle('external')">
            <span :class="[$style.groupDisclosure, { [$style.groupCollapsed]: collapsed.external }]">&#9662;</span>
            <span :class="$style.groupName">{{ $t('lists__group_external') }}</span>
            <span :class="$style.groupCount">{{ groups.external.count }}</span>
          </button>
        </li>
        <template v-if="!collapsed.external">
          <li v-for="item in groups.external.lists" :key="item.id" class="user-list" :class="[$style.listsItem, {[$style.active]: item.id == listId}, {[$style.clicked]: rightClickItemId == item.id}, {[$style.fetching]: fetchingListStatus[item.id]}]" :data-list-id="item.id" :aria-label="item.name" :aria-selected="item.id == listId" @contextmenu="handleListsItemRigthClick($event, item)">
            <span :class="$style.listsLabel" @click="handleListToggle(item.id)"><span :class="$style.coverBox"><img v-if="getListCover(item)" :class="$style.coverImg" :src="getListCover(item)" loading="lazy"><svg v-else version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 247.498 247.498" space="preserve"><use xlink:href="#icon-musicFolder" /></svg></span><span :class="$style.listName">{{ item.name }}</span></span>
            <base-input :class="$style.listsInput" type="text" :value="item.name" :placeholder="item.name" @keyup.enter="handleSaveListName" @blur="handleSaveListName" />
          </li>
        </template>
      </ul>
      <template v-for="provider in platformProviders" :key="provider">
      <ul v-if="platformProviderVisible(provider)" class="my-list-group" :class="$style.groupRoot" :data-group="`platform-${provider}`">
        <li class="my-list-group-heading">
          <button type="button" :class="$style.groupHeading" :aria-expanded="String(!platformCollapsed[provider])" @click="togglePlatform(provider)">
            <span :class="[$style.groupDisclosure, { [$style.groupCollapsed]: platformCollapsed[provider] }]">&#9662;</span>
            <span :class="$style.groupName" :title="$t(`platform_playlist__import_${provider}`)">{{ $t(`platform_playlist__import_${provider}`) }}</span>
            <span :class="$style.groupCount">{{ platformProviderCount(provider) }}</span>
          </button>
        </li>
        <template v-if="!platformCollapsed[provider]">
          <template v-for="kind in platformKinds" :key="`${provider}-${kind}`">
            <li v-if="platformGroup(provider, kind)?.accountKey" :class="$style.platformSection">
              <button type="button" :class="[$style.groupHeading, $style.platformKindHeading]" :data-platform-kind="`${provider}:${kind}`" :aria-expanded="String(!platformKindCollapsed[`${provider}:${kind}`])" @click="togglePlatformKind(provider, kind)">
                <span :class="[$style.groupDisclosure, { [$style.groupCollapsed]: platformKindCollapsed[`${provider}:${kind}`] }]" aria-hidden="true">&#9662;</span>
                <span :class="$style.groupName" :title="$t(`platform_playlist__kind_${kind}`)">{{ $t(`platform_playlist__kind_${kind}`) }}</span>
                <span :class="$style.groupCount" aria-hidden="true">{{ platformGroup(provider, kind)?.lists.length || 0 }}</span>
              </button>
              <div v-if="!platformKindCollapsed[`${provider}:${kind}`] && (platformGroup(provider, kind)?.status != 'ready' || !platformGroup(provider, kind)?.lists.length)" :class="$style.platformStatusRow" role="status">
                <span v-if="platformGroup(provider, kind)?.status == 'loading'" :class="$style.platformStatus" :title="$t('platform_playlist__loading')">{{ $t('platform_playlist__loading') }}</span>
                <span v-else-if="platformGroup(provider, kind)?.status == 'syncing'" :class="$style.platformStatus">{{ $t('platform_playlist__syncing') }}</span>
                <span v-else-if="platformGroup(provider, kind)?.status == 'partial'" :class="$style.platformStatus" :title="platformGroup(provider, kind)?.errorMessage">{{ $t('platform_playlist__partial', { count: platformGroup(provider, kind)?.failures?.length || 0 }) }}</span>
                <span v-else-if="platformGroup(provider, kind)?.status == 'unsupported'" :class="$style.platformStatus" :title="platformGroup(provider, kind)?.errorMessage || $t('platform_playlist__unsupported')">{{ $t('platform_playlist__unsupported_short') }}</span>
                <span v-else-if="platformGroup(provider, kind)?.status == 'error'" :class="$style.platformStatus" :title="platformGroup(provider, kind)?.errorMessage || $t('platform_playlist__error')">{{ $t(platformGroup(provider, kind)?.errorStage == 'songs' ? 'platform_playlist__sync_error' : 'platform_playlist__directory_error') }}</span>
                <span v-else-if="platformGroup(provider, kind)?.status == 'ready'" :class="$style.platformStatus" :title="$t('platform_playlist__empty')">{{ $t('platform_playlist__empty') }}</span>
                <button v-if="['partial', 'error', 'unsupported'].includes(platformGroup(provider, kind)?.status)" type="button" :class="$style.platformRetry" :aria-label="$t(platformGroup(provider, kind)?.status == 'partial' ? 'platform_playlist__retry_failed' : 'platform_playlist__retry')" :title="$t(platformGroup(provider, kind)?.status == 'partial' ? 'platform_playlist__retry_failed' : 'platform_playlist__retry')" @click="retryPlatformGroup(provider, kind)">
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><use xlink:href="#icon-refresh" /></svg>
                </button>
              </div>
            </li>
            <li v-for="item in platformKindCollapsed[`${provider}:${kind}`] ? [] : platformGroup(provider, kind)?.lists || []" :key="item.id" class="user-list" :class="[$style.listsItem, $style.platformPlaylistItem, {[$style.active]: item.id == listId}, {[$style.clicked]: rightClickItemId == item.id}, {[$style.fetching]: fetchingListStatus[item.id]}]" :data-list-id="item.id" :aria-label="item.name" :aria-selected="item.id == listId" @contextmenu="handleListsItemRigthClick($event, item)">
              <span :class="$style.listsLabel" @click="handleListToggle(item.id)">
                <span :class="$style.coverBox"><img v-if="getListCover(item)" :class="$style.coverImg" :src="getListCover(item)" loading="lazy"><svg v-else version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 247.498 247.498"><use xlink:href="#icon-musicFolder" /></svg></span>
                <span :class="$style.platformListText">
                  <span :class="$style.listName">{{ item.name }}</span>
                  <span v-if="getPlatformPlaylistFailure(item.id) && !getPlatformPlaylistFailure(item.id).hasCache" :class="$style.platformUnavailable">{{ $t('platform_playlist__songs_unavailable') }}</span>
                </span>
                <span
                  v-if="getPlatformPlaylistFailure(item.id)" :class="$style.platformWarning" :data-playlist-sync-error="item.id" role="img" tabindex="0"
                  :title="$t('platform_playlist__failure_detail', { name: item.name, message: getPlatformPlaylistFailure(item.id).message, id: item.sourceListId })"
                  :aria-label="$t('platform_playlist__failure_detail', { name: item.name, message: getPlatformPlaylistFailure(item.id).message, id: item.sourceListId })"
                ><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><use xlink:href="#icon-information-slab-circle-outline" /></svg></span>
              </span>
            </li>
          </template>
        </template>
      </ul>
      </template>
    </div>
    <base-menu v-model="isShowMenu" :menus="menus" :xy="menuLocation" item-name="name" @menu-click="handleMenuClick" />
    <template v-if="isMounted">
      <DuplicateMusicModal v-model:visible="isShowDuplicateMusicModal" :list-info="duplicateListInfo" />
      <ListSortModal v-model:visible="isShowListSortModal" :list-info="sortListInfo" />
      <ListUpdateModal v-model:visible="isShowListUpdateModal" />
    </template>
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

import { onBeforeUnmount, onMounted, ref, watch } from '@common/utils/vueTools'
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
import useGroups from './useGroups'
import { loadPlatformGroupCollapsed, savePlatformGroupCollapsed } from './groupState'
import { getPlatformPlaylistGroups, getPlatformPlaylistFailure, retryPlatformUserPlaylistGroup } from '@renderer/store/platformPlaylists/action'

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
    const dom_mine_list = ref(null)
    const dom_external_list = ref(null)
    const rightClickItemId = ref(null)
    const coverVersion = ref(0)
    const userListProfiles = ref({})
    const platformGroups = getPlatformPlaylistGroups()
    const platformProviders = ['netease', 'qq_music', 'kugou']
    const platformKinds = ['created', 'collected']
    const savedPlatformCollapsed = loadPlatformGroupCollapsed()
    const platformCollapsed = ref(savedPlatformCollapsed.providers)
    const platformKindCollapsed = ref(savedPlatformCollapsed.kinds)
    const isMounted = ref(false)
    // Aside mounts before #view, the target of the playlist dialogs.
    onMounted(() => { isMounted.value = true })

    const { handleImportList, handleExportList } = useShare()
    const { isShowListUpdateModal, handleUpdateSourceList } = useListUpdate()
    const { isShowListSortModal, sortListInfo, handleSortList } = useSort()
    const { isShowDuplicateMusicModal, duplicateListInfo, handleDuplicateList } = useDuplicate()
    const { handleRename, handleSaveListName, isShowNewList, isNewListLeave, handleCreateList } = useEditList({ dom_lists_list })
    const { scrollToList } = useListScroll({ dom_lists_list })
    const { groups, collapsed, toggle, expand } = useGroups({
      userLists,
      activeListId: () => props.listId,
      scrollToList,
    })
    const handleShowNewList = () => {
      expand('mine')
      isShowNewList.value = true
    }

    const savePlatformCollapsed = () => {
      savePlatformGroupCollapsed(undefined, { providers: platformCollapsed.value, kinds: platformKindCollapsed.value })
    }
    const togglePlatform = provider => {
      platformCollapsed.value[provider] = !platformCollapsed.value[provider]
      savePlatformCollapsed()
    }
    const togglePlatformKind = (provider, kind) => {
      const key = `${provider}:${kind}`
      platformKindCollapsed.value[key] = !platformKindCollapsed.value[key]
      savePlatformCollapsed()
    }
    const platformGroup = (provider, kind) => platformGroups.value.find(group => group.provider == provider && group.kind == kind)
    const platformProviderCount = provider => platformGroups.value.filter(group => group.provider == provider).reduce((count, group) => count + group.lists.length, 0)
    const platformProviderVisible = provider => platformGroups.value.some(group => group.provider == provider && !!group.accountKey)
    const retryPlatformGroup = (provider, kind) => { void retryPlatformUserPlaylistGroup(provider, kind) }

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

    const handleListsItemRigthClick = (event, listInfo) => {
      rightClickItemId.value = listInfo.id
      showMenu(event, listInfo)
    }
    const handleFavoritesRightClick = event => {
      handleListsItemRigthClick(event, loveList)
    }

    const handleListToggle = (id) => {
      if (id == props.listId) return
      router.replace({
        path: '/list',
        query: { id },
      }).catch(_ => _)
    }

    const handleMenuClick = (action) => {
      isShowMenu.value = false
      if (!rightClickItemId.value) return
      const listInfo = rightClickItemId.value == loveList.id
        ? loveList
        : userLists.find(item => item.id == rightClickItemId.value)
      rightClickItemId.value = null
      if (!listInfo) return
      menuClick(action, listInfo)
    }

    const { isModDown } = useDarg({
      dom_mine_list,
      dom_external_list,
      handleMenuClick,
      handleSaveListName,
      expand,
      isGroupCollapsed: group => collapsed.value[group],
      getGroupListLength: group => groups.value[group].lists.length,
    })

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
      handleMenuClick()
      if (listId == LIST_IDS.LOVE || userLists.some(l => l.id == listId)) saveListPrevSelectId(listId)
    }, { immediate: true })

    watch(() => userLists.map(l => l.id).join(','), () => {
      if (!props.listId) return
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
      appSetting,
      isMounted,
      rightClickItemId,
      loveList,
      userLists,
      fetchingListStatus,
      getListCover,
      dom_lists_list,
      dom_mine_list,
      dom_external_list,
      isShowListUpdateModal,
      isShowListSortModal,
      sortListInfo,
      isShowDuplicateMusicModal,
      duplicateListInfo,
      handleSaveListName,
      isShowNewList,
      isNewListLeave,
      handleCreateList,
      handleShowNewList,
      groups,
      collapsed,
      toggle,
      platformGroups,
      getPlatformPlaylistFailure,
      platformProviders,
      platformKinds,
      platformCollapsed,
      platformKindCollapsed,
      togglePlatform,
      togglePlatformKind,
      platformGroup,
      platformProviderCount,
      platformProviderVisible,
      retryPlatformGroup,
      handleListsItemRigthClick,
      handleFavoritesRightClick,
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

@lists-item-height: calc(46px * var(--sidebar-scale));
.lists {
  flex: 1 0 calc(140px * var(--sidebar-scale));
  width: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-flow: column nowrap;
}
.listHeader {
  flex: none;
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
  min-width: 0;
  font-size: var(--sidebar-title-font-size);
  line-height: max(calc(36px * var(--sidebar-scale)), calc(1.4 * var(--sidebar-title-font-size)));
  padding: 0 var(--sidebar-gap);
  .mixin-ellipsis-1();
}
.headerBtns {
  flex: none;
  display: flex;
  align-items: center;
}
.favorites {
  flex: none;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 0;
  border: 0;
  color: var(--color-font);
  text-align: left;
  cursor: pointer;
  &:focus-visible { outline: 1px solid var(--color-primary); outline-offset: -1px; }
}
.listsAdd {
  // position: absolute;
  // right: 0;
  margin: 0;
  padding: 0;
  background: none;
  width: var(--sidebar-tool-size);
  height: var(--sidebar-tool-size);
  border: none;
  outline: none;
  border-radius: @radius-border;
  cursor: pointer;
  opacity: .65;
  transition: opacity @transition-normal;
  color: var(--color-button-font);
  svg {
    width: 70%;
    vertical-align: bottom;
  }
  &:active {
    opacity: .7 !important;
  }
  &:hover {
    opacity: .6 !important;
  }
}
.platformRetry {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--color-primary);
  background: transparent;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  &:hover { background-color: var(--color-primary-background-hover); }
  &:focus-visible { outline: 1px solid var(--color-primary); outline-offset: -1px; }
}
.platformSection {
  min-width: 0;
  margin-left: calc(12px * var(--sidebar-scale));
  padding: 0 0 4px;
}
.platformStatusRow {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 24px;
  padding: 0 10px 0 28px;
}
.platformStatus {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: normal;
  overflow-wrap: anywhere;
  text-overflow: ellipsis;
  color: var(--color-font-label);
  font-size: var(--sidebar-playlist-font-size);
  line-height: 1.4;
}
.listsContent {
  position: relative;
  flex: auto;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(128, 128, 128, .22) transparent;
  &.scrollbarHidden {
    scrollbar-width: none;
    &::-webkit-scrollbar { width: 0; height: 0; }
  }
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
.groupRoot {
  margin: 0;
  padding: 0;
  list-style: none;
}
.groupHeading {
  width: 100%;
  min-height: calc(30px * var(--sidebar-scale));
  padding: calc(4px * var(--sidebar-scale)) var(--sidebar-gap);
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--color-font);
  cursor: pointer;
  text-align: left;
  font-size: var(--sidebar-playlist-font-size);
  line-height: 1.35;
  &:hover { background-color: var(--color-primary-background-hover); }
  &:focus-visible { outline: 1px solid var(--color-primary); outline-offset: -1px; }
}
.groupDisclosure {
  flex: none;
  width: 12px;
  font-size: 12px;
  text-align: center;
  transition: transform @transition-normal;
}
.groupCollapsed { transform: rotate(-90deg); }
.platformKindHeading {
  min-height: calc(28px * var(--sidebar-scale));
  color: var(--color-font-label);
}
.listsItem.platformPlaylistItem {
  margin-left: calc(24px * var(--sidebar-scale));
}
.platformListText {
  flex: 1;
  min-width: 0;
}
.platformUnavailable {
  display: block;
  margin-top: 3px;
  color: var(--color-font-label);
  font-size: var(--sidebar-playlist-font-size);
  overflow-wrap: anywhere;
}
.platformWarning {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--color-primary);
  &:focus-visible { outline: 1px solid currentColor; outline-offset: 2px; }
}
.groupName { flex: auto; min-width: 0; font-size: var(--sidebar-playlist-font-size); .mixin-ellipsis-1(); }
.groupCount { flex: none; min-width: 20px; text-align: right; opacity: .6; font-size: var(--sidebar-playlist-font-size); }
.listsItem {
  position: relative;
  transition: .3s ease;
  transition-property: color, background-color, opacity;
  background-color: transparent;
  border-radius: 8px;
  margin: calc(3px * var(--sidebar-scale)) 0;
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
  min-height: @lists-item-height;
  padding: calc(6px * var(--sidebar-scale)) var(--sidebar-gap);
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: var(--sidebar-gap);
  font-size: var(--sidebar-playlist-font-size);
  line-height: 1.25;
}
.coverBox {
  flex: none;
  width: calc(32px * var(--sidebar-scale));
  height: calc(32px * var(--sidebar-scale));
  border-radius: 6px;
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
  font-size: var(--sidebar-playlist-font-size);
  font-weight: 400;
  line-height: 1.25;
  .mixin-ellipsis-2();

  .active & {
    color: var(--color-primary);
  }
}
.listsInput {
  width: 100%;
  height: max(calc(36px * var(--sidebar-scale)), calc(1.5 * var(--sidebar-playlist-font-size)));
  // border: none;
  padding: 0 var(--sidebar-gap);
  // padding-bottom: 1px;
  line-height: max(calc(36px * var(--sidebar-scale)), calc(1.5 * var(--sidebar-playlist-font-size)));
  background: none !important;
  border-radius: 0;
  // outline: none;
  font-size: var(--sidebar-playlist-font-size);
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
  margin-top: calc(-46px * var(--sidebar-scale));
  z-index: -1;
}


</style>
