import { BrowserWindow, Tray, Menu, nativeImage, screen } from 'electron'
import { isMac, isWin } from '@common/utils'
import path from 'node:path'
import {
  hideWindow as hideMainWindow,
  isExistWindow as isExistMainWindow,
  isShowWindow as isShowMainWindow,
  sendTaskbarButtonClick,
  sendEvent,
  showWindow as showMainWindow,
} from './winMain'
import { quitApp } from '@main/app'
import { TRAY_AUTO_ID } from '@common/constants'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'

let tray: Electron.Tray | null
let trayMenuWindow: Electron.BrowserWindow | null
let isEnableTray: boolean = false
let themeId: number
let isShowStatusBarLyric: boolean = false

const playerState = {
  empty: false,
  collect: false,
  play: false,
  next: true,
  prev: true,
}

const watchConfigKeys = [
  'desktopLyric.enable',
  'desktopLyric.isLock',
  'desktopLyric.isAlwaysOnTop',
  'tray.themeId',
  'tray.enable',
  'player.isShowStatusBarLyric',
  'common.langId',
] satisfies Array<keyof LX.AppSetting>

const themeList = [
  {
    id: 0,
    fileName: 'trayTemplate',
    isNative: true,
  },
  {
    id: 1,
    fileName: 'tray_origin',
    isNative: false,
  },
  {
    id: 2,
    fileName: 'tray_black',
    isNative: false,
  },
]

const messages = {
  'en-us': {
    collect: 'Love',
    uncollect: 'Unlove',
    play: 'Play',
    pause: 'Pause',
    next: 'Next Song',
    prev: 'Prev Song',
    hide_win_main: 'Hide Main Window',
    show_win_main: 'Show Main Window',
    hide_win_lyric: 'Hide Lyric Window',
    show_win_lyric: 'Show Lyric Window',
    lock_win_lyric: 'Lock Lyric Window',
    unlock_win_lyric: 'Unlock Lyric Window',
    top_win_lyric: 'On-top Lyric Window',
    untop_win_lyric: 'Un-top Lyric Window',
    show_statusbar_lyric: 'Show Lyrics on Statusbar',
    hide_statusbar_lyric: 'Hide Lyrics on Statusbar',
    exit: 'Exit',
    music_name: 'Title: ',
    music_singer: 'Artist: ',
  },
  'zh-cn': {
    collect: '收藏',
    uncollect: '取消收藏',
    play: '播放',
    pause: '暂停',
    next: '下一曲',
    prev: '上一曲',
    hide_win_main: '隐藏主界面',
    show_win_main: '显示主界面',
    hide_win_lyric: '关闭桌面歌词',
    show_win_lyric: '开启桌面歌词',
    lock_win_lyric: '锁定桌面歌词',
    unlock_win_lyric: '解锁桌面歌词',
    top_win_lyric: '置顶歌词',
    untop_win_lyric: '取消置顶',
    show_statusbar_lyric: '显示状态栏歌词',
    hide_statusbar_lyric: '隐藏状态栏歌词',
    exit: '退出',
    music_name: '歌曲名: ',
    music_singer: '艺术家: ',
  },
  'zh-tw': {
    collect: '收藏',
    uncollect: '取消收藏',
    play: '播放',
    pause: '暫停',
    next: '下一曲',
    prev: '上一曲',
    hide_win_main: '隱藏軟體視窗',
    show_win_main: '顯示軟體視窗',
    hide_win_lyric: '關閉歌詞視窗',
    show_win_lyric: '開啟歌詞視窗',
    lock_win_lyric: '鎖定歌詞視窗',
    unlock_win_lyric: '解鎖歌詞視窗',
    top_win_lyric: '置頂歌詞視窗',
    untop_win_lyric: '取消置頂歌詞視窗',
    show_statusbar_lyric: '顯示狀態列歌詞',
    hide_statusbar_lyric: '隱藏狀態列歌詞',
    exit: '退出',
    music_name: '標題: ',
    music_singer: '演出者: ',
  },
} as const
type Messages = typeof messages
type Langs = keyof Messages
const i18n = {
  message: messages['zh-cn'] as Messages[Langs],
  fallbackLocale: 'en-us' as 'en-us',
  getMessage(key: keyof Messages[Langs]) {
    return this.message[key]
  },
  setLang(lang?: Langs | null) {
    this.message = lang
      ? messages[lang] ?? messages[this.fallbackLocale]
      : messages[this.fallbackLocale]
  },
}

