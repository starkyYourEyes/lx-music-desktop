<template>
  <div :class="$style.localMusic">
    <div :class="$style.header">
      <div :class="$style.heading">
        <h2>{{ $t('local_music') }}</h2>
        <p>{{ $t('local_music__count', { count: localMusicList.length }) }}</p>
      </div>
      <div :class="$style.actions">
        <button
          type="button"
          :class="$style.iconBtn"
          :aria-label="$t('local_music__settings')"
          @click="handleOpenSetting"
        >
          <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 493.23 436.47" space="preserve">
            <use xlink:href="#icon-setting" />
          </svg>
        </button>
        <button
          type="button"
          :class="$style.iconBtn"
          :disabled="isScanningLocalMusic"
          :aria-label="$t('local_music__refresh')"
          @click="handleRefresh"
        >
          <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" space="preserve">
            <use xlink:href="#icon-refresh" />
          </svg>
        </button>
      </div>
    </div>
    <div :class="$style.list">
      <material-online-list
        :list="localMusicList"
        :page="1"
        :limit="listLimit"
        :total="localMusicList.length"
        :no-item="noItem"
        source-tag
        direct-list-play
        local-music-upload
        :list-context-id="LOCAL_MUSIC_LIST_ID"
        @play-list="handlePlayList"
        @upload-webdav="handleUploadWebDAV"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted } from '@common/utils/vueTools'
import { useRouter } from '@common/utils/vueRouter'
import { LIST_IDS } from '@common/constants'
import { normalizeLocalMusicDirs } from '@common/utils/localMusicSettings'
import { useI18n } from '@root/lang'
import { dialog } from '@renderer/plugins/Dialog'
import { playList } from '@renderer/core/player'
import { setTempList } from '@renderer/store/list/action'
import { appSetting } from '@renderer/store/setting'
import {
  loadLocalMusicList,
  uploadLocalMusicToWebDAV,
} from '@renderer/store/localMusic/action'
import {
  isScanningLocalMusic,
  LOCAL_MUSIC_LIST_ID,
  localMusicList,
  localMusicScanError,
} from '@renderer/store/localMusic/state'

const router = useRouter()
const t = useI18n()

const listLimit = computed(() => Math.max(localMusicList.length, 1))
const localMusicDirs = computed(() => normalizeLocalMusicDirs(appSetting['localMusic.dirs']))

const noItem = computed(() => {
  if (isScanningLocalMusic.value) return t('local_music__scanning')
  if (localMusicScanError.value) return t('local_music__scan_failed', { message: localMusicScanError.value })
  if (!localMusicDirs.value.length) return t('local_music__add_folder_first')
  return localMusicList.length ? '' : t('local_music__empty')
})

const handleRefresh = async() => {
  try {
    await loadLocalMusicList(true)
  } catch (err) {
    void dialog(t('local_music__scan_failed', { message: err.message ?? err }))
  }
}

const handlePlayList = async(index) => {
  await setTempList(LOCAL_MUSIC_LIST_ID, [...localMusicList])
  playList(LIST_IDS.TEMP, index)
}

const handleUploadWebDAV = async(index) => {
  const musicInfo = localMusicList[index]
  if (!musicInfo) return
  try {
    await uploadLocalMusicToWebDAV(musicInfo)
    void dialog(t('local_music__upload_success', { name: musicInfo.name }))
  } catch (err) {
    void dialog(t('local_music__upload_failed', { message: err.message ?? err }))
  }
}

const handleOpenSetting = () => {
  void router.push({
    path: '/setting',
    query: { name: 'SettingLocalMusic' },
  })
}

onMounted(() => {
  void loadLocalMusicList()
})
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.localMusic {
  position: relative;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-flow: column nowrap;
}

.header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 24px 8px;
}

.heading {
  min-width: 0;
  display: flex;
  align-items: flex-end;
  gap: 12px;

  h2 {
    margin: 0;
    font-size: 30px;
    line-height: 1.2;
    color: var(--color-font);
    font-weight: 800;
  }

  p {
    margin: 0 0 4px;
    font-size: 13px;
    color: var(--color-font-label);
  }
}

.actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.iconBtn {
  flex: none;
  width: 34px;
  height: 34px;
  padding: 7px;
  border: 0;
  border-radius: 10px;
  color: var(--color-button-font);
  background-color: transparent;
  outline: none;
  cursor: pointer;
  transition: @transition-fast;
  transition-property: background-color, opacity, transform;

  svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  &:hover {
    background-color: var(--color-button-background-hover);
  }

  &:active {
    transform: scale(.96);
    background-color: var(--color-button-background-active);
  }

  &:disabled {
    opacity: .5;
    cursor: default;
    transform: none;
  }
}

.list {
  flex: auto;
  min-height: 0;
  position: relative;
}
</style>
