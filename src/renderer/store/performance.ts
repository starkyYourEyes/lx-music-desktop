import { computed, nextTick, reactive, ref, watch } from '@common/utils/vueTools'
import { rendererInvoke } from '@common/rendererIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { FEATURE_IDS, PERFORMANCE_KEYS, normalizePerformancePatch, type FeatureId, type PerformanceSettings } from '@common/performance/featurePolicy'
import { createSettingsDraft } from '@common/performance/settingsDraft'
import { appSetting, mergeSetting } from './setting'
import { featureRuntimeStates, type FeatureRuntimeState } from '@renderer/core/features/runtime'

const savedValues = () => Object.fromEntries(PERFORMANCE_KEYS.map(key => [key, appSetting[key]])) as PerformanceSettings
const model = createSettingsDraft(savedValues())
const revision = ref(0)
export const performanceDraft = computed(() => { void revision.value; return { ...model.values } })
export const performanceSaving = ref(false)
export const performanceError = ref('')
export const showRestartNotice = ref(false)
export const performanceConflicts = computed(() => { void revision.value; return model.conflicts() })
export const performanceDirty = computed(() => { void revision.value; return Object.keys(model.patch()).length > 0 })
const mainStates = reactive<Partial<Record<FeatureId, Partial<FeatureRuntimeState>>>>({})
export const performanceStates = computed(() => Object.fromEntries(FEATURE_IDS.map(id => {
  const renderer = featureRuntimeStates[id]
  const main = mainStates[id]
  return [id, {
    ...renderer,
    loaded: renderer.loaded || !!main?.loaded,
    active: renderer.active || !!main?.active,
    restartRequired: renderer.restartRequired || !!main?.restartRequired,
    error: renderer.error || main?.error,
  }]
})) as Record<FeatureId, FeatureRuntimeState>)
export const restartFeatures = computed(() => FEATURE_IDS.filter(id => performanceStates.value[id].restartRequired))
let lastNotice = ''
let statusGeneration = 0

watch(savedValues, values => { model.sync(values); revision.value++ }, { deep: true })
export const editPerformanceSetting = <K extends keyof PerformanceSettings>(key: K, value: PerformanceSettings[K]) => {
  if (performanceSaving.value) return
  model.set(key, value)
  revision.value++
}
export const revertPerformanceDraft = () => { model.reset(); revision.value++; performanceError.value = '' }
export const confirmPerformanceConflicts = () => {
  for (const key of model.conflicts()) model.set(key, model.values[key])
  revision.value++
}
export const refreshPerformanceStatus = async() => {
  const token = ++statusGeneration
  const status = await rendererInvoke<Partial<Record<FeatureId, Partial<FeatureRuntimeState>>>>(WIN_MAIN_RENDERER_EVENT_NAME.performance_status)
  if (token != statusGeneration) return
  for (const feature of FEATURE_IDS) {
    mainStates[feature] = status[feature]
  }
}
export const prepareMainPerformanceFeature = async(feature: FeatureId): Promise<void> => {
  await rendererInvoke(WIN_MAIN_RENDERER_EVENT_NAME.performance_prepare, feature)
  await refreshPerformanceStatus()
}
export const applyPerformanceDraft = async(): Promise<boolean> => {
  if (performanceSaving.value || model.conflicts().length) return false
  if (!Object.keys(model.patch()).length) return true
  performanceSaving.value = true
  performanceError.value = ''
  statusGeneration++
  const patch = model.patch()
  const before = { ...appSetting }
  try {
    const acknowledgedKeys = Object.keys(normalizePerformancePatch(before, patch)) as Array<keyof LX.AppSetting>
    const saved = await rendererInvoke<Partial<PerformanceSettings>, LX.AppSetting>(WIN_MAIN_RENDERER_EVENT_NAME.performance_apply, patch)
    const accepted = Object.fromEntries(acknowledgedKeys
      .filter(key => Object.hasOwn(saved, key) && (appSetting[key] == before[key] || appSetting[key] == saved[key]))
      .map(key => [key, saved[key]])) as Partial<LX.AppSetting>
    mergeSetting(accepted)
    model.sync(savedValues())
    model.reset()
    revision.value++
    // Allow local lifecycle watchers to observe the saved policy before reading status.
    await nextTick()
    try {
      await refreshPerformanceStatus()
    } catch {
      performanceError.value = 'performance_runtime_error'
      return true
    }
    const notice = restartFeatures.value.join(',')
    if (notice && notice != lastNotice) showRestartNotice.value = true
    lastNotice = notice
    return true
  } catch {
    performanceError.value = 'performance_save_error'
    return false
  } finally {
    performanceSaving.value = false
  }
}
export const restartAppForPerformance = async() => {
  if (performanceSaving.value) return
  performanceSaving.value = true
  performanceError.value = ''
  try {
    await rendererInvoke(WIN_MAIN_RENDERER_EVENT_NAME.performance_restart)
  } catch {
    performanceError.value = 'performance_restart_error'
    performanceSaving.value = false
  }
}

export const showPerformanceLeaveNotice = ref(false)
let leaveResolver: ((leave: boolean) => void) | null = null
export const requestPerformanceLeave = async(): Promise<boolean> => {
  if (!performanceDirty.value) return true
  if (performanceSaving.value || leaveResolver) return false
  showPerformanceLeaveNotice.value = true
  return new Promise(resolve => { leaveResolver = resolve })
}
export const finishPerformanceLeave = async(action: 'save' | 'discard' | 'stay') => {
  if (action == 'save' && !await applyPerformanceDraft()) return
  if (action == 'discard') revertPerformanceDraft()
  showPerformanceLeaveNotice.value = false
  leaveResolver?.(action != 'stay')
  leaveResolver = null
}
