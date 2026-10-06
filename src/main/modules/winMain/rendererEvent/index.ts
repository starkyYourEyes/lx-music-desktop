import { registerRendererEvents as common } from '@main/modules/commonRenderers/common'
import { registerRendererEvents as list } from '@main/modules/commonRenderers/list'
import { registerRendererEvents as dislike } from '@main/modules/commonRenderers/dislike'
import app, { sendConfigChange } from './app'
import hotKey from './hotKey'
import kw_decodeLyric from './kw_decodeLyric'
import tx_decodeLyric from './tx_decodeLyric'
import userApi from './userApi'
import sync from './sync'
import party from './party'
import data from './data'
import storage from './storage'
import storageState from './storageState'
import playback from './playback'
import performance from './performance'
import { createRendererShutdownBridge } from './rendererShutdown'
import music from './music'
import webdav from './webdav'
import localMusic from './localMusic'
import download from './download'
import soundEffect from './soundEffect'
import openAPI from './openAPI'
import netease from './netease'
import qqMusic from './qqMusic'
import kugouMusic from './kugouMusic'
import { getWebContents, isRendererAlive, sendEvent } from '../main'
import { mainOn } from '@common/mainIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { randomUUID } from 'node:crypto'

export * from './app'
export * from './hotKey'
export * from './userApi'
export * from './sync'
export * from './party'
export * from './process'

let isInitialized = false
export default () => {
  if (isInitialized) return
  isInitialized = true

  common(sendEvent)
  list(sendEvent)
  dislike(sendEvent)
  app()
  hotKey()
  kw_decodeLyric()
  tx_decodeLyric()
  userApi()
  sync()
  party()
  data()
  storage()
  storageState()
  playback()
  const rendererShutdown = createRendererShutdownBridge({
    registerShutdownFlusher: (name, flush) => {
      const coordinator = global.lx.storage
      if (coordinator == null) throw new Error('storage_coordinator_unavailable')
      return coordinator.registerShutdownFlusher(name, flush)
    },
    send: request => { sendEvent(WIN_MAIN_RENDERER_EVENT_NAME.storage_shutdown_flush_request, request) },
    isRendererAlive,
    createRequestId: randomUUID,
    setTimeout: (callback, timeoutMs) => globalThis.setTimeout(callback, timeoutMs),
    clearTimeout: timer => { globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>) },
  })
  mainOn<unknown>(WIN_MAIN_RENDERER_EVENT_NAME.storage_shutdown_flush_ack, ({ event, params }) => {
    if (!isRendererAlive() || event.sender !== getWebContents()) return
    rendererShutdown.acknowledge(params)
  })
  rendererShutdown.registerPlayback()
  performance(async() => {
    await rendererShutdown.flushPerformance()
    await rendererShutdown.flushPlayback()
  })
  music()
  webdav()
  localMusic()
  download()
  soundEffect()
  openAPI()
  netease()
  qqMusic()
  kugouMusic()

  global.lx.event_app.on('updated_config', (keys, setting) => {
    sendConfigChange(setting)
  })
}

