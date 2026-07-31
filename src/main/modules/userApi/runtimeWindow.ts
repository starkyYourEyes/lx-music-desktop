import { mainSend } from '@common/mainIpc'
import { PROJECT_IDENTITY } from '@common/projectIdentity'
import { log } from '@common/utils'
import { createHash } from 'node:crypto'
import { BrowserWindow, session } from 'electron'
import fs from 'fs'
import path from 'node:path'
import USER_API_RENDERER_EVENT_NAME from './rendererEvent/name'
import { getScript } from './utils'
import { getProxy } from './main'

export interface UserApiRuntimeWindow {
  identity: LX.UserApi.UserApiRuntimeIdentity
  window: Electron.BrowserWindow
  webContentsId: number
  partition: string
  session: Electron.Session
}

export interface UserApiRuntimeWindowHooks {
  onClosed: (identity: LX.UserApi.UserApiRuntimeIdentity) => void
  onRenderProcessGone: (
    identity: LX.UserApi.UserApiRuntimeIdentity,
    details: Electron.RenderProcessGoneDetails,
  ) => void
}

export interface UserApiRuntimeWindowDependencies {
  createWindow: (options: Electron.BrowserWindowConstructorOptions) => Electron.BrowserWindow
  fromPartition: (partition: string) => Electron.Session
  readRuntimeHtml: () => Promise<string>
  getScript: (apiId: string) => Promise<string>
  getProxy: () => { host: string, port: string }
  send: <T>(runtime: UserApiRuntimeWindow, name: string, payload: T) => boolean
  logError: (message: string, reason: unknown) => void
}

export interface CreateUserApiRuntimeWindowOptions {
  apiInfo: LX.UserApi.UserApiInfo
  generation: number
  hooks: UserApiRuntimeWindowHooks
  deps?: UserApiRuntimeWindowDependencies
}

const denyEvents = [
  'will-navigate',
  'will-redirect',
  'will-attach-webview',
  'will-prevent-unload',
  'media-started-playing',
] as const