type TrayMenuAction =
  | 'prev'
  | 'play-toggle'
  | 'next'
  | 'collect-toggle'
  | 'volume'
  | 'mute-toggle'
  | 'toggle-desktop-lyric'
  | 'settings'
  | 'quit'

const trayMenuWindowSize = {
  width: 190,
  height: 275,
}

const getIconPath = (id: number) => {
  let theme = id == TRAY_AUTO_ID
    ? global.lx.theme.shouldUseDarkColors
      ? themeList[0] : themeList[2]
    : themeList.find(item => item.id === id) ?? themeList[0]
  return path.join(global.staticPath, 'images/tray', theme.fileName + (isWin ? '.ico' : '.png'))
}

export const createTray = () => {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  if ((tray && !tray.isDestroyed()) || !global.lx.appSetting['tray.enable']) return

  // 托盘
  tray = new Tray(nativeImage.createFromPath(getIconPath(global.lx.appSetting['tray.themeId'])))

  // tray.setToolTip('LX Music')
  // createMenu()
  tray.setIgnoreDoubleClickEvents(true)
  if (isWin) {
    tray.on('click', () => {
      showMainWindow()
    })
    tray.on('right-click', () => {
      showTrayMenuWindow()
    })
  }
}

export const destroyTray = () => {
  destroyTrayMenuWindow()
  if (!tray) return
  tray.destroy()
  isEnableTray = false
  isShowStatusBarLyric = false
  tray = null
}

const handleUpdateConfig = (setting: Partial<LX.AppSetting>) => {
  global.lx.event_app.update_config(setting)
}

const closeTrayMenuWindow = () => {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return
  trayMenuWindow.hide()
}

const destroyTrayMenuWindow = () => {
  if (!trayMenuWindow) return
  if (!trayMenuWindow.isDestroyed()) trayMenuWindow.destroy()
  trayMenuWindow = null
}

const escapeHtml = (value: string) => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const getTrayMenuTitle = () => {
  const name = global.lx.player_status.name?.trim()
  if (!name) return 'LX Music'
  return name.length > 18 ? `${name.substring(0, 18)} ...` : name
}

const normalizeTrayVolume = (volume: number) => {
  if (!Number.isFinite(volume)) return 100
  if (volume <= 1) return Math.trunc(volume * 100)
  return Math.trunc(volume)
}

