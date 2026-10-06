import { getFeatureMode } from '@common/performance/featurePolicy'
import { getWebContents, isRendererAlive } from '@main/modules/winMain/main'

type RecommendationFeature = 'neteaseRecommend' | 'qqRecommend' | 'kugouRecommend'
type SessionKind = 'fm' | 'guessLike' | 'brush'
const sessions = new WeakMap<Electron.WebContents, Set<string>>()
const trackedSenders = new WeakSet<Electron.WebContents>()

const assertSender = (event: Electron.IpcMainInvokeEvent) => {
  if (!isRendererAlive() || event.sender !== getWebContents() || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Untrusted recommendation request')
  }
}

export const assertRecommendationRequest = (feature: RecommendationFeature, event: Electron.IpcMainInvokeEvent, continuation?: SessionKind) => {
  assertSender(event)
  if (getFeatureMode(global.lx.appSetting, feature) != 'off') return
  if (continuation && sessions.get(event.sender)?.has(`${feature}:${continuation}`)) return
  throw new Error('Recommendations are disabled')
}

// Session markers share existing radio channels, but never invoke provider APIs.
export const handleRecommendationSession = (feature: RecommendationFeature, kind: SessionKind, event: Electron.IpcMainInvokeEvent, params: unknown) => {
  if (!params || typeof params != 'object' || !('featureSession' in params)) return false
  assertSender(event)
  const marker = params as Record<string, unknown>
  const validKind = (feature == 'neteaseRecommend' && kind == 'fm') ||
    (feature == 'qqRecommend' && (kind == 'guessLike' || kind == 'brush'))
  if (!validKind || Object.keys(marker).some(key => key != 'featureSession' && key != 'radioMode') ||
    (marker.radioMode != null && marker.radioMode != kind) ||
    (marker.featureSession != 'start' && marker.featureSession != 'end')) throw new Error('Invalid recommendation session')
  const key = `${feature}:${kind}`
  if (marker.featureSession == 'end') {
    sessions.get(event.sender)?.delete(key)
    return true
  }
  assertRecommendationRequest(feature, event)
  if (!trackedSenders.has(event.sender)) {
    trackedSenders.add(event.sender)
    const clear = () => { sessions.delete(event.sender) }
    event.sender.on('render-process-gone', clear)
    event.sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) clear()
    })
  }
  let active = sessions.get(event.sender)
  if (!active) sessions.set(event.sender, active = new Set())
  active.add(key)
  return true
}