let runtimeHtml: Promise<string> | null = null
const initializedRuntimes = new WeakSet<UserApiRuntimeWindow>()
const disposedRuntimes = new WeakSet<UserApiRuntimeWindow>()
const pendingRuntimes = new Map<string, UserApiRuntimeWindow>()
const runtimeListeners = new WeakMap<UserApiRuntimeWindow, {
  closed: () => void
  renderProcessGone: (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => void
}>()

const readRuntimeHtml = async() => {
  if (runtimeHtml) return runtimeHtml
  const dir = process.env.NODE_ENV !== 'production'
    ? webpackUserApiPath
    : path.join(__dirname, 'userApi')
  const html = fs.promises.readFile(path.join(dir, 'renderer/user-api.html'), 'utf8')
  runtimeHtml = html
  void html.catch(() => {
    if (runtimeHtml == html) runtimeHtml = null
  })
  return html
}

const getPreloadUrl = () => process.env.NODE_ENV !== 'production'
  ? `${path.join(__dirname, '../dist/user-api-preload.js')}`
  : `${path.join(__dirname, 'user-api-preload.js')}`

const getDependencies = (
  dependencies?: UserApiRuntimeWindowDependencies,
): UserApiRuntimeWindowDependencies => ({
  createWindow: options => new BrowserWindow(options),
  fromPartition: partition => session.fromPartition(partition),
  readRuntimeHtml,
  getScript,
  getProxy,
  send: (runtime, name, payload) => {
    if (runtime.window.isDestroyed()) return false
    mainSend(runtime.window, name, payload)
    return true
  },
  logError: (message, reason) => log.error(message, reason),
  ...dependencies,
})

export const getRuntimePartition = (apiId: string): string => (
  `${PROJECT_IDENTITY.userApiPartition}-${createHash('sha256').update(apiId).digest('hex').slice(0, 32)}`
)

const clearSession = async(
  runtimeSession: Electron.Session,
  deps: UserApiRuntimeWindowDependencies,
) => {
  const tasks = [
    { name: 'auth cache', run: async() => runtimeSession.clearAuthCache() },
    { name: 'storage data', run: async() => runtimeSession.clearStorageData() },
    { name: 'cache', run: async() => runtimeSession.clearCache() },
  ]
  const results = await Promise.allSettled(tasks.map(async({ run }) => run()))
  for (const [index, result] of results.entries()) {
    if (result.status == 'rejected') {
      deps.logError(`clear user API ${tasks[index].name} error:`, result.reason)
    }
  }
}

const detachRuntimeListeners = (runtime: UserApiRuntimeWindow) => {
  const listeners = runtimeListeners.get(runtime)
  if (!listeners) return
  runtime.window.removeListener('closed', listeners.closed)
  runtime.window.webContents.removeListener('render-process-gone', listeners.renderProcessGone)
}

const attachRuntimeListeners = (runtime: UserApiRuntimeWindow) => {
  const listeners = runtimeListeners.get(runtime)
  if (!listeners) return
  runtime.window.on('closed', listeners.closed)
  runtime.window.webContents.on('render-process-gone', listeners.renderProcessGone)
}

export const createRuntimeWindow = async({
  apiInfo,
  generation,
  hooks,
  deps: dependencies,
}: CreateUserApiRuntimeWindowOptions): Promise<UserApiRuntimeWindow> => {
  const deps = getDependencies(dependencies)
  const partition = getRuntimePartition(apiInfo.id)
  const pendingRuntime = pendingRuntimes.get(apiInfo.id)
  if (pendingRuntime) {
    await disposeRuntimeWindow(pendingRuntime, { clearSession: false }, deps)
  }
  const runtimeSession = deps.fromPartition(partition)
  const html = await deps.readRuntimeHtml()
  const window = deps.createWindow({
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    roundedCorners: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      session: runtimeSession,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: false,
      spellcheck: false,
      autoplayPolicy: 'document-user-activation-required',
      enableWebSQL: false,
      disableDialogs: true,
      webgl: false,
      images: false,
      preload: getPreloadUrl(),
    },
  })
  const runtime: UserApiRuntimeWindow = {
    identity: { apiId: apiInfo.id, generation },
    window,
    webContentsId: window.webContents.id,
    partition,
    session: runtimeSession,
  }
  const handleClosed = () => {
    hooks.onClosed(runtime.identity)
  }
  const handleRenderProcessGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
    hooks.onRenderProcessGone(runtime.identity, details)
  }

  for (const eventName of denyEvents) {
    window.webContents.on(eventName, (event: Electron.Event) => {
      event.preventDefault()
    })
  }
  runtimeSession.setPermissionRequestHandler((_webContents, _permission, resolve) => {
    resolve(false)
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.on('closed', handleClosed)
  window.webContents.on('render-process-gone', handleRenderProcessGone)
  runtimeListeners.set(runtime, {
    closed: handleClosed,
    renderProcessGone: handleRenderProcessGone,
  })

  try {
    await window.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html))
  } catch (err) {
    detachRuntimeListeners(runtime)
    try {
      if (!window.isDestroyed()) window.destroy()
    } catch (destroyErr) {
      attachRuntimeListeners(runtime)
      pendingRuntimes.set(runtime.identity.apiId, runtime)
      deps.logError('destroy failed user API runtime after load failure:', destroyErr)
      throw err
    }
    runtimeListeners.delete(runtime)
    throw err
  }
  return runtime
}

export const initializeRuntimeWindow = async(
  runtime: UserApiRuntimeWindow,
  apiInfo: LX.UserApi.UserApiInfo,
  dependencies?: UserApiRuntimeWindowDependencies,
): Promise<boolean> => {
  if (runtime.identity.apiId != apiInfo.id) {
    throw new Error('User API runtime identity does not match initialization source')
  }
  if (initializedRuntimes.has(runtime) || disposedRuntimes.has(runtime)) return false

  initializedRuntimes.add(runtime)
  const deps = getDependencies(dependencies)
  return deps.send(runtime, USER_API_RENDERER_EVENT_NAME.initEnv, {
    identity: runtime.identity,
    apiInfo: { ...apiInfo, script: await deps.getScript(apiInfo.id) },
    proxy: deps.getProxy(),
  })
}

export const disposeRuntimeWindow = async(
  runtime: UserApiRuntimeWindow,
  { clearSession: shouldClearSession }: { clearSession: boolean },
  dependencies?: UserApiRuntimeWindowDependencies,
): Promise<void> => {
  if (disposedRuntimes.has(runtime)) return
  const deps = getDependencies(dependencies)
  detachRuntimeListeners(runtime)
  try {
    if (!runtime.window.isDestroyed()) runtime.window.destroy()
  } catch (err) {
    attachRuntimeListeners(runtime)
    throw err
  }
  disposedRuntimes.add(runtime)
  runtimeListeners.delete(runtime)
  if (pendingRuntimes.get(runtime.identity.apiId) == runtime) {
    pendingRuntimes.delete(runtime.identity.apiId)
  }
  if (shouldClearSession) await clearSession(runtime.session, deps)
}

export const clearRuntimeSession = async(
  apiId: string,
  dependencies?: UserApiRuntimeWindowDependencies,
): Promise<void> => {
  const deps = getDependencies(dependencies)
  await clearSession(deps.fromPartition(getRuntimePartition(apiId)), deps)
}
