import {
  downloadTasksGet,
  // downloadListClear,
  downloadTasksCreate,
  downloadTasksRemove,
  downloadTasksUpdate,
} from '@renderer/utils/ipc'
import {
  downloadList,
} from './state'
import { markRaw, toRaw } from '@common/utils/vueTools'
import { getPrimaryMusicUrl as getMusicUrl, getPicUrl, getLyricInfo } from '@renderer/core/music/online'
import { appSetting } from '../setting'
import { qualityList } from '..'
import { proxyCallback } from '@renderer/worker/utils'
import { arrPush, arrUnshift, joinPath } from '@renderer/utils'
import { DOWNLOAD_STATUS } from '@common/constants'
import { proxy } from '../index'
import { buildSavePath } from './utils'
import { ensurePrimarySourceCapabilities } from '@renderer/core/music/primarySource'
import {
  acquireDownloadActivity,
  canStartDownload,
  getDownloadGeneration,
  registerDownloadController,
  reportDownloadError,
} from '@renderer/core/features/downloadRuntime'

const waitingUpdateTasks = new Map<string, LX.Download.ListItem>()
let timer: NodeJS.Timeout | null = null
let saving: Promise<void> = Promise.resolve()
const flushUpdates = async() => {
  if (timer) clearTimeout(timer)
  timer = null
  if (waitingUpdateTasks.size) {
    const tasks = Array.from(waitingUpdateTasks.values())
    waitingUpdateTasks.clear()
    saving = saving.catch(() => {}).then(async() => {
      try {
        await downloadTasksUpdate(tasks)
      } catch (error) {
        for (const task of tasks) {
          if (!waitingUpdateTasks.has(task.id)) waitingUpdateTasks.set(task.id, task)
        }
        throw error
      }
    })
  }
  await saving
}
const throttleUpdateTask = (tasks: LX.Download.ListItem[]) => {
  for (const task of tasks) waitingUpdateTasks.set(task.id, toRaw(task))
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void flushUpdates().catch(reportDownloadError)
  }, 100)
}

const runingTask = new Map<string, LX.Download.ListItem>()
interface TaskRun {
  info: LX.Download.ListItem
  release: () => void
  cancelled: boolean
  started: boolean
  start: Promise<void>
  finishing?: Promise<void>
  refreshing: Set<Promise<void>>
}
const taskRuns = new Map<string, TaskRun>()
const releaseTask = (run: TaskRun) => {
  if (taskRuns.get(run.info.id) != run) return
  taskRuns.delete(run.info.id)
  runingTask.delete(run.info.id)
  run.release()
}

// const initDownloadList = (list: LX.Download.ListItem[]) => {
//   downloadList.splice(0, downloadList.length, ...list)
// }

export const getDownloadList = async(): Promise<LX.Download.ListItem[]> => {
  if (!downloadList.length) {
    const list = await downloadTasksGet()
    for (const downloadInfo of list) {
      markRaw(downloadInfo.metadata)
      switch (downloadInfo.status) {
        case DOWNLOAD_STATUS.RUN:
        case DOWNLOAD_STATUS.WAITING:
          downloadInfo.status = DOWNLOAD_STATUS.PAUSE
          downloadInfo.statusText = window.i18n.t('download___status_paused')
        default:
          break
      }
    }
    arrPush(downloadList, list)
  }
  return downloadList
}

const addTasks = async(list: LX.Download.ListItem[]) => {
  const addMusicLocationType = appSetting['list.addMusicLocationType']

  await downloadTasksCreate(list.map(i => toRaw(i)), addMusicLocationType)

  if (addMusicLocationType === 'top') {
    arrUnshift(downloadList, list)
  } else {
    arrPush(downloadList, list)
  }
  window.app_event.downloadListUpdate()
}

const setStatusText = (downloadInfo: LX.Download.ListItem, text: string) => { // 设置状态文本
  downloadInfo.statusText = text
  throttleUpdateTask([downloadInfo])
}

const setUrl = (downloadInfo: LX.Download.ListItem, url: string) => {
  downloadInfo.metadata.url = url
  throttleUpdateTask([downloadInfo])
}

const updateFilePath = (downloadInfo: LX.Download.ListItem, filePath: string) => {
  downloadInfo.metadata.filePath = filePath
  throttleUpdateTask([downloadInfo])
}

