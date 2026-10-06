import { watch } from '@common/utils/vueTools'
import { getFeatureMode } from '@common/performance/featurePolicy'
import { appSetting } from '@renderer/store/setting'
import { downloadWorkerManager } from '@renderer/worker/utils'
import { registerFeaturePreparation, reportFeatureState } from './runtime'

interface DownloadController {
  stopScheduling: () => void
  pause: () => Promise<void>
  flush: () => Promise<void>
}

let controller: DownloadController | undefined
let initialized = false
let shuttingDown = false
let generation = 0
let lastError: string | null = null

export const getDownloadRuntimeStatus = () => {
  const state = downloadWorkerManager.getStatus()
  return { ...state, error: state.error ?? lastError }
}
const report = () => { reportFeatureState('download', getDownloadRuntimeStatus()) }

export const reportDownloadError = (error: unknown) => {
  lastError = error instanceof Error ? error.message : String(error)
  report()
}

const initialize = () => {
  if (initialized) return
  initialized = true
  downloadWorkerManager.subscribe(report)
  watch(() => getFeatureMode(appSetting, 'download'), mode => {
    if (mode == 'off') {
      ++generation
      controller?.stopScheduling()
    }
    downloadWorkerManager.setMode(shuttingDown ? 'off' : mode)
    if (mode == 'resident' && !shuttingDown) void downloadWorkerManager.prewarm().catch(reportDownloadError)
    report()
  }, { immediate: true, flush: 'sync' })
}

export const getDownloadGeneration = () => generation
export const canStartDownload = (version = generation) => !shuttingDown && version == generation && getFeatureMode(appSetting, 'download') != 'off'

export const acquireDownloadActivity = () => {
  initialize()
  if (!canStartDownload()) throw new Error('Downloads are disabled')
  lastError = null
  return downloadWorkerManager.acquire()
}

export const registerDownloadController = (value: DownloadController) => {
  controller = value
  if (!canStartDownload()) value.stopScheduling()
}

// Called after persisted settings have been applied. Prewarming never schedules a task.
export const prepareDownloadRuntime = async() => {
  initialize()
  lastError = null
  await downloadWorkerManager.prewarm()
  report()
}

export const pauseCurrentDownloads = async() => {
  await controller?.pause()
  await controller?.flush()
}

export const pauseDownloadsForShutdown = async() => {
  initialize()
  shuttingDown = true
  ++generation
  controller?.stopScheduling()
  downloadWorkerManager.setMode('off')
  try {
    await pauseCurrentDownloads()
  } catch (error) {
    reportDownloadError(error)
    throw error
  } finally {
    shuttingDown = false
    downloadWorkerManager.setMode(getFeatureMode(appSetting, 'download'))
  }
}

registerFeaturePreparation('download', prepareDownloadRuntime)
