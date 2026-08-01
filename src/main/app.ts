import path from 'node:path'
import { app, shell, screen, nativeTheme } from 'electron'
import { URL_SCHEME_RXP } from '@common/constants'
import { getProxy, getTheme, initHotKey, initSetting, parseEnvParams } from './utils'
import { navigationUrlWhiteList } from '@common/config'
import defaultSetting from '@common/defaultSetting'
import { isExistWindow as isExistMainWindow, showWindow as showMainWindow } from './modules/winMain'
import { createAppEvent, createDislikeEvent, createListEvent } from '@main/event'
import { isMac } from '@common/utils'
import createWorkers from './worker'
import { migrateDBData } from './utils/migrate'
import { initializeCredentialVault } from './storage/credentials'
import { createAccountRepository } from './storage/accounts/accountRepository'
import { migrateLegacyCredentials } from './migration/credentials/credentialMigration'
import { withSelectedLegacyDataSource } from './migration/credentials/legacySources'
import { isCredentialMigrationRecoveryError } from './migration/credentials/recoveryError'
import { migrateLegacyNonActivity } from './migration/legacyData/nonActivity'
import { migrateLegacyPlaybackActivity } from './migration/legacyData/activity'
import type { LegacyDataSourceResult } from './migration/legacyData/source'
import { createAtomicJsonFile } from './storage/atomicJsonFile'
import { parseSettingsDocument, type SettingsDocumentV1 } from './storage/settings/document'
import { setProxyByHost } from '@common/utils/request'
import { getWebContentsNavigationDecision } from '@main/utils/webContentsNavigationGuard'
import { PROJECT_IDENTITY } from '@common/projectIdentity'
import type { StorageStartupOutcome } from './startup/storageCoordinator'
import {
  createPhase3AttestationCommand,
  type Phase3ActivityEvidence,
  type Phase3CredentialHealth,
  type Phase3PlaybackSmokeEvidence,
} from './startup/phase3Attestation'
import type { Phase3AttestationPrerequisitesV1 } from '../common/storage/phase3'

export const initGlobalData = () => {
  const envParams = parseEnvParams()
  // envParams.cmdParams.dt = !!envParams.cmdParams.dt

  global.envParams = {
    cmdParams: envParams.cmdParams,
    deeplink: envParams.deeplink,
  }
  global.lx = {
    inited: false,
    isSkipTrayQuit: false,
    // mainWindowClosed: true,
    event_app: createAppEvent(),
    event_list: createListEvent(),
    event_dislike: createDislikeEvent(),
    appSetting: defaultSetting,
    worker: createWorkers(),
    storage: null,
    runTemp: null,
    hotKey: {
      enable: true,
      config: {
        local: {
          enable: false,
          keys: {},
        },
        global: {
          enable: false,
          keys: {},
        },
      },
      state: new Map(),
    },
    theme: {
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      theme: {
        id: '',
        name: '',
        isDark: false,
        colors: {},
      },
    },
    player_status: {
      status: 'stoped',
      name: '',
      singer: '',
      albumName: '',
      picUrl: '',
      progress: 0,
      duration: 0,
      playbackRate: 1,
      lyricLineText: '',
      lyricLineAllText: '',
      lyric: '',
      tlyric: '',
      rlyric: '',
      lxlyric: '',
      collect: false,
      volume: 0,
      mute: false,
    },
  }

  global.staticPath =
    process.env.NODE_ENV !== 'production'
      ? webpackStaticPath
      : path.join(__dirname, 'static')
}

export const initSingleInstanceHandle = () => {
  // 单例应用程序
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    process.exit(0)
  }

  app.on('second-instance', (event, argv, cwd) => {
    if (isExistMainWindow()) {
      const envParams = parseEnvParams(argv)
      if (envParams.deeplink) {
        global.envParams.deeplink = envParams.deeplink
        global.lx.event_app.deeplink(global.envParams.deeplink)
        return
      }
      if (envParams.cmdParams.hidden !== true) {
        showMainWindow()
      }
    } else {
      app.quit()
    }
  })
}

export const applyElectronEnvParams = () => {
  // Is disable hardware acceleration
  if (global.envParams.cmdParams.dha) app.disableHardwareAcceleration()
  if (global.envParams.cmdParams.dhmkh) app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling')

  // fix linux transparent fail. https://github.com/electron/electron/issues/25153#issuecomment-843688494
  if (process.platform == 'linux') app.commandLine.appendSwitch('use-gl', 'desktop')

  // https://github.com/electron/electron/issues/22691
  app.commandLine.appendSwitch('wm-window-animations-disabled')

  app.commandLine.appendSwitch('--disable-gpu-sandbox')

  // proxy
  if (global.envParams.cmdParams['proxy-server']) {
    app.commandLine.appendSwitch('proxy-server', global.envParams.cmdParams['proxy-server'])
    app.commandLine.appendSwitch('proxy-bypass-list', global.envParams.cmdParams['proxy-bypass-list'] ?? '<local>')
  }
}