const refreshTrayMenuWindow = () => {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed() || !trayMenuWindow.isVisible()) return
  void trayMenuWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getTrayMenuHtml())}`)
}

const getTrayMenuHtml = () => {
  const isDesktopLyricEnabled = global.lx.appSetting['desktopLyric.enable']
  const title = escapeHtml(getTrayMenuTitle())
  const sourceVolume = global.lx.player_status.volume || global.lx.appSetting['player.volume']
  const volume = Math.max(0, Math.min(100, normalizeTrayVolume(sourceVolume)))
  const isMute = global.lx.player_status.mute || volume == 0
  const playIcon = playerState.play
    ? '<path d="M9 7h4v18H9zM19 7h4v18h-4z"/>'
    : '<path d="M10 7.5v17l14-8.5z"/>'
  const loveIcon = playerState.collect
    ? '<path d="M16 27s-9-5.6-11.6-11.3C2.5 11.6 4.9 8 9 8c2.5 0 4.2 1.3 5 3 0.8-1.7 2.5-3 5-3 4.1 0 6.5 3.6 4.6 7.7C21 21.4 16 27 16 27z"/>'
    : '<path d="M16 27s-9-5.6-11.6-11.3C2.5 11.6 4.9 8 9 8c2.5 0 4.2 1.3 5 3 0.8-1.7 2.5-3 5-3 4.1 0 6.5 3.6 4.6 7.7C21 21.4 16 27 16 27z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
  const lyricLabel = isDesktopLyricEnabled ? '关闭桌面歌词' : '打开桌面歌词'
  const volumeIcon = isMute
    ? '<path d="M6 13h5l7-6v18l-7-6H6zM23.4 12.2l1.4 1.4-2.4 2.4 2.4 2.4-1.4 1.4-2.4-2.4-2.4 2.4-1.4-1.4 2.4-2.4-2.4-2.4 1.4-1.4 2.4 2.4z" fill="currentColor"/>'
    : '<path d="M6 13h5l7-6v18l-7-6H6zm16.5-2.4a7.5 7.5 0 0 1 0 10.8l-1.4-1.4a5.5 5.5 0 0 0 0-8.2zm2.9-2.9a11.5 11.5 0 0 1 0 16.6L24 22.9a9.5 9.5 0 0 0 0-13.8z" fill="currentColor"/>'

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent;font-family:"Microsoft YaHei UI","Microsoft YaHei",Segoe UI,sans-serif;color:#73788c}
body{padding:0}
.menu{width:190px;height:275px;border:1px solid rgba(123,128,148,.16);border-radius:7px;background:rgba(255,255,255,.98);box-shadow:0 10px 24px rgba(24,31,43,.16);overflow:hidden}
.title{height:42px;padding:0 15px;display:flex;align-items:center;gap:9px;border-bottom:1px solid #edf0f5;font-size:13px;color:#6d7289;white-space:nowrap}
.title svg{width:17px;height:17px;flex:none;color:#6b7286}.title span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.controls{height:56px;padding:0 12px;display:grid;grid-template-columns:repeat(4,1fr);align-items:center;border-bottom:1px solid #edf0f5}
button{border:0;background:transparent;margin:0;padding:0;color:#6e7588;font:inherit;cursor:pointer;outline:none}
button:hover{color:#3f4657;background:#f6f7fa}.ctrl{width:40px;height:40px;border-radius:7px;display:flex;align-items:center;justify-content:center}.ctrl svg{width:25px;height:25px;fill:currentColor}
.volume-row{height:44px;padding:0 15px;display:flex;align-items:center;gap:11px;border-bottom:1px solid #edf0f5;position:relative}
.volume-btn{width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex:none}.volume-btn svg{width:18px;height:18px}
.volume-slider{flex:auto;min-width:0;height:4px;appearance:none;background:linear-gradient(to right,#6f7b91 0%,#6f7b91 ${volume}%,#e5e8ef ${volume}%,#e5e8ef 100%);border-radius:999px;outline:none}
.volume-slider::-webkit-slider-thumb{appearance:none;width:12px;height:12px;border:2px solid #fff;border-radius:50%;background:#6f7b91;box-shadow:0 1px 5px rgba(36,44,59,.28);cursor:pointer}
.volume-slider::-webkit-slider-runnable-track{height:4px;border-radius:999px}
.volume-tip{position:absolute;right:14px;top:-18px;min-width:34px;height:20px;padding:0 7px;border-radius:6px;background:rgba(58,66,82,.94);box-shadow:0 4px 12px rgba(24,31,43,.2);color:#fff;font-size:12px;line-height:20px;text-align:center;pointer-events:none;opacity:0;transform:translateY(3px);transition:opacity .12s ease,transform .12s ease}.volume-row:hover .volume-tip{opacity:1;transform:translateY(0)}
.row{height:44px;padding:0 15px;display:flex;align-items:center;gap:9px;border-bottom:1px solid #edf0f5;font-size:13px;text-align:left;width:100%}.row svg{width:17px;height:17px;flex:none;color:#737b91}.row span{flex:auto;text-align:left}.row .arrow{width:13px;height:13px;margin-left:auto}
.row.exit{border-bottom:0}.separator{height:0}
</style>
</head>
<body>
<div class="menu">
  <div class="title">
    <svg viewBox="0 0 32 32"><path d="M22 4v16.2a4.4 4.4 0 1 1-2-3.7V9.2l-10 2.1v12.9a4.4 4.4 0 1 1-2-3.7V8.6L22 5.6z" fill="currentColor"/></svg>
    <span>${title}</span>
  </div>
  <div class="controls">
    <button class="ctrl" data-action="collect-toggle" title="${playerState.collect ? '取消收藏' : '收藏'}"><svg viewBox="0 0 32 32">${loveIcon}</svg></button>
    <button class="ctrl" data-action="prev" title="上一曲"><svg viewBox="0 0 32 32"><path d="M8 7h3v18H8zM12 16l14 9V7z"/></svg></button>
    <button class="ctrl" data-action="play-toggle" title="${playerState.play ? '暂停' : '播放'}"><svg viewBox="0 0 32 32">${playIcon}</svg></button>
    <button class="ctrl" data-action="next" title="下一曲"><svg viewBox="0 0 32 32"><path d="M21 7h3v18h-3zM6 25l14-9L6 7z"/></svg></button>
  </div>
  <div class="volume-row">
    <button class="volume-btn" data-action="mute-toggle" title="${isMute ? '取消静音' : '静音'}"><svg viewBox="0 0 32 32">${volumeIcon}</svg></button>
    <input class="volume-slider" data-volume-slider type="range" min="0" max="100" step="1" value="${volume}" aria-label="volume">
    <span class="volume-tip" data-volume-tip>${volume}%</span>
  </div>
  <button class="row" data-action="toggle-desktop-lyric"><svg viewBox="0 0 32 32"><path d="M8 6h16v3H8zm0 8h16v2H8zm0 6h9v2H8zm14-2h2v5h4v2h-6zM4 5h2v22H4zm4 20h10v2H8z" fill="currentColor"/></svg><span>${lyricLabel}</span></button>
  <button class="row" data-action="settings"><svg viewBox="0 0 32 32"><path d="M16 5l9 5v12l-9 5-9-5V10zm0 3.2L10 11.5v9l6 3.3 6-3.3v-9zm0 5.3a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z" fill="currentColor"/></svg><span>设置</span></button>
  <button class="row exit" data-action="quit"><svg viewBox="0 0 32 32"><path d="M15 5h2v10h-2zM10.2 8.9A9 9 0 1 0 21.8 9.1l-1.3 1.5A7 7 0 1 1 11.5 10.4z" fill="currentColor"/></svg><span>退出</span></button>
</div>
<script>
const { ipcRenderer } = require('electron')
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]')
  if (!button) return
  ipcRenderer.send('tray-menu-action', button.dataset.action)
})
const volumeSlider = document.querySelector('[data-volume-slider]')
const volumeTip = document.querySelector('[data-volume-tip]')
if (volumeSlider) {
  volumeSlider.addEventListener('input', event => {
    const value = Number(event.target.value)
    event.target.style.background = 'linear-gradient(to right,#6f7b91 0%,#6f7b91 ' + value + '%,#e5e8ef ' + value + '%,#e5e8ef 100%)'
    if (volumeTip) volumeTip.textContent = Math.round(value) + '%'
    ipcRenderer.send('tray-menu-action', 'volume', value / 100)
  })
}
</script>
</body>
</html>`
}