const setProgress = (downloadInfo: LX.Download.ListItem, progress: LX.Download.ProgressInfo) => {
  downloadInfo.total = progress.total
  downloadInfo.downloaded = progress.downloaded
  downloadInfo.writeQueue = progress.writeQueue
  if (progress.progress == 100) {
    downloadInfo.speed = ''
    downloadInfo.progress = 99.99
    setStatusText(downloadInfo, window.i18n.t('download_status_write_queue', { num: progress.writeQueue }))
  } else {
    downloadInfo.speed = progress.speed
    downloadInfo.progress = progress.progress
  }
  throttleUpdateTask([downloadInfo])
}

const setStatus = (downloadInfo: LX.Download.ListItem, status: LX.Download.DownloadTaskStatus, statusText?: string) => { // 设置状态及状态文本
  if (statusText == null) {
    switch (status) {
      case DOWNLOAD_STATUS.RUN:
        statusText = window.i18n.t('download___status_running')
        break
      case DOWNLOAD_STATUS.WAITING:
        statusText = window.i18n.t('download___status_waiting')
        break
      case DOWNLOAD_STATUS.PAUSE:
        statusText = window.i18n.t('download___status_paused')
        break
      case DOWNLOAD_STATUS.ERROR:
        statusText = window.i18n.t('download___status_error')
        break
      case DOWNLOAD_STATUS.COMPLETED:
        statusText = window.i18n.t('download___status_completed')
        break
      default:
        statusText = ''
        break
    }
  }

  if (downloadInfo.statusText == statusText && downloadInfo.status == status) return

  if (status == DOWNLOAD_STATUS.COMPLETED) downloadInfo.isComplate = true
  downloadInfo.statusText = statusText
  downloadInfo.status = status
  throttleUpdateTask([downloadInfo])
}

// 修复 1.1.x版本 酷狗源歌词格式
const fixKgLyric = (lrc: string) => /\[00:\d\d:\d\d.\d+\]/.test(lrc) ? lrc.replace(/(?:\[00:(\d\d:\d\d.\d+\]))/gm, '[$1') : lrc

const getProxy = () => {
  return proxy.enable && proxy.host ? {
    host: proxy.host,
    port: parseInt(proxy.port || '80'),
  } : proxy.envProxy ? {
    host: proxy.envProxy.host,
    port: parseInt(proxy.envProxy.port || '80'),
  } : undefined
}
/**
 * 设置歌曲meta信息
 * @param downloadInfo 下载任务信息
 */
const saveMeta = async(downloadInfo: LX.Download.ListItem) => {
  if (downloadInfo.metadata.quality === 'ape') return
  const isUseOtherSource = appSetting['download.isUseOtherSource']
  const tasks: [Promise<string | null>, Promise<LX.Player.LyricInfo | null>] = [
    appSetting['download.isEmbedPic']
      ? downloadInfo.metadata.musicInfo.meta.picUrl
        ? Promise.resolve(downloadInfo.metadata.musicInfo.meta.picUrl)
        : getPicUrl({ musicInfo: downloadInfo.metadata.musicInfo, isRefresh: false, allowToggleSource: isUseOtherSource }).catch(err => {
          console.log(err)
          return null
        })
      : Promise.resolve(null),
    appSetting['download.isEmbedLyric']
      ? getLyricInfo({ musicInfo: downloadInfo.metadata.musicInfo, isRefresh: false, allowToggleSource: isUseOtherSource }).catch(err => {
        console.log(err)
        return null
      })
      : Promise.resolve(null),
  ]
  await Promise.all(tasks).then(async([imgUrl, lyrics]) => {
    const info = {
      filePath: downloadInfo.metadata.filePath,
      isEmbedLyricLx: appSetting['download.isEmbedLyricLx'],
      isEmbedLyricT: appSetting['download.isEmbedLyricT'],
      isEmbedLyricR: appSetting['download.isEmbedLyricR'],
      title: downloadInfo.metadata.musicInfo.name,
      artist: downloadInfo.metadata.musicInfo.singer?.replaceAll('、', ';'),
      album: downloadInfo.metadata.musicInfo.meta.albumName,
      APIC: imgUrl,
    }
    await window.lx.worker.download.writeMeta(info, lyrics ?? { lyric: '' }, getProxy())
  })
}

