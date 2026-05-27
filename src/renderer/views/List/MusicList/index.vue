<template>
  <div :class="$style.list" :style="playlistProfileStyle">
    <section v-if="listInfo" :class="$style.profile">
      <div :class="$style.profileCover">
        <img v-if="listCover" :class="$style.profileCoverImg" :src="listCover" loading="lazy" decoding="async">
        <svg v-else version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 247.498 247.498" space="preserve">
          <use xlink:href="#icon-musicFolder" />
        </svg>
      </div>
      <div :class="$style.profileInfo">
        <div :class="$style.profileTitleRow">
          <h2 :class="$style.profileTitle">{{ listTitle }}</h2>
          <button
            v-if="canEditProfile"
            type="button"
            :class="$style.editBtn"
            :aria-label="$t('list_profile__edit_title')"
            @click="isShowProfileEditModal = true"
          >
            <svg-icon name="pencil-outline" />
          </button>
        </div>
        <p v-if="createdTime" :class="$style.profileMeta">{{ createdTime }}{{ $t('list_profile__created_at') }}</p>
        <p :class="$style.profileDesc">{{ listProfile.description || '' }}</p>
        <button type="button" :class="$style.playAllBtn" :disabled="!list.length" @click="handlePlayAll">
          <svg-icon name="play-outline" />
          <span>{{ $t('list_profile__play_all') }}</span>
        </button>
      </div>
    </section>
    <div class="thead">
      <table>
        <thead>
          <tr v-if="actionButtonsVisible">
            <th class="num" style="width: 5%;">#</th>
            <th class="nobreak">{{ $t('music_name') }}</th>
            <th class="nobreak" style="width: 22%;">{{ $t('music_singer') }}</th>
            <th class="nobreak" style="width: 22%;">{{ $t('music_album') }}</th>
            <th class="nobreak" style="width: 9%;">{{ $t('music_time') }}</th>
            <th class="nobreak" style="width: 16%;">{{ $t('action') }}</th>
          </tr>
          <tr v-else>
            <th class="num" style="width: 5%;">#</th>
            <th class="nobreak">{{ $t('music_name') }}</th>
            <th class="nobreak" style="width: 25%;">{{ $t('music_singer') }}</th>
            <th class="nobreak" style="width: 28%;">{{ $t('music_album') }}</th>
            <th class="nobreak" style="width: 10%;">{{ $t('music_time') }}</th>
          </tr>
        </thead>
      </table>
    </div>
    <div v-show="list.length" ref="dom_listContent" :class="$style.content">
      <base-virtualized-list
        v-if="actionButtonsVisible" ref="listRef" v-slot="{ item, index }" :list="list" key-name="id"
        :item-height="listItemHeight" container-class="scroll" content-class="list"
        @scroll="handleListScroll" @contextmenu.capture="handleListRightClick"
      >
        <div
          class="list-item" :class="[{ [$style.active]: playerInfo.isPlayList && playerInfo.playIndex === index }, { [$style.locatingCurrent]: locatingCurrentIndex === index }, { selected: selectedIndex == index || rightClickSelectedIndex == index }, { active: selectedList.includes(item) }, { disabled: !assertApiSupport(item.source) }]"
          @click="handleListItemClick($event, index)" @contextmenu="handleListItemRightClick($event, index)"
        >
          <div class="list-item-cell no-select" :class="$style.num" style="flex: 0 0 5%;">
            <transition name="play-active">
              <div v-if="playerInfo.isPlayList && playerInfo.playIndex === index" :class="$style.playIcon">
                <svg-icon name="headphones" :class="$style.headphoneIcon" />
              </div>
              <div v-else class="num">{{ index + 1 }}</div>
            </transition>
          </div>
          <div class="list-item-cell auto name" :aria-label="item.name">
            <span class="select name">{{ item.name }}</span>
            <span v-if="isShowSource" class="no-select label-source">{{ item.source }}</span>
          </div>
          <div class="list-item-cell" style="flex: 0 0 22%;"><span class="select" :aria-label="item.singer">{{ item.singer }}</span></div>
          <div class="list-item-cell" style="flex: 0 0 22%;"><span class="select" :aria-label="item.meta.albumName">{{ item.meta.albumName }}</span></div>
          <div class="list-item-cell" style="flex: 0 0 9%;"><span class="no-select">{{ item.interval || '--/--' }}</span></div>
          <div class="list-item-cell" style="flex: 0 0 16%; padding-left: 0; padding-right: 0;">
            <material-list-buttons :index="index" :download-btn="assertApiSupport(item.source) && item.source != 'local'" @btn-click="handleListBtnClick" />
          </div>
        </div>
      </base-virtualized-list>
      <base-virtualized-list
        v-else ref="listRef" v-slot="{ item, index }" :list="list" key-name="id"
        :item-height="listItemHeight" container-class="scroll" content-class="list"
        @scroll="handleListScroll" @contextmenu.capture="handleListRightClick"
      >
        <div
          class="list-item"
          :class="[{ [$style.active]: playerInfo.isPlayList && playerInfo.playIndex === index }, { [$style.locatingCurrent]: locatingCurrentIndex === index }, { selected: selectedIndex == index || rightClickSelectedIndex == index }, { active: selectedList.includes(item) }, { disabled: !assertApiSupport(item.source) }]"
          @click="handleListItemClick($event, index)" @contextmenu="handleListItemRightClick($event, index)"
        >
          <div class="list-item-cell no-select" :class="$style.num" style="flex: 0 0 5%;">
            <transition name="play-active">
              <div v-if="playerInfo.isPlayList && playerInfo.playIndex === index" :class="$style.playIcon">
                <svg-icon name="headphones" :class="$style.headphoneIcon" />
              </div>
              <div v-else class="num">{{ index + 1 }}</div>
            </transition>
          </div>
          <div class="list-item-cell auto name">
            <span class="select name" :aria-label="item.name">{{ item.name }}</span>
            <span v-if="isShowSource" class="no-select label-source">{{ item.source }}</span>
          </div>
          <div class="list-item-cell" style="flex: 0 0 25%;"><span class="select" :aria-label="item.singer">{{ item.singer }}</span></div>
          <div class="list-item-cell" style="flex: 0 0 28%;"><span class="select" :aria-label="item.meta.albumName">{{ item.meta.albumName }}</span></div>
          <div class="list-item-cell" style="flex: 0 0 10%;"><span class="no-select">{{ item.interval || '--/--' }}</span></div>
        </div>
      </base-virtualized-list>
    </div>
    <div v-show="!list.length" :class="$style.noItem">
      <p v-text="$t('no_item')" />
    </div>
    <transition name="play-active">
      <button
        v-if="showLocateCurrentBtn"
        type="button"
        :class="$style.locateCurrentBtn"
        aria-label="Locate current music"
        @click="handleLocateCurrent"
      >
        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" space="preserve">
          <use xlink:href="#icon-fm-focus" />
        </svg>
      </button>
    </transition>
    <common-list-add-modal
      v-model:show="isShowListAdd" :is-move="isMove" :from-list-id="listId"
      :music-info="selectedAddMusicInfo" :exclude-list-id="excludeListIds" teleport="#view"
    />
    <common-list-add-multiple-modal
      v-model:show="isShowListAddMultiple" :from-list-id="listId"
      :is-move="isMoveMultiple" :music-list="selectedList" :exclude-list-id="excludeListIds" teleport="#view" @confirm="removeAllSelect"
    />
    <common-download-modal v-model:show="isShowDownload" :music-info="selectedDownloadMusicInfo" teleport="#view" :list-id="listId" />
    <common-download-multiple-modal v-model:show="isShowDownloadMultiple" :list="selectedList" teleport="#view" :list-id="listId" @confirm="removeAllSelect" />
    <search-list :list="list" :visible="isShowSearchBar" @action="handleMusicSearchAction" />
    <music-sort-modal v-model:show="isShowMusicSortModal" :music-info="selectedSortMusicInfo" :selected-num="selectedNum" @confirm="sortMusic" />
    <music-toggle-modal v-model:show="isShowMusicToggleModal" :music-info="selectedToggleMusicInfo" @toggle="toggleSource" />
    <list-profile-edit-modal
      v-model:visible="isShowProfileEditModal"
      :list-info="listInfo"
      :profile="listProfile"
      @submit="handleProfileSubmit"
    />
    <base-menu v-model="isShowItemMenu" :menus="menus" :xy="menuLocation" item-name="name" @menu-click="handleMenuClick" />
  </div>
