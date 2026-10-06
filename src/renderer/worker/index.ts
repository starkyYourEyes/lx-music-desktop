import { createMainWorker, createDownloadWorker } from './utils'


export default () => {
  return {
    main: createMainWorker(),
    // A facade only; its Worker is owned and created on first permitted use.
    download: createDownloadWorker(),
  }
}

