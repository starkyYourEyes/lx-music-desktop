import { app } from 'electron'
import { mainHandle } from '@common/mainIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { FEATURE_IDS, isPerformanceSetting, type FeatureId } from '@common/performance/featurePolicy'
import { getWebContents, isRendererAlive } from '../main'
import { getOptionalResourceStatus, initOptionalResources, prepareOptionalResource } from '@main/services/optionalResources'
import { createAppRestart } from '@main/services/appRestart'
import { quitApp } from '@main/app'

export default (flushRenderer: () => Promise<void>) => {
  initOptionalResources()
  const assertSender = (event: Electron.IpcMainInvokeEvent) => {
    if (!isRendererAlive() || event.sender !== getWebContents() || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Untrusted settings request')
    }
  }
  const restart = createAppRestart({
    flush: async() => {
      await global.lx.event_app.flush_config()
      await flushRenderer()
      if (!global.lx.storage) throw new Error('storage_coordinator_unavailable')
      await global.lx.storage.prepareRestart()
    },
    relaunch: () => { app.relaunch() },
    quit: quitApp,
  })
  mainHandle<Partial<LX.AppSetting>, LX.AppSetting>(WIN_MAIN_RENDERER_EVENT_NAME.performance_apply, async({ event, params }) => {
    assertSender(event)
    if (params == null || typeof params != 'object' || Array.isArray(params) || Object.keys(params).some(key => !isPerformanceSetting(key))) {
      throw new Error('Invalid performance settings')
    }
    await global.lx.event_app.update_config(params)
    return global.lx.appSetting
  })
  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.performance_status, async({ event }) => {
    assertSender(event)
    return getOptionalResourceStatus()
  })
  mainHandle<FeatureId, ReturnType<typeof getOptionalResourceStatus>>(WIN_MAIN_RENDERER_EVENT_NAME.performance_prepare, async({ event, params }) => {
    assertSender(event)
    if (typeof params != 'string' || !FEATURE_IDS.includes(params)) throw new Error('Invalid performance feature')
    await prepareOptionalResource(params)
    return getOptionalResourceStatus()
  })
  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.performance_restart, async({ event }) => {
    assertSender(event)
    await restart()
  })
}
