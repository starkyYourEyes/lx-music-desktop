import { APP_EVENT_NAMES } from '@common/constants'
import initRendererEvent, { sendMainWindowInitedEvent } from './rendererEvent'
import { setLrcConfig } from './config'
import { HOTKEY_DESKTOP_LYRIC } from '@common/hotKey'
import { closeWindow, applyDesktopLyricPolicy, isExistWindow } from './main'
import { isFeatureEnabled } from '@common/performance/featurePolicy'
import { registerOptionalResourcePreparation } from '@main/services/optionalResources'
// import main from './main'
// import { Event, EVENT_NAMES } from './event'

let isMainWidnowFullscreen = false

export default () => {
  registerOptionalResourcePreparation('desktopLyric', () => { applyDesktopLyricPolicy(isMainWidnowFullscreen) })
  initRendererEvent()
  // global.lx.event_app.winLyric = new Event()
  // global.app_event.winMain.

  global.lx.event_app.on('main_window_inited', () => {
    isMainWidnowFullscreen = global.lx.appSetting['common.startInFullscreen']

    if (isExistWindow()) sendMainWindowInitedEvent()
    applyDesktopLyricPolicy(isMainWidnowFullscreen)
  })
  global.lx.event_app.on('updated_config', (keys, setting) => {
    setLrcConfig(keys, setting)
    if (keys.some(key => key == 'performance.features.desktopLyric' || key == 'desktopLyric.enable' || key == 'desktopLyric.fullscreenHide')) applyDesktopLyricPolicy(isMainWidnowFullscreen)
  })
  global.lx.event_app.on('main_window_close', () => {
    closeWindow()
  })
  global.lx.event_app.on('main_window_fullscreen', (isFullscreen) => {
    isMainWidnowFullscreen = isFullscreen
    applyDesktopLyricPolicy(isMainWidnowFullscreen)
  })


  // global.lx_event.mainWindow.on(MAIN_WINDOW_EVENT_NAME.setLyricInfo, info => {
  //   if (!global.modules.lyricWindow) return
  //   mainSend(global.modules.lyricWindow, ipcWinLyricNames.set_lyric_info, info)
  // })

  global.lx.event_app.on('hot_key_down', ({ type, key }) => {
    if (!isFeatureEnabled(global.lx.appSetting, 'desktopLyric')) return
    let info = global.lx.hotKey.config.global.keys[key]
    if (!info || info.type != APP_EVENT_NAMES.winLyricName) return
    let newSetting: Partial<LX.AppSetting> = {}
    let settingKey: keyof LX.AppSetting
    switch (info.action) {
      case HOTKEY_DESKTOP_LYRIC.toggle_visible.action:
        settingKey = 'desktopLyric.enable'
        break
      case HOTKEY_DESKTOP_LYRIC.toggle_lock.action:
        settingKey = 'desktopLyric.isLock'
        break
      case HOTKEY_DESKTOP_LYRIC.toggle_always_top.action:
        settingKey = 'desktopLyric.isAlwaysOnTop'
        break
      default: return
    }
    newSetting[settingKey] = !global.lx.appSetting[settingKey]

    global.lx.event_app.update_config(newSetting)
  })
}
export * from './main'
export * from './rendererEvent'

// export {
//   EVENT_NAMES,
// }