export const registerDeeplink = (startApp: () => void) => {
  if (process.env.NODE_ENV !== 'production' && process.platform === 'win32') {
    // Set the path of electron.exe and your app.
    // These two additional parameters are only available on windows.
    // console.log(process.execPath, process.argv)
    app.setAsDefaultProtocolClient(PROJECT_IDENTITY.protocolScheme, process.execPath, process.argv.slice(1))
  } else {
    app.setAsDefaultProtocolClient(PROJECT_IDENTITY.protocolScheme)
  }

  // deep link
  app.on('open-url', (event, url) => {
    if (!URL_SCHEME_RXP.test(url)) return
    event.preventDefault()
    global.envParams.deeplink = url
    if (isExistMainWindow()) {
      if (global.envParams.deeplink) global.lx.event_app.deeplink(global.envParams.deeplink)
      else showMainWindow()
    } else {
      startApp()
    }
  })
}

export const listenerAppEvent = (startApp: () => void) => {
  app.on('web-contents-created', (event, contents) => {
    contents.on('will-navigate', (event, navigationUrl) => {
      const managedNavigation = getWebContentsNavigationDecision(contents, navigationUrl)
      if (managedNavigation !== undefined) {
        if (!managedNavigation) event.preventDefault()
        return
      }
      if (process.env.NODE_ENV !== 'production') {
        console.log('navigation to url:', navigationUrl.length > 130 ? navigationUrl.substring(0, 130) + '...' : navigationUrl)
      }
      if (!navigationUrlWhiteList.some(url => url.test(navigationUrl))) {
        event.preventDefault()
        return
      }
      console.log('navigation to url:', navigationUrl)
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (!/^devtools/.test(url) && /^https?:\/\//.test(url)) {
        void shell.openExternal(url)
      }
      console.log(url)
      return { action: 'deny' }
    })
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      // Strip away preload scripts if unused or verify their location is legitimate
      delete webPreferences.preload
      // delete webPreferences.preloadURL

      // Disable Node.js integration
      webPreferences.nodeIntegration = false

      // Verify URL being loaded
      if (!navigationUrlWhiteList.some(url => url.test(params.src))) {
        event.preventDefault()
      }
    })

    // disable create dictionary
    // Disable spell-check dictionary downloads.
    contents.session.setSpellCheckerDictionaryDownloadURL('http://0.0.0.0')
  })

  app.on('activate', () => {
    if (isExistMainWindow()) {
      showMainWindow()
    } else {
      startApp()
    }
  })

  app.on('before-quit', () => {
    global.lx.isSkipTrayQuit = true
  })
  app.on('window-all-closed', () => {
    if (isMac) return

    app.quit()
  })

  const initScreenParams = () => {
    const primaryDisplay = screen.getPrimaryDisplay()
    global.envParams.workAreaSize = primaryDisplay.workAreaSize
    global.envParams.screenSize = primaryDisplay.size
  }
  app.on('ready', () => {
    screen.on('display-metrics-changed', initScreenParams)
    initScreenParams()
  })

  nativeTheme.addListener('updated', () => {
    const shouldUseDarkColors = nativeTheme.shouldUseDarkColors
    if (shouldUseDarkColors == global.lx.theme.shouldUseDarkColors) return
    global.lx.theme.shouldUseDarkColors = shouldUseDarkColors
    global.lx?.event_app.system_theme_change(shouldUseDarkColors)
  })

  const setProxy = () => {
    const proxy = getProxy()
    if (proxy) {
      setProxyByHost(proxy.host, proxy.port ? String(proxy.port) : undefined)
    } else setProxyByHost()
  }
  global.lx.event_app.on('updated_config', (keys, setting) => {
    if (keys.includes('network.proxy.enable') || (global.lx.appSetting['network.proxy.enable'] && keys.some(k => k.includes('network.proxy.')))) {
      setProxy()
    }

    if (keys.includes('player.volume')) {
      global.lx.event_app.player_status({ volume: Math.trunc(setting['player.volume']! * 100) })
    }
    if (keys.includes('player.isMute')) {
      global.lx.event_app.player_status({ mute: setting['player.isMute'] })
    }
  })
  global.lx.event_app.on('app_inited', () => {
    setProxy()
  })
}

