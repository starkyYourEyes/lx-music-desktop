<template lang="pug">
div(:class="$style.root")
  ul(v-if="fallbackEntries.length" :class="$style.list")
    li(v-for="(source, index) in fallbackEntries" :key="source.id" :class="$style.item")
      span(:class="$style.label") {{ source.label }}
      div(:class="$style.actions")
        button(
          type="button" :class="$style.iconButton" :disabled="index == 0"
          :aria-label="$t('setting__basic_source_fallback_move_up')" :title="$t('setting__basic_source_fallback_move_up')"
          @click="moveSource(source.id, -1)")
          svg(version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024" :class="$style.upIcon")
            use(xlink:href="#icon-down")
        button(
          type="button" :class="$style.iconButton" :disabled="index == fallbackEntries.length - 1"
          :aria-label="$t('setting__basic_source_fallback_move_down')" :title="$t('setting__basic_source_fallback_move_down')"
          @click="moveSource(source.id, 1)")
          svg(version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024")
            use(xlink:href="#icon-down")
        button(
          type="button" :class="$style.iconButton"
          :aria-label="$t('setting__basic_source_fallback_remove')" :title="$t('setting__basic_source_fallback_remove')"
          @click="removeSource(source.id)")
          svg(version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 212.982 212.982")
            use(xlink:href="#icon-delete")
  p(v-else :class="$style.empty") {{ $t('setting__basic_source_fallback_empty') }}
  button(
    type="button" :class="$style.addButton" :disabled="!availableSources.length"
    :aria-label="availableSources.length ? $t('setting__basic_source_fallback_add') : $t('setting__basic_source_fallback_no_available')"
    :title="availableSources.length ? $t('setting__basic_source_fallback_add') : $t('setting__basic_source_fallback_no_available')"
    @click="showAddMenu") {{ $t('setting__basic_source_fallback_add') }}
  base-menu(v-model="isShowAddMenu" :menus="availableSources" :xy="addMenuLocation" item-name="label" @menu-click="addSource")
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref } from '@common/utils/vueTools'
import {
  addPlaybackFallback,
  getAddablePlaybackSources,
  movePlaybackFallback,
  removePlaybackFallback,
} from '@common/utils/playbackSourceSetting'

interface ApiSourceOption {
  id: string
  label: string
  disabled: boolean
}

interface Props {
  sources: ApiSourceOption[]
  primaryId: string
  fallbackIds: string[]
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:fallbackIds': [ids: string[]]
}>()

const availableSources = computed(() => getAddablePlaybackSources(
  props.sources,
  props.primaryId,
  props.fallbackIds,
))
const fallbackEntries = computed(() => props.fallbackIds.map((id: string) => ({
  id,
  label: props.sources.find((source: ApiSourceOption) => source.id == id)?.label ?? id,
})))
const isShowAddMenu = ref(false)
const addMenuLocation = reactive({ x: 0, y: 0 })

const addSource = (source: ApiSourceOption | null) => {
  if (!source) return
  emit('update:fallbackIds', addPlaybackFallback(props.fallbackIds, source.id))
}
const moveSource = (apiId: string, offset: -1 | 1) => emit(
  'update:fallbackIds',
  movePlaybackFallback(props.fallbackIds, apiId, offset),
)
const removeSource = (apiId: string) => emit(
  'update:fallbackIds',
  removePlaybackFallback(props.fallbackIds, apiId),
)
const showAddMenu = (event: MouseEvent) => {
  addMenuLocation.x = event.pageX
  addMenuLocation.y = event.pageY
  void nextTick(() => {
    isShowAddMenu.value = true
  })
}
</script>

<style lang="less" module>
.root {
  min-width: 0;
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.item {
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.label {
  min-width: 0;
  flex: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  flex: none;
  display: flex;
  gap: 4px;
}

.iconButton {
  width: 30px;
  height: 30px;
  padding: 7px;
  box-sizing: border-box;
  border: 0;
  border-radius: 3px;
  color: var(--color-font);
  background: transparent;
  cursor: pointer;

  svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  &:hover:not(:disabled),
  &:focus-visible:not(:disabled) {
    background-color: var(--color-primary-background-hover);
    outline: none;
  }

  &:disabled {
    cursor: default;
    opacity: .4;
  }
}

.upIcon {
  transform: rotate(180deg);
}

.empty {
  margin: 0;
  min-height: 34px;
  line-height: 34px;
  color: var(--color-500);
}

.addButton {
  min-height: 30px;
  margin-top: 6px;
  padding: 0 10px;
  border: 0;
  border-radius: 3px;
  color: var(--color-font);
  background: var(--color-primary-background-hover);
  cursor: pointer;

  &:disabled {
    cursor: default;
    opacity: .5;
  }
}
</style>
