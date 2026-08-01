import { createMainWorker, createDownloadWorker } from './utils'


export default (runTempRoot?: string) => {
  return {
    main: createMainWorker(runTempRoot),
    download: createDownloadWorker(),
  }
}

