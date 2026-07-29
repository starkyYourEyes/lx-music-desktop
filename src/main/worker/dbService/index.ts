import path from 'path'
import {
  close,
  getDatabaseHealth,
  init,
  type DatabaseInitOptions,
  type DatabaseStartupResult,
} from './db'
import { exposeWorker } from '../utils/worker'
import { list, lyric, music_url, music_other_source, download, dislike_list } from './modules/index'


export async function initForWorker(options: DatabaseInitOptions): Promise<DatabaseStartupResult>
export async function initForWorker(dataPath: string): Promise<boolean>
export async function initForWorker(
  input: DatabaseInitOptions | string,
): Promise<DatabaseStartupResult | boolean> {
  if (typeof input != 'string') return init(input)
  const result = await init({
    dataPath: input,
    backupDir: path.join(input, 'backups'),
    previousShutdownWasClean: false,
  })
  if (result.status != 'ready') throw new Error('database_recovery_required')
  return result.existed
}

const common = {
  init: initForWorker,
  close,
  getDatabaseHealth,
}

exposeWorker(Object.assign(common, list, lyric, music_url, music_other_source, download, dislike_list))

export type workerDBSeriveTypes = typeof common
  & typeof list
  & typeof lyric
  & typeof music_url
  & typeof music_other_source
  & typeof download
  & typeof dislike_list
