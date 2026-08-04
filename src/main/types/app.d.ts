/* eslint-disable no-var */
// import { Event as WinMainEvent } from '@main/modules/winMain/event'
// import { Event as WinLyricEvent } from '@main/modules/winLyric/event'
import { type DislikeType, type AppType, type ListType } from '@main/event'
import { type DBSeriveTypes } from '@main/worker/utils'
import { type StorageCoordinator } from '@main/startup/storageCoordinator'
import { type CredentialVault } from '@main/storage/credentials/credentialVault'
import { type CredentialMigrationResult } from '@main/migration/credentials/credentialMigration'
import { type AccountRepository } from '@main/storage/accounts/accountRepository'
import { type StoragePaths } from '@main/utils/storagePaths'
import { type PortableProfileStartupToken } from '@main/migration/portableProfile'
import { type RunTempHandle } from '@main/utils/tempLifecycle'
import { type RunTempReservation } from '@main/utils/tempLifecycle'
import { type ThemeAssetManager } from '@main/services/themeAssetManager'
import { type SessionRegistry } from '@main/services/sessionRegistry'
import { type CacheManager } from '@main/services/cacheManager'
import { type MusicUrlAuthorizationService } from '@main/services/musicUrlAuthorization'

interface Lx {
  inited: boolean
  appSetting: LX.AppSetting
  hotKey: {
    enable: boolean
    config: LX.HotKeyConfigAll
    state: LX.HotKeyState
  }
  /**
   * 是否跳过托盘退出
   */
  isSkipTrayQuit: boolean
  /**
   * main window 是否关闭
   */
  // mainWindowClosed: boolean
  event_app: AppType
  event_list: ListType
  event_dislike: DislikeType
  worker: {
    dbService: DBSeriveTypes
  }
  sessionRegistry: SessionRegistry
  cacheManager?: CacheManager
  storage: StorageCoordinator | null
  runTemp: RunTempHandle | null
  themeAssets: ThemeAssetManager | null
  credentialVault?: CredentialVault
  credentialMigration?: CredentialMigrationResult
  accountRepository?: AccountRepository
  musicUrlAuthorization?: MusicUrlAuthorizationService
  theme: LX.ThemeSetting
  player_status: LX.Player.Status
}

declare global {
  // declare module NodeJS {
  //   export interface Global {
  //     lx: {
  //       app_event: {
  //         winMain: WinMainEvent
  //         winLyric: WinLyricEvent
  //       }
  //     }
  //   }
  // }

  // var isDev: boolean
  var envParams: LX.EnvParams
  var staticPath: string
  var lxDataPath: string
  var lxOldDataPath: string
  var storagePaths: Readonly<StoragePaths>
  var runTempReservation: RunTempReservation | null
  var portableProfileStartup: { token: PortableProfileStartupToken } | null
  var lx: Lx
  var appWorder: AppWorder
}


