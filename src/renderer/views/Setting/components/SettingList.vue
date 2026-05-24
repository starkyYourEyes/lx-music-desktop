<template lang="pug">
dt#list {{ $t('setting__list') }}
dd
  .gap-top
    base-checkbox(id="setting_list_actionButtonsVisible_enable" :model-value="appSetting['list.actionButtonsVisible']" :label="$t('setting__list_action_btn')" @update:model-value="updateSetting({'list.actionButtonsVisible': $event})")
  .gap-top
    base-checkbox(id="setting_list_showSource_enable" :model-value="appSetting['list.isShowSource']" :label="$t('setting__list_source')" @update:model-value="updateSetting({'list.isShowSource': $event})")
  .gap-top
    base-checkbox(id="setting_list_scroll_enable" :model-value="appSetting['list.isSaveScrollLocation']" :label="$t('setting__list_scroll')" @update:model-value="updateSetting({'list.isSaveScrollLocation': $event})")
  .gap-top
    base-checkbox(id="setting_list_clickAction_enable" :model-value="appSetting['list.isClickPlayList']" :label="$t('setting__list_click_action')" @update:model-value="updateSetting({'list.isClickPlayList': $event})")
dd(:aria-label="$t('setting__basic_sourcename_title')")
  h3#list_addMusicLocationType {{ $t('setting__list_add_music_location_type') }}
  div
    base-checkbox.gap-left(
      id="setting_list_add_music_location_type_top" name="setting_list_add_music_location_type" need
      :model-value="appSetting['list.addMusicLocationType']" value="top" :label="$t('setting__list_add_music_location_type_top')"
      @update:model-value="updateSetting({'list.addMusicLocationType': $event})")
    base-checkbox.gap-left(
      id="setting_list_add_music_location_type_bottom" name="setting_list_add_music_location_type" need
      :model-value="appSetting['list.addMusicLocationType']" value="bottom" :label="$t('setting__list_add_music_location_type_bottom')"
      @update:model-value="updateSetting({'list.addMusicLocationType': $event})")
dd
  h3#list_my_list_sidebar_scale {{ $t('setting__list_my_list_sidebar_scale') }}
  div
    .p(:class="$style.scaleControl")
      input(
        :class="$style.scaleRange" type="range" min="70" max="130" step="5"
        :value="appSetting['list.myListSidebarScale']"
        @input="handleSidebarScaleChange")
      base-input.gap-left(
        :class="$style.scaleInput" type="number"
        :model-value="appSetting['list.myListSidebarScale']"
        @change="handleSidebarScaleChange")
      span(:class="$style.scaleUnit") %
dd
  h3#list_playlist_profile_scale {{ $t('setting__list_playlist_profile_scale') }}
  div
    .p(:class="$style.scaleControl")
      input(
        :class="$style.scaleRange" type="range" min="60" max="140" step="5"
        :value="appSetting['list.playlistProfileScale']"
        @input="handlePlaylistProfileScaleChange")
      base-input.gap-left(
        :class="$style.scaleInput" type="number"
        :model-value="appSetting['list.playlistProfileScale']"
        @change="handlePlaylistProfileScaleChange")
      span(:class="$style.scaleUnit") %

</template>

<script>
// import { ref, onBeforeUnmount } from '@common/utils/vueTools'
import { appSetting, updateSetting } from '@renderer/store/setting'

const normalizeSidebarScale = value => {
  const num = Math.round(Number(value) || 90)
  return Math.min(130, Math.max(70, num))
}
const normalizePlaylistProfileScale = value => {
  const num = Math.round(Number(value) || 85)
  return Math.min(140, Math.max(60, num))
}

export default {
  name: 'SettingList',
  setup() {
    const handleSidebarScaleChange = value => {
      updateSetting({ 'list.myListSidebarScale': normalizeSidebarScale(value?.target ? value.target.value : value) })
    }
    const handlePlaylistProfileScaleChange = value => {
      updateSetting({ 'list.playlistProfileScale': normalizePlaylistProfileScale(value?.target ? value.target.value : value) })
    }

    return {
      appSetting,
      updateSetting,
      handleSidebarScaleChange,
      handlePlaylistProfileScaleChange,
    }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.scaleControl {
  display: flex;
  align-items: center;
  gap: 8px;
}
.scaleRange {
  width: 180px;
  max-width: 36vw;
  accent-color: var(--color-primary);
  cursor: pointer;
}
.scaleInput {
  width: 62px;
  text-align: center;
}
.scaleUnit {
  color: var(--color-label);
}
</style>