</template>

<script>
import { clipboardWriteText } from '@common/utils/electron'
import { encodePath } from '@common/utils/common'
import { computed, onBeforeUnmount, ref, watch } from '@common/utils/vueTools'
import { assertApiSupport } from '@renderer/store/utils'
import SearchList from './components/SearchList.vue'
import MusicSortModal from './components/MusicSortModal.vue'
import MusicToggleModal from './components/MusicToggleModal.vue'
import ListProfileEditModal from './components/ListProfileEditModal.vue'
import useListInfo from './useListInfo'
import useList from './useList'
import useMenu from './useMenu'
import usePlay from './usePlay'
import useMusicDownload from './useMusicDownload'
import useMusicAdd from './useMusicAdd'
import useSort from './useSort'
import useMusicActions from './useMusicActions'
import useSearch from './useSearch'
import useListScroll from './useListScroll'
import useMusicToggle from './useMusicToggle'
import { appSetting } from '@renderer/store/setting'
import { userLists, loveList } from '@renderer/store/list/state'
import { updateUserList } from '@renderer/store/list/action'
import { getListUpdateInfo, setUserListProfile } from '@renderer/utils/data'
import { playList } from '@renderer/core/player'
import { LIST_IDS } from '@common/constants'

const buildCoverUrl = coverUrl => {
  if (!coverUrl) return ''
  if (/^(https?:|file:|data:)/.test(coverUrl)) return coverUrl
  return `file:///${encodePath(coverUrl)}`
}

