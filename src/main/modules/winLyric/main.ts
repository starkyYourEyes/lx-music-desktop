import path from 'node:path'
import { BrowserWindow } from 'electron'
import { debounce, getPlatform, isLinux, isWin } from '@common/utils'
import { initWindowSize, minHeight, minWidth } from './utils'
import { mainSend } from '@common/mainIpc'
import { encodePath } from '@common/utils/electron'
import { getFeatureMode } from '@common/performance/featurePolicy'
import { reportOptionalResourceState } from '@main/services/optionalResources'

// require('./event')
// require('./rendererEvent')

let browserWindow: Electron.BrowserWindow | null = null
let isWinBoundsUpdateing = false
let isMainWindowFullscreen = false
let isWindowReady = false

const hasDisplayDemand = () => global.lx.appSetting['desktopLyric.enable'] &&
  !(isMainWindowFullscreen && global.lx.appSetting['desktopLyric.fullscreenHide'])

const saveBoundsConfig = debounce((config: Partial<LX.AppSetting>) => {
  global.lx.event_app.update_config(config)
  if (isWinBoundsUpdateing) isWinBoundsUpdateing = false
}, 500)

const winEvent = () => {
  if (!browserWindow) return
  const win = browserWindow

  // browserWindow.on('close', () => {
  //   if (global.lx.appSetting['desktopLyric.enable'] && !global.lx.mainWindowClosed) {
  //     browserWindow = null
  //     global.lx.event_app.update_config({ 'desktopLyric.enable': false })
  //   }
  // })

  browserWindow.on('closed', () => {
    if (browserWindow !== win) return
    browserWindow = null
    isWindowReady = false
    alwaysOnTopTools.clearLoop()
    reportOptionalResourceState('desktopLyric', { loaded: false, active: false })
  })

  browserWindow.on('move', () => {
    // bounds = browserWindow.getBounds()
    // console.log('move', isWinBoundsUpdateing)
    if (isWinBoundsUpdateing) {
      const bounds = browserWindow!.getBounds()
      saveBoundsConfig({
        'desktopLyric.x': bounds.x,
        'desktopLyric.y': bounds.y,
        'desktopLyric.width': bounds.width,
        'desktopLyric.height': bounds.height,
      })
    } else if (isWin) { // Linux 不允许将窗口设置出屏幕之外，MacOS未知，故只在Windows下执行强制设置
      // 非主动调整窗口触发的窗口位置变化将重置回设置值
      browserWindow!.setBounds({
        x: global.lx.appSetting['desktopLyric.x'] ?? 0,
        y: global.lx.appSetting['desktopLyric.y'] ?? 0,
        width: global.lx.appSetting['desktopLyric.width'],
        height: global.lx.appSetting['desktopLyric.height'],
      })
    }
  })

  browserWindow.on('resize', () => {
    // bounds = browserWindow.getBounds()
    // console.log(bounds)
    isWinBoundsUpdateing = true
    const bounds = browserWindow!.getBounds()
    saveBoundsConfig({
      'desktopLyric.x': bounds.x,
      'desktopLyric.y': bounds.y,
      'desktopLyric.width': bounds.width,
      'desktopLyric.height': bounds.height,
    })
  })

  // browserWindow.on('restore', () => {
  //   browserWindow.webContents.send('restore')
  // })
  // browserWindow.on('focus', () => {
  //   browserWindow.webContents.send('focus')
  // })

  browserWindow.once('ready-to-show', () => {
    if (browserWindow !== win || win.isDestroyed()) return
    isWindowReady = true
    showWindow()
    if (global.lx.appSetting['desktopLyric.isLock']) {
      browserWindow.setIgnoreMouseEvents(true, { forward: !isLinux && global.lx.appSetting['desktopLyric.isHoverHide'] })
    }
    if (hasDisplayDemand() && global.lx.appSetting['desktopLyric.isAlwaysOnTop']) {
      alwaysOnTopTools.setAlwaysOnTop(global.lx.appSetting['desktopLyric.isAlwaysOnTopLoop'])
    } else {
      alwaysOnTopTools.clearLoop()
    }
    browserWindow.blur()
  })
}