const initTheme = () => {
  global.lx.theme = getTheme()
  const themeConfigKeys = ['theme.id', 'theme.lightId', 'theme.darkId']
  global.lx.event_app.on('updated_config', (keys) => {
    let requireUpdate = false
    for (const key of keys) {
      if (themeConfigKeys.includes(key)) {
        requireUpdate = true
        break
      }
    }
    if (requireUpdate) {
      global.lx.theme = getTheme()
      global.lx.event_app.theme_change()
    }
  })
  global.lx.event_app.on('system_theme_change', () => {
    if (global.lx.appSetting['theme.id'] == 'auto') {
      global.lx.theme = getTheme()
      global.lx.event_app.theme_change()
    }
  })
}

let isInitialized = false
type CredentialRecoveryOutcome = Extract<StorageStartupOutcome, { status: 'recovery' }>

const credentialMigrationRecovery = (
  diagnostic: string,
  affectedPath = path.join(global.lxDataPath, 'credentials.v1.json'),
): CredentialRecoveryOutcome => ({
  status: 'recovery',
  reason: 'credential_startup_check_failed',
  target: {
    kind: 'external-migration',
    component: 'credentials',
    affectedPath,
    diagnostics: [diagnostic],
  },
})

const credentialVaultReadable = (vault: Awaited<ReturnType<typeof initializeCredentialVault>>): boolean => {
  try {
    vault.read({ kind: 'netease-cookie' })
    vault.read({ kind: 'qq-music-cookie' })
    vault.read({ kind: 'webdav-basic' })
    return true
  } catch {
    return false
  }
}

export const runStorageMigrationHooks = async(
  result: { existed: boolean },
  legacyData: LegacyDataSourceResult = { status: 'absent' },
): Promise<CredentialRecoveryOutcome | undefined> => {
  if (!result.existed) await migrateDBData()
  let vault: Awaited<ReturnType<typeof initializeCredentialVault>>
  try {
    vault = await initializeCredentialVault()
    if (!credentialVaultReadable(vault)) return credentialMigrationRecovery('credentials.vault_unreadable')
    global.lx.storage?.registerShutdownFlusher('credential-vault', async() => { await vault.flush() })
  } catch {
    return credentialMigrationRecovery('credentials.vault_unreadable')
  }
  try {
    const migrateCredentials = async() => migrateLegacyCredentials({
      dataRoot: global.lxDataPath,
      vault,
      profiles: {
        migrateLegacyAccountProfiles: input => global.lx.worker.dbService.migrateLegacyAccountProfiles(input),
      },
    })
    global.lx.credentialMigration = legacyData.status == 'available'
      ? await withSelectedLegacyDataSource(legacyData.snapshot, migrateCredentials)
      : await migrateCredentials()
    if (global.lx.credentialMigration.status == 'secure-storage-unavailable' &&
      global.lx.credentialMigration.volatileEntries == 0) {
      return credentialMigrationRecovery('credentials.memory_only_entries_unavailable')
    }
  } catch (error) {
    if (isCredentialMigrationRecoveryError(error)) {
      return credentialMigrationRecovery(error.code, error.affectedPath)
    }
    return credentialMigrationRecovery('credentials.legacy_migration_failed')
  }
  try {
    const accountRepository = createAccountRepository({
      vault,
      profiles: global.lx.worker.dbService,
      profileRoot: global.lxDataPath,
    })
    await accountRepository.hydrate()
    global.lx.accountRepository = accountRepository
    global.lx.storage?.registerShutdownFlusher('account-repository', async() => { await accountRepository.flush() })
  } catch {
    return credentialMigrationRecovery('credentials.profile_repository_unreadable')
  }
  if (legacyData.status == 'absent') return undefined

  const settingsPath = path.join(global.lxDataPath, 'config_v2.json')
  const settingsFile = createAtomicJsonFile<SettingsDocumentV1>({
    filePath: settingsPath,
    validate: (value): value is SettingsDocumentV1 => {
      try {
        parseSettingsDocument(value)
        return true
      } catch {
        return false
      }
    },
  })
  const storedSettings = await settingsFile.read()
  const settingsDocument = storedSettings == null
    ? parseSettingsDocument({ version: defaultSetting.version, setting: defaultSetting })
    : parseSettingsDocument(storedSettings)
  await migrateLegacyNonActivity({
    source: legacyData.status == 'available' ? legacyData.snapshot : null,
    settingsPath,
    settingsDocument,
    settingsFile,
    repository: {
      importLegacyNonActivity: input => global.lx.worker.dbService.importLegacyNonActivity(input),
      getLocalState: () => global.lx.worker.dbService.getLocalState(),
      getPlaylistMetadata: () => global.lx.worker.dbService.getPlaylistMetadata(),
      getSearchHistory: () => global.lx.worker.dbService.getSearchHistory(),
      getNonActivityMigrationMarker: name => global.lx.worker.dbService.getNonActivityMigrationMarker(name),
      completeNonActivityMigrationMarker: input => global.lx.worker.dbService.completeNonActivityMigrationMarker(input),
    },
  })
  return undefined
}

