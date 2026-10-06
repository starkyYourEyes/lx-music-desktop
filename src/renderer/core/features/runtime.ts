import { reactive } from '@common/utils/vueTools'
import { FEATURE_IDS, type FeatureId } from '@common/performance/featurePolicy'

export interface FeatureRuntimeState {
  loaded: boolean
  active: boolean
  draining: boolean
  restartRequired: boolean
  error: string | null
  activeCount: number
  pendingCount: number
}

export const featureRuntimeStates = reactive(Object.fromEntries(FEATURE_IDS.map(feature => [feature, {
  loaded: false,
  active: false,
  draining: false,
  restartRequired: false,
  error: null,
  activeCount: 0,
  pendingCount: 0,
}])) as Record<FeatureId, FeatureRuntimeState>)

const preparations = new Map<FeatureId, () => Promise<void> | void>()
export const reportFeatureState = (feature: FeatureId, state: Partial<FeatureRuntimeState>): void => {
  Object.assign(featureRuntimeStates[feature], state)
}
export const registerFeaturePreparation = (feature: FeatureId, prepare: () => Promise<void> | void): (() => void) => {
  preparations.set(feature, prepare)
  return () => { if (preparations.get(feature) == prepare) preparations.delete(feature) }
}
export const prepareFeature = async(feature: FeatureId): Promise<void> => {
  await preparations.get(feature)?.()
}
