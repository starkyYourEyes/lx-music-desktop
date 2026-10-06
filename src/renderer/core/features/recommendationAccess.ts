import { getCurrentScope, onScopeDispose, reactive, watch } from 'vue'
import { getFeatureMode } from '@common/performance/featurePolicy'
import { rendererInvoke } from '@common/rendererIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { appSetting } from '@renderer/store/setting'

export type RecommendationFeature = 'neteaseRecommend' | 'qqRecommend' | 'kugouRecommend'
type RecommendationSession = 'neteaseFm' | 'qqGuessLike' | 'qqBrush'
const features: RecommendationFeature[] = ['neteaseRecommend', 'qqRecommend', 'kugouRecommend']
const revisions = new Map<RecommendationFeature, number>()
const cleanups = new Map<RecommendationFeature, Set<() => void>>()
const sessions = new Map<RecommendationSession, Promise<void>>()
const activeSessions = new Set<RecommendationSession>()
export const hasRecommendationSession = (session: RecommendationSession) => activeSessions.has(session)
export const recommendationPlaybackActive = reactive({ neteaseRecommend: false, qqRecommend: false, kugouRecommend: false })

for (const feature of features) {
  revisions.set(feature, 0)
  cleanups.set(feature, new Set())
  watch(() => getFeatureMode(appSetting, feature), mode => {
    if (mode != 'off') return
    revisions.set(feature, (revisions.get(feature) ?? 0) + 1)
    for (const cleanup of cleanups.get(feature)!) cleanup()
  }, { flush: 'sync' })
}

export const isRecommendationEnabled = (feature: RecommendationFeature) => getFeatureMode(appSetting, feature) != 'off'
export const getRecommendationRevision = (feature: RecommendationFeature) => revisions.get(feature) ?? 0
export const isRecommendationRequestCurrent = (feature: RecommendationFeature, revision: number) => isRecommendationEnabled(feature) && revision == getRecommendationRevision(feature)
export const assertRecommendationEnabled = (feature: RecommendationFeature) => {
  if (!isRecommendationEnabled(feature)) throw new Error('Recommendations are disabled')
}

export const registerRecommendationCleanup = (feature: RecommendationFeature, cleanup: () => void) => {
  cleanups.get(feature)!.add(cleanup)
  if (!isRecommendationEnabled(feature)) cleanup()
  return () => { cleanups.get(feature)!.delete(cleanup) }
}

export const useRecommendationPage = (feature: RecommendationFeature, clear: () => void) => {
  const unregister = registerRecommendationCleanup(feature, clear)
  if (getCurrentScope()) {
    onScopeDispose(() => {
      unregister()
      clear()
    })
  }
  return () => isRecommendationEnabled(feature)
}

const sessionInfo = (session: RecommendationSession) => session == 'neteaseFm'
  ? { feature: 'neteaseRecommend' as const, channel: WIN_MAIN_RENDERER_EVENT_NAME.netease_get_private_fm, radioMode: undefined }
  : { feature: 'qqRecommend' as const, channel: WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_guess_like_songs, radioMode: session == 'qqBrush' ? 'brush' : 'guessLike' }

const reportSessions = () => {
  recommendationPlaybackActive.neteaseRecommend = activeSessions.has('neteaseFm')
  recommendationPlaybackActive.qqRecommend = activeSessions.has('qqGuessLike') || activeSessions.has('qqBrush')
}

export const endRecommendationSession = (session: RecommendationSession) => {
  if (!sessions.has(session)) return
  sessions.delete(session)
  activeSessions.delete(session)
  reportSessions()
  const info = sessionInfo(session)
  void rendererInvoke(info.channel, { featureSession: 'end', ...(info.radioMode ? { radioMode: info.radioMode } : {}) }).catch(() => {})
}

export const beginRecommendationSession = async(session: RecommendationSession) => {
  const existing = sessions.get(session)
  if (existing) return existing
  const info = sessionInfo(session)
  assertRecommendationEnabled(info.feature)
  const revision = getRecommendationRevision(info.feature)
  const task = rendererInvoke(info.channel, { featureSession: 'start', ...(info.radioMode ? { radioMode: info.radioMode } : {}) }).then(() => {
    if (sessions.get(session) != task) throw new Error('Recommendation session ended')
    if (!isRecommendationRequestCurrent(info.feature, revision)) {
      endRecommendationSession(session)
      throw new Error('Recommendations are disabled')
    }
    activeSessions.add(session)
    reportSessions()
  }).catch(error => {
    if (sessions.get(session) == task) endRecommendationSession(session)
    throw error
  })
  sessions.set(session, task)
  return task
}