const getTrayMenuBounds = () => {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const workArea = display.workArea
  let x = cursor.x + 8
  let y = cursor.y - trayMenuWindowSize.height - 8

  x = Math.min(Math.max(x, workArea.x + 4), workArea.x + workArea.width - trayMenuWindowSize.width - 4)
  y = Math.min(Math.max(y, workArea.y + 4), workArea.y + workArea.height - trayMenuWindowSize.height - 4)
  return {
    ...trayMenuWindowSize,
    x: Math.round(x),
    y: Math.round(y),
  }
}

const keepTrayMenuOpenActions = new Set<TrayMenuAction>([
  'prev',
  'play-toggle',
  'next',
  'collect-toggle',
  'volume',
  'mute-toggle',
])

const handleTrayMenuAction = (action: TrayMenuAction, data?: unknown) => {
  if (!keepTrayMenuOpenActions.has(action)) closeTrayMenuWindow()
  switch (action) {
    case 'prev':
      sendTaskbarButtonClick('prev')
      break
    case 'play-toggle':
      sendTaskbarButtonClick(playerState.play ? 'pause' : 'play')
      break
    case 'next':
      sendTaskbarButtonClick('next')
      break
    case 'collect-toggle':
      sendTaskbarButtonClick(playerState.collect ? 'unCollect' : 'collect')
      break
    case 'volume': {
      let volume = data as number
      if (!Number.isFinite(volume)) return
      if (volume < 0) volume = 0
      else if (volume > 1) volume = 1
      global.lx.player_status.volume = Math.trunc(volume * 100)
      sendTaskbarButtonClick('volume', volume)
      break
    }
    case 'mute-toggle':
      global.lx.player_status.mute = !global.lx.player_status.mute
      sendTaskbarButtonClick('mute', global.lx.player_status.mute)
      refreshTrayMenuWindow()
      break
    case 'toggle-desktop-lyric':
      handleUpdateConfig({ 'desktopLyric.enable': !global.lx.appSetting['desktopLyric.enable'] })
      break
    case 'settings':
      showMainWindow()
      sendEvent(WIN_MAIN_RENDERER_EVENT_NAME.tray_menu_navigate, { path: '/setting' })
      break
    case 'quit':
      quitApp()
      break
  }
}