/**
 * 保存歌词文件
 * @param downloadInfo 下载任务信息
 */
const downloadLyric = async(downloadInfo: LX.Download.ListItem) => {
  if (!appSetting['download.isDownloadLrc']) return
  await getLyricInfo({
    musicInfo: downloadInfo.metadata.musicInfo,
    isRefresh: false,
    allowToggleSource: appSetting['download.isUseOtherSource'],
  }).then(async lrcs => {
    if (lrcs.lyric) {
      lrcs.lyric = fixKgLyric(lrcs.lyric)
      const info = {
        filePath: downloadInfo.metadata.filePath.substring(0, downloadInfo.metadata.filePath.lastIndexOf('.')) + '.lrc',
        format: appSetting['download.lrcFormat'],
        downloadLxlrc: appSetting['download.isDownloadLxLrc'],
        downloadTlrc: appSetting['download.isDownloadTLrc'],
        downloadRlrc: appSetting['download.isDownloadRLrc'],
      }
      await window.lx.worker.download.saveLrc(lrcs, info)
    }
  })
}

const getUrl = async(downloadInfo: LX.Download.ListItem, isRefresh: boolean = false) => {
  let toggleMusicInfo = downloadInfo.metadata.musicInfo.meta.toggleMusicInfo
  return (toggleMusicInfo ? getMusicUrl({
    musicInfo: toggleMusicInfo,
    isRefresh,
    quality: downloadInfo.metadata.quality,
    allowToggleSource: false,
  }) : Promise.reject(new Error('not found'))).catch(() => {
    return getMusicUrl({
      musicInfo: downloadInfo.metadata.musicInfo,
      isRefresh: false,
      quality: downloadInfo.metadata.quality,
      allowToggleSource: appSetting['download.isUseOtherSource'],
    })
  }).then(({ url }) => url).catch(() => '')
}
export const getDownloadUrl = getUrl
const handleRefreshUrl = (run: TaskRun) => {
  const downloadInfo = run.info
  setStatusText(downloadInfo, window.i18n.t('download_status_error_refresh_url'))
  let toggleMusicInfo = downloadInfo.metadata.musicInfo.meta.toggleMusicInfo
  const refreshing = (toggleMusicInfo ? getMusicUrl({
    musicInfo: toggleMusicInfo,
    isRefresh: true,
    quality: downloadInfo.metadata.quality,
    allowToggleSource: false,
  }) : Promise.reject(new Error('not found'))).catch(() => {
    return getMusicUrl({
      musicInfo: downloadInfo.metadata.musicInfo,
      isRefresh: true,
      quality: downloadInfo.metadata.quality,
      allowToggleSource: appSetting['download.isUseOtherSource'],
    })
  })
    .then(({ url }) => url)
    .catch(() => '')
    .then(async url => {
      if (run.cancelled || !!run.finishing || taskRuns.get(downloadInfo.id) != run) return
      setUrl(downloadInfo, url)
      await window.lx.worker.download.updateUrl(downloadInfo.id, url)
    })
    .catch(err => {
      if (!run.cancelled && !run.finishing) void finishTask(run, err.message).catch(reportDownloadError)
    })
  run.refreshing.add(refreshing)
  void refreshing.finally(() => { run.refreshing.delete(refreshing) })
}

const finishTask = async(run: TaskRun, message?: string): Promise<void> => {
  if (run.finishing) return run.finishing
  run.finishing = (async() => {
    const downloadInfo = run.info
    let writeError: Error | undefined
    let resultMessage = message
    await run.start.catch(() => {})
    await Promise.allSettled(run.refreshing)
    if (!resultMessage) {
      // A downloaded file remains owned until both independent write paths settle.
      downloadInfo.progress = 100
      downloadInfo.isComplate = true
      const results = await Promise.allSettled([saveMeta(downloadInfo), downloadLyric(downloadInfo)])
      const failed = results.find((result): result is PromiseRejectedResult => result.status == 'rejected')
      if (failed) {
        writeError = failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason))
        resultMessage = writeError.message
        reportDownloadError(failed.reason)
      }
    }
    if (run.started) await window.lx.worker.download.removeTask(downloadInfo.id)
    setStatus(downloadInfo, resultMessage ? DOWNLOAD_STATUS.ERROR : DOWNLOAD_STATUS.COMPLETED, resultMessage)
    releaseTask(run)
    void checkStartTask()
    if (writeError) throw writeError
  })()
  return run.finishing
}

