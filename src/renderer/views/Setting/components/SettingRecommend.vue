<template lang="pug">
dt#recommend {{ $t('setting__recommend') }}
dd
  h3#recommend_home_section_order {{ $t('setting__recommend_home_section_order') }}
  div(:class="$style.orderPanel")
    p(:class="$style.orderDesc") {{ $t('setting__recommend_home_section_order_tip') }}
    ul(:class="$style.orderList")
      li(v-for="(section, index) in sectionOrder" :key="section" :class="$style.orderItem")
        span(:class="$style.orderIndex") {{ index + 1 }}
        span(:class="$style.orderName") {{ getSectionName(section) }}
        div(:class="$style.orderActions")
          base-btn(:class="$style.orderBtn" min :disabled="index == 0" @click="moveSection(section, -1)") {{ $t('setting__recommend_section_move_up') }}
          base-btn(:class="$style.orderBtn" min :disabled="index == sectionOrder.length - 1" @click="moveSection(section, 1)") {{ $t('setting__recommend_section_move_down') }}
    base-btn(:class="$style.resetBtn" min @click="resetOrder") {{ $t('setting__recommend_section_reset') }}
dd
  h3#recommend_daily_song_category_tags {{ $t('setting__recommend_daily_song_category_tags') }}
  div(:class="$style.tagPanel")
    p(:class="$style.orderDesc") {{ $t('setting__recommend_daily_song_category_tags_tip') }}
    p(v-if="isLoadingDailySongCategories" :class="$style.stateText") {{ $t('setting__recommend_daily_song_category_loading') }}
    p(v-else-if="dailySongCategoryError" :class="$style.errorText") {{ dailySongCategoryError }}
    template(v-else)
      div(v-for="category in dailySongCategories" :key="category.categoryId" :class="$style.categoryGroup")
        h4(:class="$style.categoryName") {{ category.categoryName }}
        div(:class="$style.tagGrid")
          button(
            v-for="tag in category.tags" :key="getTagKey(tag)"
            type="button"
            :class="[$style.tagChip, { [$style.activeTagChip]: isDailySongTagSelected(tag) }]"
            @click="toggleDailySongTag(tag)") {{ tag.tagName }}
      div(:class="$style.selectedPanel")
        div(:class="$style.selectedHead")
          span {{ $t('setting__recommend_daily_song_category_selected') }}
          div(:class="$style.selectedActions")
            base-btn(min @click="resetDailySongTags") {{ $t('setting__recommend_daily_song_category_reset') }}
            base-btn(min @click="clearDailySongTags") {{ $t('setting__recommend_daily_song_category_clear') }}
        p(v-if="!selectedDailySongTags.length" :class="$style.stateText") {{ $t('setting__recommend_daily_song_category_empty') }}
        ul(v-else :class="$style.orderList")
          li(v-for="(tag, index) in selectedDailySongTags" :key="getTagKey(tag)" :class="$style.orderItem")
            span(:class="$style.orderIndex") {{ index + 1 }}
            span(:class="$style.orderName") {{ tag.tagName }}
            small(:class="$style.orderMeta") {{ tag.categoryName }}
            div(:class="$style.orderActions")
              base-btn(:class="$style.orderBtn" min :disabled="index == 0" @click="moveDailySongTag(tag, -1)") {{ $t('setting__recommend_section_move_up') }}
              base-btn(:class="$style.orderBtn" min :disabled="index == selectedDailySongTags.length - 1" @click="moveDailySongTag(tag, 1)") {{ $t('setting__recommend_section_move_down') }}
</template>

<script>
import { computed, onMounted, ref } from '@common/utils/vueTools'
import { RECOMMEND_HOME_SECTION_IDS } from '@common/constants'
import { getDailySongCategoryTagKey } from '@common/utils/neteaseDailySongCategory'
import { useI18n } from '@renderer/plugins/i18n'
import { appSetting, updateSetting } from '@renderer/store/setting'
import { getNeteaseDailySongCategories } from '@renderer/utils/ipc'
import { moveRecommendHomeSection, normalizeRecommendHomeSectionOrder } from '@renderer/utils/recommendSectionOrder'

const sectionNameKeys = {
  radarPlaylists: 'setting__recommend_section_radar',
  styleSongs: 'setting__recommend_section_style_songs',
  dailySongCategories: 'setting__recommend_section_daily_song_categories',
  similarSongs: 'setting__recommend_section_similar_songs',
  recommendPlaylists: 'setting__recommend_section_playlists',
  charts: 'setting__recommend_section_charts',
}

