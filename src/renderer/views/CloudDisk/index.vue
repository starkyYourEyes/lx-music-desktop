<template>
  <div :class="$style.cloudDisk" @click="handleContainerClick">
    <div :class="$style.header">
      <div :class="$style.heading">
        <h2>{{ webDAVList.name }}</h2>
        <p>{{ list.length }} 首歌曲</p>
      </div>
      <button
        type="button"
        :class="$style.refreshBtn"
        :disabled="fetchingListStatus[webDAVList.id]"
        :aria-label="$t('list_update_modal__title')"
        @click="handleRefresh"
      >
        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" space="preserve">
          <use xlink:href="#icon-refresh" />
        </svg>
      </button>
    </div>
    <MusicList ref="musicList" :list-id="webDAVList.id" @show-menu="handleShowMenu" />
  </div>
</template>

<script setup>
import { ref, onBeforeUnmount, onMounted } from '@common/utils/vueTools'
import { getListMusics, refreshWebDAVList } from '@renderer/store/list/action'
import { fetchingListStatus, webDAVList } from '@renderer/store/list/state'
import MusicList from '@renderer/views/List/MusicList/index.vue'

const musicList = ref(null)
const list = ref([])

const updateList = async() => {
  list.value = [...await getListMusics(webDAVList.id)]
}

const handleRefresh = async() => {
  list.value = [...await refreshWebDAVList()]
}

const handleShowMenu = () => {}

const handleContainerClick = () => {
  musicList.value?.handleMenuClick()
}

const handleMyListUpdate = (ids) => {
  if (!ids.includes(webDAVList.id)) return
  void updateList()
}

onMounted(() => {
  void updateList()
  window.app_event.on('myListUpdate', handleMyListUpdate)
})

onBeforeUnmount(() => {
  window.app_event.off('myListUpdate', handleMyListUpdate)
})
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.cloudDisk {
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

.refreshBtn {
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
</style>
