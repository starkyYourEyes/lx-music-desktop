const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTs, deferred, tick } = require('./download-harness')

const harness = (options = {}) => {
  let created = 0
  const api = loadTs('src/renderer/worker/download/download.ts', {
    '@common/utils/download': { createDownload: () => { created++; return { stop: options.stop ?? (async() => {}) } } },
    './utils': {}, '@common/constants': { DOWNLOAD_STATUS: {} },
    '@common/utils/nodejs': {
      checkAndCreateDir: options.mkdir ?? (async() => true), checkPath: options.pathExists ?? (async() => false),
      getFileStats: options.stat ?? (async() => null), removeFile: async() => {},
    },
  })
  const info = { id: 'one', downloaded: 0, metadata: { url: 'https://audio.test', filePath: 'out/one.mp3', fileName: 'one.mp3' } }
  return { api, info, get created() { return created } }
}

test('pause during directory initialization prevents a late transfer from starting', async() => {
  const mkdir = deferred()
  const h = harness({ mkdir: () => mkdir.promise })
  const starting = h.api.startTask(h.info, 'out', false, () => {})
  await tick()
  await h.api.pauseTask('one')
  mkdir.resolve(true); await starting
  assert.equal(h.created, 0)
})

test('pause during existing-file check prevents a late transfer from starting', async() => {
  const stat = deferred()
  const h = harness({ stat: () => stat.promise })
  const starting = h.api.startTask(h.info, 'out', true, () => {})
  await tick()
  await h.api.pauseTask('one')
  stat.resolve(null); await starting
  assert.equal(h.created, 0)
})

test('pause propagates disk-close failure so a shutdown cannot report a successful drain', async() => {
  const h = harness({ stop: async() => { throw new Error('disk close failed') } })
  await h.api.startTask(h.info, 'out', false, () => {})
  await assert.rejects(h.api.pauseTask('one'), /disk close failed/)
})

test('pause waits for resume-reset file cleanup and prevents its delayed retry', async() => {
  const unlink = deferred()
  let unlinkCallback
  const { default: Downloader } = loadTs('src/common/utils/download/Downloader.ts', {
    fs: { promises: { unlink: () => unlink.promise }, unlink: (_path, callback) => { unlinkCallback = callback } },
    './util': { STATUS: { idle: 'idle', running: 'running', stopped: 'stopped', completed: 'completed', init: 'init', error: 'error' } },
    './request': {},
  }, { Buffer })
  const dl = new Downloader('https://audio.test', 'out', 'one.mp3')
  dl.status = 'running'
  dl.resumeLastChunk = Buffer.from('old')
  dl.__handleStop = async() => {}
  let restarts = 0
  dl.start = async() => { restarts++ }
  dl.__handleWriteData(Buffer.from('new'))
  await tick()
  let stopped = false
  const stopping = dl.stop().then(() => { stopped = true })
  await tick()
  assert.equal(stopped, false)
  unlink.resolve(); unlinkCallback?.(null)
  await stopping
  assert.equal(restarts, 0)
})

test('concurrent stops share the same pending disk close', async() => {
  const close = deferred()
  const { default: Downloader } = loadTs('src/common/utils/download/Downloader.ts', {
    './util': { STATUS: { idle: 'idle', running: 'running', stopped: 'stopped', completed: 'completed' } }, './request': {},
  })
  const dl = new Downloader('https://audio.test', 'out', 'one.mp3')
  dl.status = 'running'
  let closes = 0
  dl.__handleStop = () => { closes++; return close.promise }
  const first = dl.stop()
  let secondFinished = false
  const second = dl.stop().then(() => { secondFinished = true })
  await tick()
  assert.equal(secondFinished, false)
  close.resolve(); await Promise.all([first, second])
  assert.equal(closes, 1)
})

test('a failed disk close remains retryable on the next pause', async() => {
  const { default: Downloader } = loadTs('src/common/utils/download/Downloader.ts', {
    './util': { STATUS: { idle: 'idle', running: 'running', stopped: 'stopped', completed: 'completed', error: 'error' } }, './request': {},
  })
  const dl = new Downloader('https://audio.test', 'out', 'one.mp3')
  dl.status = 'running'
  let attempts = 0
  dl.__handleStop = async() => { if (++attempts == 1) throw new Error('close failed') }
  await assert.rejects(dl.stop(), /close failed/)
  await dl.stop()
  assert.equal(attempts, 2)
})