const handleStartTask = async(run: TaskRun) => {
  const downloadInfo = run.info
  if (!downloadInfo.metadata.url) {
    setStatusText(downloadInfo, window.i18n.t('download_status_url_getting'))
    const url = await getUrl(downloadInfo)
    if (run.cancelled || !canStartDownload()) {
      setStatus(downloadInfo, DOWNLOAD_STATUS.PAUSE)
      releaseTask(run)
      return
    }
    if (!url) {
      throw new Error(window.i18n.t('download_status_error_url_failed'))
    }
    setUrl(downloadInfo, url)
  }
  if (run.cancelled || !canStartDownload()) {
    setStatus(downloadInfo, DOWNLOAD_STATUS.PAUSE)
    releaseTask(run)
    return
  }

  const savePath = buildSavePath(downloadInfo)
  const filePath = joinPath(savePath, downloadInfo.metadata.fileName)
  if (downloadInfo.metadata.filePath != filePath) updateFilePath(downloadInfo, filePath)

  setStatusText(downloadInfo, window.i18n.t('download_status_start'))

  run.started = true
  await window.lx.worker.download.startTask(toRaw(downloadInfo), savePath, appSetting['download.skipExistFile'], proxyCallback((event: LX.Download.DownloadTaskActions) => {
    if (run.cancelled || !!run.finishing || taskRuns.get(downloadInfo.id) != run) return
    switch (event.action) {
      case 'start':
        setStatus(downloadInfo, DOWNLOAD_STATUS.RUN)
        break
      case 'complete':
        void finishTask(run).catch(reportDownloadError)
        break
      case 'refreshUrl':
        handleRefreshUrl(run)
        break
      case 'statusText':
        setStatusText(downloadInfo, event.data)
        break
      case 'progress':
        setProgress(downloadInfo, event.data)
        break
      case 'error':
        void finishTask(run, event.data.error
          ? window.i18n.t(event.data.error) + (event.data.message ?? '')
          : event.data.message ?? window.i18n.t('download___status_error'),
        ).catch(reportDownloadError)
        break
      default:
        break
    }
  }), getProxy())
}
const startTask = async(downloadInfo: LX.Download.ListItem) => {
  if (!canStartDownload() || taskRuns.has(downloadInfo.id)) return
  const run: TaskRun = {
    info: downloadInfo,
    release: acquireDownloadActivity(),
    cancelled: false,
    started: false,
    start: Promise.resolve(),
    refreshing: new Set(),
  }
  setStatus(downloadInfo, DOWNLOAD_STATUS.RUN)
  runingTask.set(downloadInfo.id, downloadInfo)
  taskRuns.set(downloadInfo.id, run)
  run.start = handleStartTask(run)
  void run.start.catch(error => {
    if (run.cancelled) return
    reportDownloadError(error)
    void finishTask(run, error instanceof Error ? error.message : String(error)).catch(reportDownloadError)
  })
}

const getStartTask = (list: LX.Download.ListItem[]): LX.Download.ListItem | null => {
  let downloadCount = 0
  const waitList = list.filter(item => {
    if (item.status == DOWNLOAD_STATUS.WAITING) return true
    if (item.status == DOWNLOAD_STATUS.RUN) ++downloadCount
    return false
  })
  // console.log(downloadCount, waitList)
  return downloadCount < appSetting['download.maxDownloadNum'] ? waitList.shift() ?? null : null
}

const checkStartTask = async() => {
  if (!canStartDownload()) return
  if (runingTask.size >= appSetting['download.maxDownloadNum']) return
  let result = getStartTask(downloadList)
  // console.log(result)
  while (result && canStartDownload()) {
    await startTask(result)
    result = getStartTask(downloadList)
  }
}

/**
 * 过滤重复任务
 * @param list
 */
