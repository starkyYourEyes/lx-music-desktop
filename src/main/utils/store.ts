// import { writeFileSync } from 'atomically'
import { dialog, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { log } from '@common/utils'
import { createAtomicJsonFile, type AtomicFileSystem, type AtomicJsonFile } from '../storage/atomicJsonFile'

type Stores = Record<string, Store>

const stores: Stores = {}

const isStoreRecord = (value: unknown): value is Record<string, any> => {
  return value != null && typeof value == 'object' && !Array.isArray(value)
}

const toStorePersistenceError = (error: unknown): Error => error instanceof Error
  ? error
  : new Error('Store persistence failed')


class Store {
  private readonly filePath: string
  private readonly atomicFile: AtomicJsonFile<Record<string, any>>
  private store: Record<string, any>
  private writeError: Error | null = null

  private enqueueWrite() {
    let snapshot: Record<string, any>
    try {
      snapshot = structuredClone(this.store)
    } catch (error) {
      this.writeError ??= toStorePersistenceError(error)
      return
    }
    void this.atomicFile.replace(snapshot).catch(error => {
      this.writeError ??= toStorePersistenceError(error)
    })
  }

  constructor(filePath: string, clearInvalidConfig: boolean = false, atomicFileSystem?: AtomicFileSystem) {
    this.filePath = filePath
    this.atomicFile = createAtomicJsonFile({ filePath, validate: isStoreRecord, fs: atomicFileSystem })

    let store: Record<string, any>
    if (fs.existsSync(this.filePath)) {
      if (clearInvalidConfig) {
        try {
          store = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
        } catch {
          store = {}
        }
      } else store = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    } else store = {}

    if (!isStoreRecord(store)) {
      if (clearInvalidConfig) store = {}
      else throw new Error('parse data error: ' + String(store))
    }
    this.store = store
  }

  get<Value>(key: string): Value {
    return this.store[key]
  }

  has(key: string): boolean {
    return key in this.store
  }

  set(key: string, value: any) {
    Object.defineProperty(this.store, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
    this.enqueueWrite()
  }

  override(value: Record<string, any>) {
    if (!isStoreRecord(value)) throw new Error('invalid store data')
    this.store = value
    this.enqueueWrite()
  }

  async flush(): Promise<void> {
    try {
      await this.atomicFile.flush()
    } catch (error) {
      this.writeError ??= toStorePersistenceError(error)
    }
    if (this.writeError != null) throw this.writeError
  }

  async cleanupOwnedTemps(): Promise<void> {
    await this.atomicFile.cleanupOwnedTemps()
  }
}

/**
 * 获取 Store 对象
 * @param name store 名
 * @param isIgnoredError 是否忽略错误
 * @param isShowErrorAlert=true 是否显示错误弹窗
 * @returns Store
 */
export default (name: string, isIgnoredError = true, isShowErrorAlert = true): Store => {
  if (stores[name]) return stores[name]
  let store: Store
  const storePath = path.join(global.lxDataPath, name + '.json')
  try {
    store = stores[name] = new Store(storePath, false)
  } catch (err: any) {
    const error = err as Error
    log.error(error)

    if (!isIgnoredError) throw error


    if (isShowErrorAlert) {
      dialog.showMessageBoxSync({
        type: 'error',
        message: name + ' data load error',
        detail: `The invalid ${name} file has been preserved at: ${storePath}\nYou can try to repair it manually\n\nError detail: ${error.message}`,
      })
      shell.showItemInFolder(storePath)
    }


    store = stores[name] = new Store(storePath, true)
  }
  return store
}

export const flushStores = async(): Promise<void> => {
  await Promise.all(Object.values(stores).map(async store => store.flush()))
}

export const cleanupStoreTemps = async(): Promise<void> => {
  await Promise.all(Object.values(stores).map(async store => store.cleanupOwnedTemps()))
}

export {
  Store,
}
