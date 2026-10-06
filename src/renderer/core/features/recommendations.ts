import { watch } from '@common/utils/vueTools'
import { getFeatureMode, type FeatureId } from '@common/performance/featurePolicy'
import { appSetting } from '@renderer/store/setting'
import { featureRuntimeStates, registerFeaturePreparation, reportFeatureState } from './runtime'
import { recommendationPlaybackActive } from './recommendationAccess'

type RecommendationFeature = 'neteaseRecommend' | 'qqRecommend' | 'kugouRecommend'
const loaders = {
  neteaseRecommend: async() => import('@renderer/views/Recommend/index.vue'),
  qqRecommend: async() => import('@renderer/views/QQRecommend/index.vue'),
  kugouRecommend: async() => import('@renderer/views/KugouRecommend/index.vue'),
}
const pending = new Map<RecommendationFeature, ReturnType<typeof loaders[RecommendationFeature]>>()
const releaseRequested = new Set<RecommendationFeature>()
let activePage: FeatureId | null = null

export const loadRecommendationPage = async(feature: RecommendationFeature) => {
  let operation = pending.get(feature)
  if (!operation) {
    operation = loaders[feature]()
    pending.set(feature, operation)
  }
  try {
    const component = await operation
    const mode = getFeatureMode(appSetting, feature)
    reportFeatureState(feature, { loaded: true, restartRequired: mode == 'off' || releaseRequested.has(feature), error: null })
    // Vue Router caches this result; permission is checked again before navigation commits.
    return component
  } catch (error) {
    pending.delete(feature)
    reportFeatureState(feature, { error: 'performance_runtime_error' })
    throw error
  }
}

export const noteFeaturePageLoaded = (feature: FeatureId | null) => {
  if (activePage && activePage in loaders) reportFeatureState(activePage, { active: recommendationPlaybackActive[activePage as RecommendationFeature] })
  activePage = feature
  if (feature && feature in loaders) reportFeatureState(feature, { active: true })
}

export const initRecommendationPolicies = () => {
  for (const feature of Object.keys(loaders) as RecommendationFeature[]) {
    watch(() => recommendationPlaybackActive[feature], active => {
      reportFeatureState(feature, { active: active || activePage == feature })
    }, { flush: 'sync' })
    registerFeaturePreparation(feature, async() => {
      if (getFeatureMode(appSetting, feature) != 'off') await loadRecommendationPage(feature)
    })
    watch(() => getFeatureMode(appSetting, feature), (mode, before) => {
      if (mode == 'resident') releaseRequested.delete(feature)
      else if (before == 'resident' && pending.has(feature)) releaseRequested.add(feature)
      reportFeatureState(feature, { restartRequired: featureRuntimeStates[feature].loaded && (mode == 'off' || releaseRequested.has(feature)) })
      if (mode == 'resident') void loadRecommendationPage(feature).catch(() => {})
    }, { immediate: true, flush: 'sync' })
  }
}