const filterTask = (list: LX.Download.ListItem[]) => {
  const set = new Set<string>()
  for (const item of downloadList) set.add(item.id)
  return list.filter(item => {
    if (set.has(item.id)) return false
    markRaw(item.metadata)
    set.add(item.id)
    return true
  })
}
/**
 * 创建下载任务
 * @param list 要下载的歌曲
 * @param quality 下载音质
 */
export const createDownloadTasks = async(list: LX.Music.MusicInfoOnline[], quality: LX.Quality, listId?: string) => {
  if (!list.length || !canStartDownload()) return
  const release = acquireDownloadActivity()
  const version = getDownloadGeneration()
  try {
    await ensurePrimarySourceCapabilities()
    if (!canStartDownload(version)) return
    const tasks = filterTask(await window.lx.worker.download.createDownloadTasks(list, quality,
      appSetting['download.fileName'], toRaw(qualityList.value), listId))
    if (!canStartDownload(version)) return
    if (tasks.length) await addTasks(tasks)
    if (!canStartDownload(version)) {
      for (const task of tasks) setStatus(task, DOWNLOAD_STATUS.PAUSE)
      return
    }
    await checkStartTask()
  } finally {
    release()
  }
}

/**
 * 开始下载任务
 * @param list
 */
export const startDownloadTasks = async(list: LX.Download.ListItem[]) => {
  if (!canStartDownload()) return
  for (const downloadInfo of list) {
    switch (downloadInfo.status) {
      case DOWNLOAD_STATUS.PAUSE:
      case DOWNLOAD_STATUS.ERROR:
        if (runingTask.size < appSetting['download.maxDownloadNum']) await startTask(downloadInfo)
        else setStatus(downloadInfo, DOWNLOAD_STATUS.WAITING)
      default:
        break
    }
  }
  void checkStartTask()
}

/**
 * 暂停下载任务
 * @param list
 */
export const pauseDownloadTasks = async(list: LX.Download.ListItem[], remove = false) => {
  const pauses: Array<Promise<void>> = []
  for (const downloadInfo of list) {
    const run = taskRuns.get(downloadInfo.id)
    if (run) {
      if (run.finishing) {
        pauses.push(run.finishing)
        continue
      }
      run.cancelled = true
      pauses.push((async() => {
        await run.start.catch(() => {})
        await Promise.allSettled(run.refreshing)
        if (run.started) {
          if (remove) await window.lx.worker.download.removeTask(downloadInfo.id)
          else await window.lx.worker.download.pauseTask(downloadInfo.id)
        }
        setStatus(downloadInfo, DOWNLOAD_STATUS.PAUSE)
        releaseTask(run)
      })())
    } else if ([DOWNLOAD_STATUS.RUN, DOWNLOAD_STATUS.WAITING, DOWNLOAD_STATUS.ERROR].some(status => status == downloadInfo.status)) {
      setStatus(downloadInfo, DOWNLOAD_STATUS.PAUSE)
    }
  }
  const results = await Promise.allSettled(pauses)
  const failed = results.find((result): result is PromiseRejectedResult => result.status == 'rejected')
  if (failed) throw failed.reason
  void checkStartTask()
}

/**
 * 移除下载任务
 * @param ids 要移除的任务Id
 */
export const removeDownloadTasks = async(ids: string[]) => {
  const idsSet = new Set<string>(ids)
  await pauseDownloadTasks(downloadList.filter(task => idsSet.has(task.id)), true)
  // Persist pause updates before deletion, so a delayed update cannot recreate a row.
  await flushUpdates()
  await downloadTasksRemove(ids)
  const newList = downloadList.filter(task => !idsSet.has(task.id))
  downloadList.splice(0, downloadList.length)
  arrPush(downloadList, newList)


  void checkStartTask()
  window.app_event.downloadListUpdate()
}

registerDownloadController({
  stopScheduling: () => {
    for (const task of downloadList) {
      if (task.status == DOWNLOAD_STATUS.WAITING) setStatus(task, DOWNLOAD_STATUS.PAUSE)
    }
    for (const run of taskRuns.values()) {
      // A pending URL is not permission to start a new transfer after this transition.
      if (!run.started) {
        run.cancelled = true
        setStatus(run.info, DOWNLOAD_STATUS.PAUSE)
      }
    }
  },
  pause: async() => { await pauseDownloadTasks([...downloadList]) },
  flush: flushUpdates,
})