export default {
  name: 'MusicList',
  components: {
    SearchList,
    MusicSortModal,
    MusicToggleModal,
    ListProfileEditModal,
  },
  props: {
    listId: {
      type: String,
      required: true,
    },
  },
  emits: ['show-menu'],
  setup(props, { emit }) {
    const actionButtonsVisible = appSetting['list.actionButtonsVisible']
    const isShowProfileEditModal = ref(false)
    const userListProfiles = ref({})
    const showLocateCurrentBtn = ref(false)
    const locatingCurrentIndex = ref(-1)
    let isLocatingCurrent = false
    let locateCurrentTimer = null
    let hideLocateCurrentTimer = null
    const playlistProfileStyle = computed(() => {
      const scale = Math.min(140, Math.max(60, Number(appSetting['list.playlistProfileScale']) || 85)) / 100
      return {
        '--playlist-profile-cover-size': `${Math.round(178 * scale)}px`,
        '--playlist-profile-gap': `${Math.round(38 * scale)}px`,
        '--playlist-profile-padding-y': `${Math.round(22 * scale)}px`,
        '--playlist-profile-padding-x': `${Math.round(28 * scale)}px`,
        '--playlist-profile-title-size': `${Number((24 * scale).toFixed(2))}px`,
        '--playlist-profile-meta-size': `${Number((13 * scale).toFixed(2))}px`,
        '--playlist-profile-desc-size': `${Number((14 * scale).toFixed(2))}px`,
        '--playlist-profile-edit-size': `${Math.round(34 * scale)}px`,
        '--playlist-profile-edit-icon-size': `${Math.round(21 * scale)}px`,
        '--playlist-profile-title-gap': `${Math.round(12 * scale)}px`,
        '--playlist-profile-meta-margin': `${Math.round(18 * scale)}px`,
        '--playlist-profile-desc-margin': `${Math.round(12 * scale)}px`,
        '--playlist-profile-button-gap': `${Math.round(7 * scale)}px`,
        '--playlist-profile-button-padding-y': `${Math.round(9 * scale)}px`,
        '--playlist-profile-button-padding-x': `${Math.round(16 * scale)}px`,
      }
    })

    let scrollIndex = null
    let isAnimation = false
    const handleRestoreScroll = (_scrollIndex, _isAnimation) => {
      scrollIndex = _scrollIndex
      isAnimation = _isAnimation
      if (isAnimation) void restoreScroll(scrollIndex, isAnimation)
      // console.log('handleRestoreScroll', scrollIndex, isAnimation)
    }
    const onLoadedList = () => {
      // console.log('restoreScroll', scrollIndex, isAnimation)
      void restoreScroll(scrollIndex, isAnimation)
    }

    const {
      rightClickSelectedIndex,
      selectedIndex,
      dom_listContent,
      listRef,
      list,
      playerInfo,
      setSelectedIndex,
      isShowSource,
      excludeListIds,
    } = useListInfo({ props, onLoadedList })

    const refreshUserListProfiles = () => {
      void getListUpdateInfo().then(info => {
        userListProfiles.value = Object.fromEntries(Object.entries(info).map(([id, item]) => [id, item.profile ?? {}]))
      })
    }
    refreshUserListProfiles()

    const {
      selectedList,
      listItemHeight,
      handleSelectData,
      removeAllSelect,
    } = useList({ listRef, list })

    const {
      handlePlayMusic,
      handlePlayMusicLater,
      doubleClickPlay,
    } = usePlay({ props, selectedList, list, removeAllSelect })

    const {
      isShowListAdd,
      isMove,
      isShowListAddMultiple,
      isMoveMultiple,
      selectedAddMusicInfo,
      handleShowMusicAddModal,
      handleShowMusicMoveModal,
    } = useMusicAdd({ selectedList, list })

    const {
      isShowDownload,
      isShowDownloadMultiple,
      selectedDownloadMusicInfo,
      handleShowDownloadModal,
    } = useMusicDownload({ selectedList, list })

    const {
      isShowMusicSortModal,
      selectedNum,
      selectedSortMusicInfo,
      handleShowSortModal,
      sortMusic,
    } = useSort({ props, list, selectedList, removeAllSelect })

    const {
      handleShowMusicToggleModal,
      isShowMusicToggleModal,
      selectedToggleMusicInfo,
      toggleSource,
    } = useMusicToggle(props, list)

    const {
      handleSearch,
      handleOpenMusicDetail,
      handleCopyName,
      handleDislikeMusic,
      handleRemoveMusic,
    } = useMusicActions({ props, list, removeAllSelect, selectedList })

    const {
      menus,
      menuLocation,
      isShowItemMenu,
      showMenu,
      menuClick,
    } = useMenu({
      props,
      assertApiSupport,
      emit,

      handleShowDownloadModal,
      handlePlayMusic,
      handlePlayMusicLater,
      handleShowMusicToggleModal,
      handleSearch,
      handleShowMusicAddModal,
      handleShowMusicMoveModal,
      handleShowSortModal,
      handleOpenMusicDetail,
      handleCopyName,
      handleDislikeMusic,
      handleRemoveMusic,
    })

    const {
      isShowSearchBar,
      searchList,
      handleMusicSearchAction,
    } = useSearch({
      setSelectedIndex,
      handlePlayMusic,
      listRef,
    })

    const { saveListPosition, restoreScroll, scrollToListIndex } = useListScroll({ props, listRef, list, handleRestoreScroll })

    const listInfo = computed(() => {
      if (props.listId == LIST_IDS.LOVE) return loveList
      return userLists.find(l => l.id == props.listId) ?? null
    })
    const canEditProfile = computed(() => !!listInfo.value && props.listId != LIST_IDS.LOVE)
    const listProfile = computed(() => userListProfiles.value[props.listId] ?? {})
    const listTitle = computed(() => {
      if (!listInfo.value) return ''
      return listInfo.value.id == LIST_IDS.LOVE ? window.i18n.t(listInfo.value.name) : listInfo.value.name
    })
    const listCover = computed(() => {
      const customCover = listProfile.value.coverUrl
      if (customCover) return buildCoverUrl(customCover)
      const firstMusic = list.value[0]
      return firstMusic?.meta?.picUrl ?? ''
    })
    const createdTime = computed(() => {
      const time = listProfile.value.createdAt ?? Number(String(props.listId).replace(/^userlist_/, ''))
      if (!Number.isFinite(time) || time <= 0) return ''
      return new Date(time).toLocaleDateString()
    })

    const clearLocateCurrentTimer = () => {
      if (!locateCurrentTimer) return
      clearTimeout(locateCurrentTimer)
      locateCurrentTimer = null
    }
    const clearHideLocateCurrentTimer = () => {
      if (!hideLocateCurrentTimer) return
      clearTimeout(hideLocateCurrentTimer)
      hideLocateCurrentTimer = null
    }
    const restartHideLocateCurrentTimer = () => {
      clearHideLocateCurrentTimer()
      hideLocateCurrentTimer = setTimeout(() => {
        showLocateCurrentBtn.value = false
        hideLocateCurrentTimer = null
      }, 5000)
    }
    const markCurrentMusicLocated = (index = playerInfo.value.playIndex) => {
      locatingCurrentIndex.value = index
      clearLocateCurrentTimer()
      locateCurrentTimer = setTimeout(() => {
        locatingCurrentIndex.value = -1
        locateCurrentTimer = null
      }, 1600)
    }
    const handleListScroll = () => {
      saveListPosition()
      if (isLocatingCurrent) return
      if (!playerInfo.value.isPlayList || playerInfo.value.playIndex < 0) return
      showLocateCurrentBtn.value = true
      restartHideLocateCurrentTimer()
    }
    const handleLocateCurrent = () => {
      if (!playerInfo.value.isPlayList || playerInfo.value.playIndex < 0) return
      const playIndex = playerInfo.value.playIndex
      isLocatingCurrent = true
      clearHideLocateCurrentTimer()
      showLocateCurrentBtn.value = false
      scrollToListIndex(playIndex, true, () => {
        markCurrentMusicLocated(playIndex)
      }).finally(() => {
        isLocatingCurrent = false
        showLocateCurrentBtn.value = false
      })
    }
    watch(playerInfo, info => {
      if (info.isPlayList && info.playIndex > -1) return
      showLocateCurrentBtn.value = false
      locatingCurrentIndex.value = -1
      clearLocateCurrentTimer()
      clearHideLocateCurrentTimer()
    })
    onBeforeUnmount(() => {
      clearLocateCurrentTimer()
      clearHideLocateCurrentTimer()
    })


    const handleListItemClick = (event, index) => {
      if (rightClickSelectedIndex.value > -1) return
      handleSelectData(index)
      doubleClickPlay(index)
    }
    const handleListItemRightClick = (event, index) => {
      rightClickSelectedIndex.value = index
      showMenu(event, list.value[index], index)
    }
    const handleMenuClick = (action) => {
      let index = rightClickSelectedIndex.value
      rightClickSelectedIndex.value = -1
      menuClick(action, index)
    }
    const handleListRightClick = (event) => {
      if (!event.target.classList.contains('select')) return
      event.stopImmediatePropagation()
      let classList = dom_listContent.value.classList
      classList.add('copying')
      window.requestAnimationFrame(() => {
        let str = window.getSelection().toString()
        classList.remove('copying')
        str = str.split(/\n\n/).map(s => s.replace(/\n/g, '  ')).join('\n').trim()
        if (!str.length) return
        clipboardWriteText(str)
      })
    }
    const handleListBtnClick = ({ action, index }) => {
      switch (action) {
        case 'download':
          handleShowDownloadModal(index, true)
          break
        case 'play':
          handlePlayMusic(index, true)
          break
        case 'search':
          handleSearch(index)
          break
        case 'listAdd':
          handleShowMusicAddModal(index, true)
          break
      }
    }
    const scrollToTop = () => {
      listRef.value.scrollTo(0, true)
    }
    const handlePlayAll = () => {
      if (!list.value.length) return
      playList(props.listId, 0)
    }
    const handleProfileSubmit = async({ name, profile, resolve, reject }) => {
      try {
        if (!listInfo.value || !canEditProfile.value) {
          resolve?.()
          return
        }
        await updateUserList([{ ...listInfo.value, name }])
        await setUserListProfile(props.listId, {
          ...profile,
          createdAt: (listProfile.value.createdAt ?? Number(String(props.listId).replace(/^userlist_/, ''))) || Date.now(),
        })
        refreshUserListProfiles()
        window.app_event.myListUpdate([props.listId])
        resolve?.()
      } catch (err) {
        reject?.(err)
        throw err
      }
    }

    return {
      listItemHeight,
      handleListItemClick,
      selectedList,
      handleListItemRightClick,
      removeAllSelect,
      handleListBtnClick,
      rightClickSelectedIndex,
      selectedIndex,
      dom_listContent,
      listRef,
      excludeListIds,

      menus,
      isShowItemMenu,
      menuLocation,
      handleMenuClick,

      handleListRightClick,
      assertApiSupport,

      isShowListAdd,
      isMove,
      isShowListAddMultiple,
      isMoveMultiple,
      selectedAddMusicInfo,

      isShowMusicSortModal,
      selectedNum,
      selectedSortMusicInfo,
      sortMusic,

      isShowDownload,
      isShowDownloadMultiple,
      selectedDownloadMusicInfo,

      scrollToTop,

      isShowSearchBar,
      searchList,
      handleMusicSearchAction,

      list,
      playerInfo,

      saveListPosition,
      handleListScroll,
      showLocateCurrentBtn,
      locatingCurrentIndex,
      handleLocateCurrent,
      isShowSource,
      handleRestoreScroll,

      actionButtonsVisible,
      playlistProfileStyle,

      isShowMusicToggleModal,
      selectedToggleMusicInfo,
      toggleSource,

      listInfo,
      listTitle,
      listProfile,
      listCover,
      createdTime,
      canEditProfile,
      isShowProfileEditModal,
      handlePlayAll,
      handleProfileSubmit,
    }
  },
}
</script>


