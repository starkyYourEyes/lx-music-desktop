<template>
  <dt>{{ $t('setting__performance') }}</dt>
  <dd :class="$style.intro">{{ $t('performance_intro') }}</dd>
  <dd v-if="restartFeatures.length" :class="$style.notice" role="status">
    <p>{{ $t('performance_restart_pending') }}: {{ restartFeatures.map(id => $t(`performance_feature_${id}`)).join('、') }}</p>
    <base-btn min @click="showRestartNotice = true">{{ $t('performance_restart_review') }}</base-btn>
  </dd>
  <dd>
    <h3>{{ $t('performance_loading') }}</h3>
    <fieldset :disabled="performanceSaving" :class="$style.fields">
      <div v-for="feature in FEATURE_IDS" :key="feature" :class="$style.feature">
        <div>
          <label :for="`policy-${feature}`">{{ $t(`performance_feature_${feature}`) }}</label>
          <p :class="$style.detail">{{ $t(`performance_description_${feature}`) }}</p>
          <p :class="$style.status" role="status">{{ statusLabel(feature) }}</p>
          <base-btn v-if="performanceStates[feature].error" min @click="retryFeature(feature)">{{ $t('performance_retry') }}</base-btn>
        </div>
        <select :id="`policy-${feature}`" :value="performanceDraft[featureSettingKey(feature)]" @change="editMode(feature, $event)">
          <option v-for="mode in FEATURE_MODES" :key="mode" :value="mode">{{ $t(`performance_mode_${mode}`) }}</option>
        </select>
      </div>
    </fieldset>
    <div v-if="performanceStates.download.draining" :class="$style.notice" role="status">
      <p>{{ $t('performance_download_draining', { count: performanceStates.download.activeCount }) }}</p>
      <base-btn min @click="pauseDownloads">{{ $t('performance_pause_downloads') }}</base-btn>
    </div>
  </dd>
  <dd>
    <h3>{{ $t('performance_cache') }}</h3>
    <fieldset :disabled="performanceSaving" :class="$style.fields">
      <label :class="$style.control">
        {{ $t('performance_cache_profile') }}
        <select :value="performanceDraft['performance.cacheProfile']" @change="editProfile">
          <option v-for="profile in ['compact', 'balanced', 'generous']" :key="profile" :value="profile">{{ $t(`performance_profile_${profile}`) }}</option>
        </select>
      </label>
      <p :class="$style.detail">{{ $t('performance_cache_description') }}</p>
      <label :class="$style.control">
        {{ $t('performance_source_idle') }}
        <select :value="performanceDraft['performance.sourceIdleMinutes']" @change="editIdle">
          <option v-for="minutes in [1, 5, 15, 0]" :key="minutes" :value="minutes">{{ minutes ? $t('performance_minutes', { count: minutes }) : $t('performance_never') }}</option>
        </select>
      </label>
      <p :class="$style.detail">{{ $t('performance_source_description') }}</p>
    </fieldset>
  </dd>
  <dd>
    <h3>{{ $t('performance_visuals') }}</h3>
    <base-checkbox id="performance_simple_visuals" :disabled="performanceSaving" :model-value="performanceDraft['performance.simplifyVisuals']" :label="$t('performance_simplify')" @update:model-value="editPerformanceSetting('performance.simplifyVisuals', $event)" />
    <p :class="$style.detail">{{ $t('performance_simplify_description') }}</p>
  </dd>
  <dd :class="$style.actions">
    <p v-if="performanceConflicts.length" role="alert">{{ $t('performance_conflict') }} <base-btn min @click="confirmPerformanceConflicts">{{ $t('performance_confirm_draft') }}</base-btn></p>
    <p v-if="performanceError" role="alert">{{ $t(performanceError) }}</p>
    <base-btn :disabled="!performanceDirty || performanceSaving || performanceConflicts.length > 0" @click="applyPerformanceDraft">{{ $t(performanceSaving ? 'performance_saving' : 'performance_apply') }}</base-btn>
    <base-btn :disabled="!performanceDirty || performanceSaving" @click="revertPerformanceDraft">{{ $t('performance_revert') }}</base-btn>
  </dd>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from '@renderer/plugins/i18n'
import { FEATURE_IDS, FEATURE_MODES, featureSettingKey, getFeatureMode, type FeatureId, type FeatureLoadMode, type CacheProfile } from '@common/performance/featurePolicy'
import { appSetting } from '@renderer/store/setting'
import { prepareFeature } from '@renderer/core/features/runtime'
import {
  performanceStates, performanceDraft, performanceDirty, performanceSaving, performanceError, performanceConflicts,
  editPerformanceSetting, applyPerformanceDraft, revertPerformanceDraft, confirmPerformanceConflicts,
  restartFeatures, showRestartNotice, refreshPerformanceStatus,
  prepareMainPerformanceFeature,
} from '@renderer/store/performance'
const t = useI18n()
const valueOf = (event: Event) => (event.target as HTMLSelectElement).value
const editMode = (feature: FeatureId, event: Event) => { editPerformanceSetting(featureSettingKey(feature), valueOf(event) as FeatureLoadMode) }
const editProfile = (event: Event) => { editPerformanceSetting('performance.cacheProfile', valueOf(event) as CacheProfile) }
const editIdle = (event: Event) => { editPerformanceSetting('performance.sourceIdleMinutes', Number(valueOf(event)) as 0 | 1 | 5 | 15) }
const statusLabel = (feature: FeatureId) => {
  const state = performanceStates.value[feature]
  return t(state.error ? 'performance_state_error' : state.draining ? 'performance_state_draining' : state.restartRequired ? 'performance_state_restart' : state.active ? 'performance_state_active' : getFeatureMode(appSetting, feature) == 'off' ? 'performance_state_off' : state.loaded ? 'performance_state_ready' : 'performance_state_idle')
}
const retryFeature = async(feature: FeatureId) => {
  try { await prepareFeature(feature); await prepareMainPerformanceFeature(feature) } catch { performanceError.value = 'performance_runtime_error' }
}
const pauseDownloads = async() => {
  try { await (await import('@renderer/core/features/downloadRuntime')).pauseCurrentDownloads() } catch { performanceError.value = 'performance_runtime_error' }
}
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void refreshPerformanceStatus().catch(() => {})
  timer = setInterval(() => { void refreshPerformanceStatus().catch(() => {}) }, 2000)
})
onBeforeUnmount(() => { clearInterval(timer) })
</script>

<style module lang="less">
.intro { line-height: 1.6; opacity: .8; }
.fields { border: 0; padding: 0; margin: 0; min-width: 0; }
.feature { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 14px 0; border-bottom: 1px solid var(--color-primary-alpha-100); }
.feature label { font-size: 14px; }
.detail { margin-top: 6px; opacity: .65; line-height: 1.55; font-size: 12px; }
.status { font-size: 12px; margin-top: 6px; color: var(--color-primary); }
.fields select { flex: none; color: var(--color-font); background: var(--color-content-background); border: 1px solid var(--color-primary-alpha-300); border-radius: 5px; padding: 7px 9px; min-width: 120px; }
.fields select:focus-visible { outline: 2px solid var(--color-primary); }
.control { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-top: 16px; }
.notice { padding: 14px; border-left: 3px solid var(--color-primary); background: var(--color-primary-alpha-100); line-height: 1.6; }
.actions.actions { position: sticky; bottom: 0; z-index: 1; padding: 14px 24px; &, &:hover { background: var(--color-primary-light-1000); } > button { margin-right: 12px; } p { margin-bottom: 12px; } }
</style>