export default {
  name: 'SettingRecommend',
  setup() {
    const t = useI18n()
    const dailySongCategories = ref([])
    const isLoadingDailySongCategories = ref(false)
    const dailySongCategoryError = ref('')
    const sectionOrder = computed(() => normalizeRecommendHomeSectionOrder(appSetting['recommend.homeSectionOrder']))
    const dailySongTagMap = computed(() => {
      const tagMap = new Map()
      for (const category of dailySongCategories.value) {
        for (const tag of category.tags) tagMap.set(getDailySongCategoryTagKey(tag.categoryId, tag.tagId), tag)
      }
      return tagMap
    })
    const defaultDailySongTagKeys = computed(() => {
      return (dailySongCategories.value[0]?.tags ?? [])
        .slice(0, 6)
        .map(tag => getDailySongCategoryTagKey(tag.categoryId, tag.tagId))
    })
    const selectedDailySongTagKeys = computed(() => {
      const rawKeys = appSetting['recommend.dailySongCategoryTagKeys']
      const keys = Array.isArray(rawKeys) ? rawKeys : defaultDailySongTagKeys.value
      const tagMap = dailySongTagMap.value
      const nextKeys = []
      for (const key of keys) {
        if (!tagMap.has(key) || nextKeys.includes(key)) continue
        nextKeys.push(key)
      }
      return nextKeys
    })
    const selectedDailySongTags = computed(() => {
      const tagMap = dailySongTagMap.value
      return selectedDailySongTagKeys.value
        .map(key => tagMap.get(key))
        .filter(Boolean)
    })

    const saveSectionOrder = order => {
      updateSetting({ 'recommend.homeSectionOrder': normalizeRecommendHomeSectionOrder(order) })
    }

    const moveSection = (section, direction) => {
      saveSectionOrder(moveRecommendHomeSection(sectionOrder.value, section, direction))
    }

    const resetOrder = () => {
      saveSectionOrder([...RECOMMEND_HOME_SECTION_IDS])
    }

    const getSectionName = section => t(sectionNameKeys[section] ?? section)
    const getTagKey = tag => getDailySongCategoryTagKey(tag.categoryId, tag.tagId)

    const saveDailySongTagKeys = keys => {
      updateSetting({ 'recommend.dailySongCategoryTagKeys': keys })
    }

    const isDailySongTagSelected = tag => selectedDailySongTagKeys.value.includes(getTagKey(tag))

    const toggleDailySongTag = tag => {
      const tagKey = getTagKey(tag)
      const keys = selectedDailySongTagKeys.value
      saveDailySongTagKeys(keys.includes(tagKey) ? keys.filter(key => key != tagKey) : [...keys, tagKey])
    }

    const moveDailySongTag = (tag, direction) => {
      const keys = [...selectedDailySongTagKeys.value]
      const index = keys.indexOf(getTagKey(tag))
      const targetIndex = index + direction
      if (index < 0 || targetIndex < 0 || targetIndex >= keys.length) return
      const target = keys[targetIndex]
      keys[targetIndex] = keys[index]
      keys[index] = target
      saveDailySongTagKeys(keys)
    }

    const resetDailySongTags = () => {
      updateSetting({ 'recommend.dailySongCategoryTagKeys': null })
    }

    const clearDailySongTags = () => {
      saveDailySongTagKeys([])
    }

    const loadDailySongCategories = async() => {
      isLoadingDailySongCategories.value = true
      dailySongCategoryError.value = ''
      try {
        dailySongCategories.value = await getNeteaseDailySongCategories()
      } catch (err) {
        dailySongCategoryError.value = err?.message ?? t('setting__recommend_daily_song_category_failed')
      } finally {
        isLoadingDailySongCategories.value = false
      }
    }

    onMounted(() => {
      void loadDailySongCategories()
    })

    return {
      sectionOrder,
      dailySongCategories,
      isLoadingDailySongCategories,
      dailySongCategoryError,
      selectedDailySongTags,
      moveSection,
      resetOrder,
      getSectionName,
      getTagKey,
      isDailySongTagSelected,
      toggleDailySongTag,
      moveDailySongTag,
      resetDailySongTags,
      clearDailySongTags,
    }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.orderPanel {
  max-width: 560px;
}

.tagPanel {
  max-width: 720px;
}

.orderDesc {
  margin: 0 0 12px;
  color: var(--color-font-label);
  font-size: 12px;
  line-height: 1.55;
}

.orderList {
  margin: 0;
  padding: 0;
  display: flex;
  flex-flow: column nowrap;
  gap: 8px;
  list-style: none;
}

.orderItem {
  min-height: 44px;
  padding: 8px 10px;
  border: 1px solid rgba(128, 128, 128, .14);
  border-radius: 8px;
  background-color: rgba(128, 128, 128, .045);
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
}

.orderIndex {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  color: var(--color-primary);
  background-color: var(--color-primary-background-hover);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
}

.orderName {
  min-width: 0;
  color: var(--color-font);
  font-size: 13px;
  font-weight: 700;
  .mixin-ellipsis-1();
}

.orderMeta {
  color: var(--color-font-label);
  font-size: 12px;
}

.orderActions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.orderBtn {
  min-width: 52px;
}

.resetBtn {
  margin-top: 12px;
}

.stateText,
.errorText {
  margin: 10px 0 0;
  color: var(--color-font-label);
  font-size: 12px;
  line-height: 1.55;
}

.errorText {
  color: var(--color-primary);
}

.categoryGroup {
  margin-top: 14px;
}

.categoryName {
  margin: 0 0 8px;
  color: var(--color-font);
  font-size: 13px;
  line-height: 1.3;
  font-weight: 800;
}

.tagGrid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tagChip {
  height: 30px;
  padding: 0 12px;
  border: 1px solid rgba(128, 128, 128, .16);
  border-radius: 999px;
  color: var(--color-font);
  background-color: rgba(128, 128, 128, .045);
  cursor: pointer;
  transition: color @transition-fast, border-color @transition-fast, background-color @transition-fast, transform @transition-fast;

  &:hover {
    transform: translateY(-1px);
    border-color: rgba(128, 128, 128, .28);
  }
}

.activeTagChip {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background-color: var(--color-primary-background-hover);
}

.selectedPanel {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid rgba(128, 128, 128, .12);
}

.selectedHead {
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--color-font);
  font-size: 13px;
  font-weight: 800;
}

.selectedActions {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