export const runPlaybackActivityMigration = async(
  _result: { existed: boolean },
  legacyData: Exclude<LegacyDataSourceResult, { status: 'recovery' }>,
): Promise<Phase3ActivityEvidence> => {
  const vault = global.lx.credentialVault
  if (vault == null) throw new Error('Playback activity quarantine vault is unavailable')
  const result = await migrateLegacyPlaybackActivity({
    source: legacyData.status == 'available' ? legacyData.snapshot : null,
    vault,
    repository: {
      importLegacyPlaybackActivity: input => global.lx.worker.dbService.importLegacyPlaybackActivity(input),
      getPlaybackActivityMigrationMarker: () => global.lx.worker.dbService.getPlaybackActivityMigrationMarker(),
    },
  })
  return result.phase3
}

export const completePhase3StartupAttestation = async(input: {
  completedAtMs: number
  legacySourceState: Phase3ActivityEvidence['sourceState']
  credentialHealth: Phase3CredentialHealth
  activity: Phase3ActivityEvidence | null
  prerequisites: Phase3AttestationPrerequisitesV1
  smoke: Phase3PlaybackSmokeEvidence
}): Promise<void> => {
  const vault = global.lx.credentialVault
  const migration = global.lx.credentialMigration
  if (vault == null || migration == null || input.activity == null) {
    throw Object.assign(new Error('Phase 3 migration evidence is unavailable'), { code: 'phase3_attestation_inputs_invalid' })
  }
  if (migration.status == 'secure-storage-unavailable' ||
    vault.getMigrationMarker('legacy_data_v1.credentials.memory-only') != null) {
    throw Object.assign(new Error('Phase 3 credential evidence is unavailable'), { code: 'phase3_attestation_inputs_invalid' })
  }
  const credentialState = vault.getMigrationMarker('legacy_data_v1.credentials') == null
    ? 'not-applicable' as const
    : 'complete' as const
  if (migration.encryptedEntries > 0 && credentialState != 'complete') {
    throw Object.assign(new Error('Phase 3 credential marker is unavailable'), { code: 'phase3_attestation_inputs_invalid' })
  }
  if (migration.profiles > 0 && input.prerequisites.accountProfile.state != 'complete') {
    throw Object.assign(new Error('Phase 3 account profile marker is unavailable'), { code: 'phase3_attestation_inputs_invalid' })
  }
  if (input.activity.sourceState != input.legacySourceState) {
    throw Object.assign(new Error('Phase 3 legacy source state is inconsistent'), { code: 'phase3_attestation_inputs_invalid' })
  }
  if (input.legacySourceState == 'complete' &&
    (input.prerequisites.phase2.state != 'complete' || input.prerequisites.playbackActivity.state != 'complete')) {
    throw Object.assign(new Error('Phase 3 legacy marker evidence is unavailable'), { code: 'phase3_attestation_inputs_invalid' })
  }
  const command = createPhase3AttestationCommand({
    completedAtMs: input.completedAtMs,
    credential: {
      state: credentialState,
      encrypted: vault.mode == 'encrypted',
      health: input.credentialHealth,
    },
    prerequisites: input.prerequisites,
    activity: input.activity,
    smoke: input.smoke,
  })
  await global.lx.worker.dbService.completePhase3Attestation(command)
}

export const initAppSetting = async(): Promise<void> => {
  if (!global.lx.inited) {
    const config = await initHotKey()
    global.lx.hotKey.config.local = config.local
    global.lx.hotKey.config.global = config.global
    global.lx.inited = true
  }

  if (!isInitialized) {
    global.lx.appSetting = (await initSetting()).setting
    initTheme()
    if (envParams.cmdParams.dt == null) envParams.cmdParams.dt = !global.lx.appSetting['common.transparentWindow']
  }

  isInitialized ||= true
}

export const quitApp = () => {
  global.lx.isSkipTrayQuit = true
  app.quit()
}