<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.list {
  overflow: hidden;
  height: 100%;
  flex: auto;
  display: flex;
  flex-flow: column nowrap;

  :global(.list-item) {
    &.active {
      color: var(--color-button-font);
    }
  }
  :global {
    .label-source {
      color: var(--color-primary);
      padding: 5px;
      font-size: .8em;
      line-height: 1.2;
      opacity: .75;
      display: inline-block;
    }
  }
}
.profile {
  flex: none;
  display: grid;
  grid-template-columns: var(--playlist-profile-cover-size, 151px) minmax(0, 1fr);
  gap: var(--playlist-profile-gap, 32px);
  padding: var(--playlist-profile-padding-y, 19px) var(--playlist-profile-padding-x, 24px) calc(var(--playlist-profile-padding-y, 19px) - 2px);
  border-bottom: var(--color-list-header-border-bottom);
  background: transparent;
}
.profileCover {
  width: var(--playlist-profile-cover-size, 151px);
  aspect-ratio: 1 / 1;
  border-radius: 16px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-primary);
  background-color: var(--color-primary-background-hover);
  box-shadow: inset 0 0 0 1px rgba(128, 128, 128, .12), 0 10px 28px rgba(0, 0, 0, .1);

  svg {
    width: 44%;
    height: 44%;
    opacity: .72;
  }
}
.profileCoverImg {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.profileInfo {
  min-width: 0;
  display: flex;
  flex-flow: column nowrap;
  align-items: flex-start;
}
.profileTitleRow {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--playlist-profile-title-gap, 10px);
}
.profileTitle {
  min-width: 0;
  font-size: var(--playlist-profile-title-size, 20.4px);
  line-height: 1.2;
  font-weight: 700;
  color: var(--color-font);
  .mixin-ellipsis-2();
}
.editBtn {
  flex: none;
  width: var(--playlist-profile-edit-size, 29px);
  height: var(--playlist-profile-edit-size, 29px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-button-font);
  cursor: pointer;
  padding: 0;
  border-radius: @form-radius;
  line-height: 0;
  transition: background-color .2s ease, color .2s ease;

  svg {
    width: var(--playlist-profile-edit-icon-size, 18px);
    height: var(--playlist-profile-edit-icon-size, 18px);
  }

  &:hover {
    color: var(--color-primary);
    background-color: var(--color-primary-background-hover);
  }
}
.profileDesc {
  min-height: 1.4em;
  margin-top: var(--playlist-profile-desc-margin, 10px);
  max-width: 780px;
  color: var(--color-font);
  opacity: .82;
  font-size: var(--playlist-profile-desc-size, 11.9px);
  line-height: 1.45;
  white-space: pre-line;
  .mixin-ellipsis-2();
}
.profileMeta {
  margin-top: var(--playlist-profile-meta-margin, 15px);
  color: var(--color-font-label);
  font-size: var(--playlist-profile-meta-size, 11.05px);
}
.playAllBtn {
  display: inline-flex;
  align-items: center;
  gap: var(--playlist-profile-button-gap, 6px);
  margin-top: auto;
  border: none;
  border-radius: @form-radius;
  padding: var(--playlist-profile-button-padding-y, 8px) var(--playlist-profile-button-padding-x, 14px);
  color: var(--color-button-font);
  background-color: var(--color-button-background);
  cursor: pointer;
  outline: none;
  transition: background-color .2s ease, transform .2s ease, opacity .2s ease;

  &[disabled] {
    opacity: .45;
    cursor: default;
  }

  &:not([disabled]):hover {
    background-color: var(--color-button-background-hover);
  }

  &:not([disabled]):active {
    transform: translateY(1px);
    background-color: var(--color-button-background-active);
  }
}
.num {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}
.playIcon {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;

  color: var(--color-button-font);
  opacity: .7;
}
.headphoneIcon {
  width: 1.25em;
  height: 1.25em;
  vertical-align: 0;
}
.content {
  min-height: 0;
  font-size: 14px;
  display: flex;
  flex-flow: column nowrap;
  flex: auto;
}
.locatingCurrent {
  background-color: var(--color-secondary-bg-for-transparent, var(--color-primary-background-hover)) !important;
  animation: locate-current-pulse 1.6s ease both;
}
.locateCurrentBtn {
  position: absolute;
  right: 26px;
  bottom: 24px;
  z-index: 2;
  width: 42px;
  height: 42px;
  border: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-button-font);
  background-color: var(--color-button-background);
  box-shadow: 0 10px 26px rgba(0, 0, 0, .18), inset 0 0 0 1px rgba(255, 255, 255, .12);
  cursor: pointer;
  transition: transform .2s ease, background-color .2s ease, box-shadow .2s ease;

  svg {
    width: 22px;
    height: 22px;
    opacity: .9;
  }

  &:hover {
    transform: translateY(-1px);
    background-color: var(--color-button-background-hover);
    box-shadow: 0 12px 30px rgba(0, 0, 0, .22), inset 0 0 0 1px rgba(255, 255, 255, .16);
  }

  &:active {
    transform: translateY(0);
    background-color: var(--color-button-background-active);
  }
}

.noItem {
  position: relative;
  height: 100%;
  display: flex;
  flex-flow: column nowrap;
  justify-content: center;
  align-items: center;

  p {
    font-size: 24px;
    color: var(--color-font-label);
  }
}

@keyframes locate-current-pulse {
  0% {
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0), 0 0 0 rgba(0, 0, 0, 0);
  }
  28% {
    box-shadow: inset 0 0 0 1px var(--color-primary-light-100-alpha-700), 0 0 18px var(--color-primary-alpha-600);
  }
  100% {
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0), 0 0 0 rgba(0, 0, 0, 0);
  }
}

</style>