const createTrayMenuWindow = () => {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) return trayMenuWindow

  trayMenuWindow = new BrowserWindow({
    ...trayMenuWindowSize,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  })
  trayMenuWindow.setMenu(null)
  trayMenuWindow.on('blur', closeTrayMenuWindow)
  trayMenuWindow.on('closed', () => {
    trayMenuWindow = null
  })
  trayMenuWindow.webContents.on('ipc-message', (event, channel, action: TrayMenuAction, data?: unknown) => {
    if (channel != 'tray-menu-action') return
    handleTrayMenuAction(action, data)
  })
  return trayMenuWindow
}

const showTrayMenuWindow = () => {
  if (!tray) return
  const win = createTrayMenuWindow()
  win.setBounds(getTrayMenuBounds())
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getTrayMenuHtml())}`).then(() => {
    if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return
    trayMenuWindow.show()
    trayMenuWindow.focus()
  })
}

const createPlayerMenu = () => {
  let menu: Electron.MenuItemConstructorOptions[] = []
  menu.push(playerState.play ? {
    label: i18n.getMessage('pause'),
    click() {
      sendTaskbarButtonClick('pause')
    },
  } : {
    label: i18n.getMessage('play'),
    click() {
      sendTaskbarButtonClick('play')
    },
  })
  menu.push({
    label: i18n.getMessage('prev'),
    click() {
      sendTaskbarButtonClick('prev')
    },
  })
  menu.push({
    label: i18n.getMessage('next'),
    click() {
      sendTaskbarButtonClick('next')
    },
  })
  menu.push(playerState.collect ? {
    label: i18n.getMessage('uncollect'),
    click() {
      sendTaskbarButtonClick('unCollect')
    },
  } : {
    label: i18n.getMessage('collect'),
    click() {
      sendTaskbarButtonClick('collect')
    },
  })
  return menu
}

export const createMenu = () => {
  if (!tray) return
  if (isWin) {
    tray.setContextMenu(null)
    return
  }
  let menu: Electron.MenuItemConstructorOptions[] = createPlayerMenu()
  if (playerState.empty) for (const m of menu) m.enabled = false
  menu.push({ type: 'separator' })
  menu.push(global.lx.appSetting['desktopLyric.enable']
    ? {
        label: i18n.getMessage('hide_win_lyric'),
        click() {
          handleUpdateConfig({ 'desktopLyric.enable': false })
        },
      }
    : {
        label: i18n.getMessage('show_win_lyric'),
        click() {
          handleUpdateConfig({ 'desktopLyric.enable': true })
        },
      })
  menu.push(global.lx.appSetting['desktopLyric.isLock']
    ? {
        label: i18n.getMessage('unlock_win_lyric'),
        click() {
          handleUpdateConfig({ 'desktopLyric.isLock': false })
        },
      }
    : {
        label: i18n.getMessage('lock_win_lyric'),
        click() {
          handleUpdateConfig({ 'desktopLyric.isLock': true })
        },
      })
  menu.push(global.lx.appSetting['desktopLyric.isAlwaysOnTop']
    ? {
        label: i18n.getMessage('untop_win_lyric'),
        click() {
          handleUpdateConfig({ 'desktopLyric.isAlwaysOnTop': false })
        },
      }
    : {
        label: i18n.getMessage('top_win_lyric'),
        click() {
          handleUpdateConfig({ 'desktopLyric.isAlwaysOnTop': true })
        },
      })
  if (isMac) {
    menu.push({ type: 'separator' })
    menu.push(isShowStatusBarLyric
      ? {
          label: i18n.getMessage('hide_statusbar_lyric'),
          click() {
            handleUpdateConfig({ 'player.isShowStatusBarLyric': false })
          },
        }
      : {
          label: i18n.getMessage('show_statusbar_lyric'),
          click() {
            handleUpdateConfig({ 'player.isShowStatusBarLyric': true })
          },
        })
  }
  menu.push({ type: 'separator' })
  if (isExistMainWindow()) {
    const isShow = isShowMainWindow()
    menu.push(isShow
      ? {
          label: i18n.getMessage('hide_win_main'),
          click() {
            hideMainWindow()
          },
        }
      : {
          label: i18n.getMessage('show_win_main'),
          click() {
            showMainWindow()
          },
        })
  }
  menu.push({
    label: i18n.getMessage('exit'),
    click() {
      quitApp()
    },
  })
  const contextMenu = Menu.buildFromTemplate(menu)
  tray.setContextMenu(contextMenu)
}

export const setTrayImage = (themeId: number) => {
  if (!tray) return
  tray.setImage(nativeImage.createFromPath(getIconPath(themeId)))
}

const setLyric = (lyricLineText?: string) => {
  if (isShowStatusBarLyric && tray && lyricLineText != null) {
    tray.setTitle(lyricLineText)
  }
}

const defaultTip = 'LX Music'
const setTip = () => {
  if (!tray) return

  let name = global.lx.player_status.name
  let tip: string
  if (name) {
    if (name.length > 20) name = name.substring(0, 20) + '...'
    let singer = global.lx.player_status.singer
    if (singer?.length > 20) singer = singer.substring(0, 20) + '...'

    tip = `${defaultTip}\n${i18n.getMessage('music_name')}${name}${singer ? `\n${i18n.getMessage('music_singer')}${singer}` : ''}`
  } else tip = defaultTip
  tray.setToolTip(tip)
}

const init = () => {
  if (themeId != global.lx.appSetting['tray.themeId']) {
    themeId = global.lx.appSetting['tray.themeId']
    setTrayImage(themeId)
  }
  if (isEnableTray !== global.lx.appSetting['tray.enable']) {
    isEnableTray = global.lx.appSetting['tray.enable']
    global.lx.appSetting['tray.enable'] ? createTray() : destroyTray()
  }
  if (isShowStatusBarLyric !== global.lx.appSetting['player.isShowStatusBarLyric']) {
    isShowStatusBarLyric = global.lx.appSetting['player.isShowStatusBarLyric']
    if (isShowStatusBarLyric) {
      setLyric(global.lx.player_status.lyricLineText)
    } else {
      tray?.setTitle('')
    }
  }
  setTip()
  createMenu()
}

export default () => {
  global.lx.event_app.on('updated_config', (keys, setting) => {
    if (!watchConfigKeys.some(key => keys.includes(key))) return

    if (keys.includes('common.langId')) i18n.setLang(setting['common.langId'])

    init()
  })

  global.lx.event_app.on('main_window_ready_to_show', () => {
    createMenu()
  })
  global.lx.event_app.on('main_window_show', () => {
    createMenu()
  })
  if (!isWin) {
    global.lx.event_app.on('main_window_focus', () => {
      createMenu()
    })
    global.lx.event_app.on('main_window_blur', () => {
      createMenu()
    })
  }
  global.lx.event_app.on('main_window_hide', () => {
    createMenu()
  })
  global.lx.event_app.on('main_window_close', () => {
    destroyTray()
  })

  global.lx.event_app.on('app_inited', () => {
    i18n.setLang(global.lx.appSetting['common.langId'])
    init()
  })

  global.lx.event_app.on('system_theme_change', () => {
    if (global.lx.appSetting['tray.themeId'] != TRAY_AUTO_ID) return
    setTrayImage(global.lx.appSetting['tray.themeId'])
  })

  global.lx.event_app.on('player_status', (status) => {
    let updated = false
    if (status.status) {
      switch (status.status) {
        case 'paused':
          playerState.play = false
          playerState.empty &&= false
          setLyric('')
          break
        case 'error':
          playerState.play = false
          playerState.empty &&= false
          setLyric('')
          break
        case 'playing':
          playerState.play = true
          playerState.empty &&= false
          setLyric(global.lx.player_status.lyricLineText)
          break
        case 'stoped':
          playerState.play &&= false
          playerState.empty = true
          setLyric('')
          break
      }
      updated = true
    } else {
      setLyric(status.lyricLineText)
    }
    if (status.name != null) setTip()
    if (status.singer != null) setTip()
    if (status.collect != null) {
      playerState.collect = status.collect
      updated = true
    }
    if (updated) {
      init()
      refreshTrayMenuWindow()
    } else if (status.name != null || status.singer != null || status.mute != null) {
      refreshTrayMenuWindow()
    }
  })
}
