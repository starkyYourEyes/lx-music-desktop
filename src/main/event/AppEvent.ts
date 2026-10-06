import { EventEmitter } from 'events'

import { saveAppHotKeyConfig, updateSetting, updateSettingDurable } from '@main/utils'
import { isPerformanceSetting } from '@common/performance/featurePolicy'
import type { BrowserWindow } from 'electron'

export class Event extends EventEmitter {
  private configUpdateTail: Promise<void> | null = null
  // closeAll() {
  //   this.emit(COMMON_EVENT_NAME.closeAll)
  // }
  // initSetting() {
  //   this.emit(COMMON_EVENT_NAME.initConfig)
  //   // this.configStatus(null)
  // }

  /**
   * 初始化APP
   */
  app_inited() {
    this.emit('app_inited')
  }

  /**
   * 已更新的配置
   * @param keys 已更新配置的key
   * @param setting 已更新配置
   */
  updated_config(keys: Array<keyof LX.AppSetting>, setting: Partial<LX.AppSetting>) {
    this.emit('updated_config', keys, setting)
  }

  /**
   * 更新配置
   * @param setting 新设置
   */
  // Preserve synchronous ordinary updates when no durable save is pending.
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  update_config(setting: Partial<LX.AppSetting>) {
    const durable = Object.keys(setting).some(key => isPerformanceSetting(key) || key == 'download.enable')
    if (!durable && !this.configUpdateTail) {
      this.publish_config(updateSetting(setting))
      return
    }
    const patch = { ...setting }
    const save = async() => {
      const result = durable ? await updateSettingDurable(patch) : updateSetting(patch)
      this.publish_config(result)
    }
    const operation = this.configUpdateTail ? this.configUpdateTail.then(save, save) : save()
    this.configUpdateTail = operation
    const clear = () => { if (this.configUpdateTail == operation) this.configUpdateTail = null }
    void operation.then(clear, clear)
    return operation
  }

  async flush_config(): Promise<void> {
    while (this.configUpdateTail) await this.configUpdateTail
  }

  private publish_config({ setting: newSetting, updatedSettingKeys, updatedSetting }: ReturnType<typeof updateSetting>) {
    global.lx.appSetting = newSetting
    if (!updatedSettingKeys.length) return
    this.emit('update_config', newSetting)
    // console.log(updatedSetting)
    this.updated_config(updatedSettingKeys, updatedSetting)
  }

  system_theme_change(isDark: boolean) {
    this.emit('system_theme_change', isDark)
  }

  theme_change() {
    this.emit('theme_change')
  }

  deeplink(link: string) {
    this.emit('deeplink', link)
  }

  player_status(status: Partial<LX.Player.Status>) {
    for (const [key, value] of Object.entries(status)) {
      // @ts-expect-error
      global.lx.player_status[key] = value
    }
    this.emit('player_status', status)
  }

  hot_key_down(keyInfo: LX.HotKeyDownInfo) {
    this.emit('hot_key_down', keyInfo)
  }

  hot_key_config_update(config: LX.HotKeyConfigAll) {
    saveAppHotKeyConfig(config)
    this.emit('hot_key_config_update', config)
  }

  user_api_changed() {
    this.emit('user_api_changed')
  }

  main_window_created(win: BrowserWindow) {
    this.emit('main_window_created', win)
  }

  main_window_ready_to_show() {
    this.emit('main_window_ready_to_show')
  }

  main_window_inited() {
    this.emit('main_window_inited')
  }

  main_window_show() {
    this.emit('main_window_show')
  }

  main_window_hide() {
    this.emit('main_window_hide')
  }

  main_window_focus() {
    this.emit('main_window_focus')
  }

  main_window_blur() {
    this.emit('main_window_blur')
  }

  main_window_close() {
    this.emit('main_window_close')
  }

  main_window_fullscreen(isFullscreen: boolean) {
    this.emit('main_window_fullscreen', isFullscreen)
  }

  desktop_lyric_window_created(win: BrowserWindow) {
    this.emit('desktop_lyric_window_created', win)
  }
}


type EventMethods = Omit<EventType, keyof EventEmitter>
declare class EventType extends Event {
  on<K extends keyof EventMethods>(event: K, listener: EventMethods[K]): this
  once<K extends keyof EventMethods>(event: K, listener: EventMethods[K]): this
  off<K extends keyof EventMethods>(event: K, listener: EventMethods[K]): this
}

export type Type = Omit<EventType, keyof Omit<EventEmitter, 'on' | 'off' | 'once'>>
