import { getFeatureMode, type FeatureId } from '@common/performance/featurePolicy'

export interface OptionalResourceState {
  loaded: boolean
  active: boolean
  restartRequired?: boolean
  error?: string
}

const states = new Map<FeatureId, OptionalResourceState>()
const preparations = new Map<FeatureId, () => Promise<void> | void>()
const preparing = new Map<FeatureId, Promise<void>>()

export const registerOptionalResourcePreparation = (feature: FeatureId, prepare: () => Promise<void> | void) => {
  preparations.set(feature, prepare)
}

export const prepareOptionalResource = async(feature: FeatureId) => {
  if (getFeatureMode(global.lx.appSetting, feature) == 'off') return
  const current = preparing.get(feature)
  if (current) return current
  const task = Promise.resolve().then(async() => {
    if (getFeatureMode(global.lx.appSetting, feature) == 'off') return
    reportOptionalResourceState(feature, { error: undefined })
    if (feature == 'neteaseRecommend') {
      const module = await import('../modules/netease')
      if (getFeatureMode(global.lx.appSetting, feature) != 'off') module.prepareNeteaseRecommendation()
    } else await preparations.get(feature)?.()
  }).catch(error => {
    reportOptionalResourceState(feature, { error: String(error) })
    throw error
  }).finally(() => { preparing.delete(feature) })
  preparing.set(feature, task)
  return task
}

export const reportOptionalResourceState = (feature: FeatureId, state: Partial<OptionalResourceState>) => {
  states.set(feature, { loaded: false, active: false, ...states.get(feature), ...state })
}

export const getOptionalResourceStatus = () => Object.fromEntries(
  [...states].map(([feature, state]) => [feature, { ...state }]),
) as Partial<Record<FeatureId, OptionalResourceState>>

let initialized = false
export const initOptionalResources = () => {
  if (initialized) return
  initialized = true
  const apply = () => {
    const mode = getFeatureMode(global.lx.appSetting, 'neteaseRecommend')
    const loaded = states.get('neteaseRecommend')?.loaded ?? false
    reportOptionalResourceState('neteaseRecommend', { restartRequired: mode == 'off' && loaded })
    if (mode != 'resident') return
    void prepareOptionalResource('neteaseRecommend').catch(() => {})
  }
  global.lx.event_app.on('app_inited', apply)
  global.lx.event_app.on('updated_config', keys => {
    if (keys.includes('performance.features.neteaseRecommend')) apply()
  })
}