export const createWindow = () => {
  const mode = getFeatureMode(global.lx.appSetting, 'desktopLyric')
  if (mode == 'off' || (mode == 'onDemand' && !hasDisplayDemand())) return
  if (browserWindow && !browserWindow.isDestroyed()) return
  if (!global.envParams.workAreaSize) return
  let x = global.lx.appSetting['desktopLyric.x']
  let y = global.lx.appSetting['desktopLyric.y']
  let width = global.lx.appSetting['desktopLyric.width']
  let height = global.lx.appSetting['desktopLyric.height']
  let isAlwaysOnTop = global.lx.appSetting['desktopLyric.isAlwaysOnTop']
  // let isLockScreen = global.lx.appSetting['desktopLyric.isLockScreen']
  let isShowTaskbar = global.lx.appSetting['desktopLyric.isShowTaskbar']
  // let { width: screenWidth, height: screenHeight } = global.envParams.workAreaSize
  const winSize = initWindowSize(x, y, width, height)
  global.lx.event_app.update_config({
    'desktopLyric.x': winSize.x,
    'desktopLyric.y': winSize.y,
    'desktopLyric.width': winSize.width,
    'desktopLyric.height': winSize.height,
  })

  const { shouldUseDarkColors, theme } = global.lx.theme

  /**
   * Initial window options
   */
  browserWindow = new BrowserWindow({
    height: winSize.height,
    width: winSize.width,
    x: winSize.x,
    y: winSize.y,
    minWidth,
    minHeight,
    useContentSize: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    // enableRemoteModule: false,
    // icon: join(global.__static, isWin ? 'icons/256x256.ico' : 'icons/512x512.png'),
    resizable: isWin,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    roundedCorners: false,
    show: false,
    alwaysOnTop: isAlwaysOnTop,
    skipTaskbar: !isShowTaskbar,
    webPreferences: {
      contextIsolation: false,
      webSecurity: false,
      sandbox: false,
      nodeIntegration: true,
      enableWebSQL: false,
      webgl: false,
      spellcheck: false, // 禁用拼写检查器
      backgroundThrottling: false,
    },
  })
  isWindowReady = false
  reportOptionalResourceState('desktopLyric', { loaded: true, active: false, error: undefined })

  const winURL = process.env.NODE_ENV !== 'production' ? 'http://localhost:9081/lyric.html' : `file://${path.join(encodePath(__dirname), 'lyric.html')}`
  const win = browserWindow
  void win.loadURL(winURL + `?os=${getPlatform()}&dark=${shouldUseDarkColors}&theme=${encodeURIComponent(JSON.stringify(theme))}`).catch(error => {
    if (browserWindow !== win) return
    closeWindow()
    reportOptionalResourceState('desktopLyric', { error: String(error) })
  })

  winEvent()
  // browserWindow.webContents.openDevTools()
  global.lx.event_app.desktop_lyric_window_created(browserWindow)
}
export const isExistWindow = (): boolean => !!browserWindow

export const closeWindow = () => {
  alwaysOnTopTools.clearLoop()
  if (!browserWindow) return
  browserWindow.destroy()
}

export const showWindow = () => {
  if (!browserWindow || !isWindowReady || !hasDisplayDemand() || getFeatureMode(global.lx.appSetting, 'desktopLyric') == 'off') return
  browserWindow.show()
  if (global.lx.appSetting['desktopLyric.isAlwaysOnTop']) alwaysOnTopTools.setAlwaysOnTop(global.lx.appSetting['desktopLyric.isAlwaysOnTopLoop'])
  reportOptionalResourceState('desktopLyric', { active: true })
}

export const applyDesktopLyricPolicy = (fullscreen = isMainWindowFullscreen) => {
  isMainWindowFullscreen = fullscreen
  const mode = getFeatureMode(global.lx.appSetting, 'desktopLyric')
  if (mode == 'off' || (mode == 'onDemand' && !hasDisplayDemand())) {
    closeWindow()
    return
  }
  createWindow()
  if (hasDisplayDemand()) showWindow()
  else {
    browserWindow?.hide()
    alwaysOnTopTools.clearLoop()
    reportOptionalResourceState('desktopLyric', { active: false })
  }
}

export const setResizeable = (isResizeable: boolean) => {
  if (!browserWindow) return
  browserWindow.setResizable(isResizeable)
}

export const sendEvent = <T = any>(name: string, params?: T) => {
  if (!browserWindow) return
  mainSend(browserWindow, name, params)
}

export const getBounds = (): Electron.Rectangle => {
  if (!browserWindow) throw new Error('window is not available')
  return browserWindow.getBounds()
}

export const setBounds = (bounds: Electron.Rectangle) => {
  if (!browserWindow) return
  isWinBoundsUpdateing = true
  browserWindow.setBounds(bounds)
}


export const setIgnoreMouseEvents = (ignore: boolean, options?: Electron.IgnoreMouseEventsOptions) => {
  if (!browserWindow) return
  browserWindow.setIgnoreMouseEvents(ignore, options)
}

export const setSkipTaskbar = (skip: boolean) => {
  if (!browserWindow) return
  browserWindow.setSkipTaskbar(skip)
}

export const setAlwaysOnTop = (flag: boolean, level?: 'normal' | 'floating' | 'torn-off-menu' | 'modal-panel' | 'main-menu' | 'status' | 'pop-up-menu' | 'screen-saver' | undefined, relativeLevel?: number | undefined) => {
  if (!browserWindow) return
  browserWindow.setAlwaysOnTop(flag, level, relativeLevel)
}

export const getMainFrame = (): Electron.WebFrameMain | null => {
  if (!browserWindow) return null
  return browserWindow.webContents.mainFrame
}

interface AlwaysOnTopTools {
  timeout: NodeJS.Timeout | null
  setAlwaysOnTop: (isLoop: boolean) => void
  startLoop: () => void
  clearLoop: () => void
}
export const alwaysOnTopTools: AlwaysOnTopTools = {
  timeout: null,
  setAlwaysOnTop(isLoop) {
    this.clearLoop()
    setAlwaysOnTop(global.lx.appSetting['desktopLyric.isAlwaysOnTop'], 'screen-saver')
    // console.log(isLoop)
    if (isLoop) this.startLoop()
  },
  startLoop() {
    this.clearLoop()
    this.timeout = setInterval(() => {
      if (!isExistWindow()) {
        this.clearLoop()
        return
      }
      setAlwaysOnTop(true, 'screen-saver')
    }, 500)
  },
  clearLoop() {
    if (!this.timeout) return
    clearInterval(this.timeout)
    this.timeout = null
  },
}
