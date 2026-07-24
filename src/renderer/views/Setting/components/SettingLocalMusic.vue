<template lang="pug">
dt#local_music {{ $t('local_music') }}
dd
  h3#local_music_dirs {{ $t('local_music__folders') }}
  div
    .p
      | {{ $t('local_music__scan_folders') }}
      base-btn.btn.gap-left(min @click="handleAddLocalMusicDir") {{ $t('local_music__add_folder') }}
    .p(v-if="!localMusicDirs.length")
      span.auto-hidden {{ $t('local_music__no_folders') }}
    .p(v-for="dir in localMusicDirs" :key="dir")
      span.auto-hidden(:title="dir") {{ dir }}
      base-btn.btn.gap-left(min @click="handleRemoveLocalMusicDir(dir)") {{ $t('local_music__remove_folder') }}
dd
  h3#local_music_webdav {{ $t('local_music__webdav_source') }}
  div
    .p
      | {{ $t('local_music__upload_dir') }}
      input.input.gap-left(type="text" :value="appSetting['localMusic.webdavDir']" placeholder="local-music" @change="handleLocalMusicWebDAVDirChange")
    .p
      span.auto-hidden {{ $t('local_music__webdav_tip') }}
</template>

<script>
import { computed } from '@common/utils/vueTools'
import {
  normalizeLocalMusicDirs,
  normalizeLocalMusicWebDAVDir,
} from '@common/utils/localMusicSettings'
import { showSelectDialog } from '@renderer/utils/ipc'
import { appSetting, updateSetting } from '@renderer/store/setting'

export default {
  name: 'SettingLocalMusic',
  setup() {
    const localMusicDirs = computed(() => normalizeLocalMusicDirs(appSetting['localMusic.dirs']))

    const handleAddLocalMusicDir = async() => {
      const result = await showSelectDialog({
        properties: ['openDirectory', 'multiSelections'],
      })
      if (result.canceled || !result.filePaths?.length) return
      const dirs = Array.from(new Set([
        ...localMusicDirs.value,
        ...result.filePaths,
      ]))
      updateSetting({ 'localMusic.dirs': dirs })
    }

    const handleRemoveLocalMusicDir = (dir) => {
      updateSetting({
        'localMusic.dirs': localMusicDirs.value.filter(item => item != dir),
      })
    }

    const handleLocalMusicWebDAVDirChange = (event) => {
      updateSetting({ 'localMusic.webdavDir': normalizeLocalMusicWebDAVDir(event.target.value) })
    }

    return {
      appSetting,
      localMusicDirs,
      handleAddLocalMusicDir,
      handleRemoveLocalMusicDir,
      handleLocalMusicWebDAVDirChange,
    }
  },
}
</script>
