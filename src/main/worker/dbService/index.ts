import {
  close,
  getDatabaseHealth,
  init,
} from './db'
import { exposeWorker } from '../utils/worker'
import { list, lyric, music_url, music_other_source, download, dislike_list, account_profile } from './modules/index'

export { init }

const common = {
  init,
  close,
  getDatabaseHealth,
}

exposeWorker(Object.assign(common, list, lyric, music_url, music_other_source, download, dislike_list, account_profile))

export type workerDBSeriveTypes = typeof common
  & typeof list
  & typeof lyric
  & typeof music_url
  & typeof music_other_source
  & typeof download
  & typeof dislike_list
  & typeof account_profile
