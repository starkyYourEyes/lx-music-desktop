<template>
  <div :class="[$style.controlBtn, { [$style.compact]: compact }]">
    <!-- <common-volume-bar /> -->
    <button
      v-if="showFavorite"
      :class="[$style.titleBtn, $style.favoriteBtn, { [$style.active]: isCollected }]"
      :aria-label="$t('list__name_love')"
      :disabled="!playMusicInfo.musicInfo"
      @click="toggleCollect"
    >
      <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" width="90%" viewBox="0 0 830.33 740.22" space="preserve">
        <use :xlink:href="isCollected ? '#icon-love-fill' : '#icon-love'" />
      </svg>
    </button>
    <button v-if="showAddTo" :class="$style.titleBtn" :aria-label="$t('player__add_music_to')" @click="addMusicTo">
      <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" width="90%" viewBox="0 0 512 512" space="preserve">
        <use xlink:href="#icon-add-2" />
      </svg>
    </button>
    <button v-if="showLyric" :class="$style.titleBtn" :aria-label="toggleDesktopLyricBtnTitle" @click="toggleDesktopLyric" @contextmenu="toggleLockDesktopLyric">
      <svg v-show="appSetting['desktopLyric.enable']" version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" height="100%" viewBox="0 0 512 512" space="preserve">
        <use xlink:href="#icon-desktop-lyric-on" />
      </svg>
      <svg v-show="!appSetting['desktopLyric.enable']" version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" height="100%" viewBox="0 0 512 512" space="preserve">
        <use xlink:href="#icon-desktop-lyric-off" />
      </svg>
    </button>
    <common-volume-btn v-if="showVolume" compact-player />
    <common-private-fm-mode-btn v-if="showPlayMode && isPrivateFmMode" />
    <common-toggle-play-mode-btn v-else-if="showPlayMode" />
    <common-list-add-modal v-if="showAddTo" v-model:show="isShowAddMusicTo" :music-info="playMusicInfo.musicInfo" />
  </div>
</template>

<script>
import { onBeforeUnmount, onMounted, ref, watch } from '@common/utils/vueTools'
import useToggleDesktopLyric from '@renderer/utils/compositions/useToggleDesktopLyric'
import { musicInfo, playMusicInfo } from '@renderer/store/player/state'
import { appSetting } from '@renderer/store/setting'
import { loveList } from '@renderer/store/list/state'
import { addListMusics, checkListExistMusic, removeListMusics } from '@renderer/store/list/action'
import { LIST_IDS } from '@common/constants'
import { isPrivateFmMode } from '@renderer/store/privateFm/state'

export default {
  props: {
    showFavorite: {
      type: Boolean,
      default: false,
    },
    showAddTo: {
      type: Boolean,
      default: true,
    },
    showLyric: {
      type: Boolean,
      default: true,
    },
    showVolume: {
      type: Boolean,
      default: true,
    },
    showPlayMode: {
      type: Boolean,
      default: true,
    },
    compact: {
      type: Boolean,
      default: false,
    },
  },
  setup(props) {
    const isShowAddMusicTo = ref(false)
    const isCollected = ref(false)
    const {
      toggleDesktopLyricBtnTitle,
      toggleDesktopLyric,
      toggleLockDesktopLyric,
    } = useToggleDesktopLyric()

    const getCurrentMusicInfo = () => {
      const currentMusicInfo = playMusicInfo.musicInfo
      if (!currentMusicInfo) return null
      return 'progress' in currentMusicInfo ? currentMusicInfo.metadata.musicInfo : currentMusicInfo
    }

    let updateCollectToken = 0
    const updateCollectStatus = async() => {
      if (!props.showFavorite) return
      const currentMusicInfo = getCurrentMusicInfo()
      const token = ++updateCollectToken
      if (!currentMusicInfo) {
        isCollected.value = false
        return
      }
      const isExist = await checkListExistMusic(loveList.id, currentMusicInfo.id).catch(() => false)
      if (token != updateCollectToken || getCurrentMusicInfo()?.id != currentMusicInfo.id) return
      isCollected.value = isExist
    }

    const toggleCollect = async() => {
      if (!props.showFavorite) return
      const currentMusicInfo = getCurrentMusicInfo()
      if (!currentMusicInfo) return

      const previousStatus = isCollected.value
      isCollected.value = !previousStatus
      try {
        if (previousStatus) {
          if (playMusicInfo.listId == LIST_IDS.LOVE && playMusicInfo.musicInfo?.id == currentMusicInfo.id) {
            playMusicInfo.isTempPlay = true
          }
          await removeListMusics({ listId: loveList.id, ids: [currentMusicInfo.id] })
        } else {
          await addListMusics(loveList.id, [currentMusicInfo])
        }
      } catch (err) {
        isCollected.value = previousStatus
        console.warn('Toggle love music failed:', err)
      }
    }

    const addMusicTo = () => {
      if (!musicInfo.id) return
      isShowAddMusicTo.value = true
    }

    const handleListUpdate = (ids) => {
      if (!props.showFavorite) return
      if (!ids.includes(loveList.id)) return
      void updateCollectStatus()
    }

    watch(() => playMusicInfo.musicInfo, () => {
      void updateCollectStatus()
    })

    onMounted(() => {
      void updateCollectStatus()
      window.app_event.on('myListUpdate', handleListUpdate)
    })

    onBeforeUnmount(() => {
      window.app_event.off('myListUpdate', handleListUpdate)
    })

    return {
      appSetting,
      isShowAddMusicTo,
      isCollected,
      toggleDesktopLyricBtnTitle,
      toggleDesktopLyric,
      toggleLockDesktopLyric,
      addMusicTo,
      toggleCollect,
      playMusicInfo,
      isPrivateFmMode,
    }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.controlBtn {
  flex: none;
  height: 34px;
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  gap: 12px;

  button {
    color: var(--color-button-font);
  }
}

.compact {
  height: 32px;
  gap: 10px;
}

.titleBtn {
  flex: none;
  height: 32px;
  width: 30px;
  transition: @transition-fast;
  transition-property: color, opacity, background-color;
  // color: var(--color-button-font);
  display: flex;
  flex-flow: column nowrap;
  justify-content: center;
  align-items: center;
  background-color: transparent;
  border: none;
  padding: 0;

  opacity: .68;
  cursor: pointer;

  svg {
    filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.2));
  }
  &:hover {
    opacity: 1;
  }
  &:active {
    opacity: 1;
  }

  &:disabled {
    cursor: default;
    opacity: .28;
  }
}

.favoriteBtn {
  width: 30px;
  border-radius: 50%;
}

.active {
  color: var(--color-primary) !important;
  opacity: 1;
}


</style>
