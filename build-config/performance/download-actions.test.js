const assert = require('node:assert/strict')
const test = require('node:test')
const vue = require('vue')
const { loadTs, deferred, tick } = require('./download-harness')

const STATUS = { RUN: 'run', WAITING: 'waiting', PAUSE: 'pause', ERROR: 'error', COMPLETED: 'completed' }
const task = (id, url = 'https://audio.test/file.mp3') => ({
  id, status: STATUS.PAUSE, progress: 0, downloaded: 0,
  metadata: { url, fileName: id + '.mp3', filePath: 'out/' + id + '.mp3', quality: '320k', musicInfo: { name: id, singer: 'Singer', meta: { albumName: 'Album', picUrl: 'https://audio.test/cover.jpg' } } },
})
const harness = (options = {}) => {
  const settings = vue.reactive({
    'performance.features.download': 'onDemand', 'download.maxDownloadNum': 1,
    'download.isEmbedPic': true, 'download.isEmbedLyric': true, 'download.isDownloadLrc': true,
  })
  const list = []
  const events = new Map()
  const calls = []
  let disposed = 0
  let created = 0
  let saved = []
  const utils = loadTs('src/renderer/worker/utils/index.ts')
  const manager = utils.createDownloadWorkerManager(() => {
    created++
    return {
      remote: {
        startTask: async(info, _path, _skip, callback) => { calls.push('start:' + info.id); events.set(info.id, callback); await options.start?.() },
        pauseTask: async id => { calls.push('pause:' + id); await options.pause?.() },
        removeTask: async id => { calls.push('remove:' + id) },
        updateUrl: async id => { calls.push('url:' + id) },
        writeMeta: async() => { calls.push('meta'); await options.meta?.() },
        saveLrc: async() => { calls.push('lyric'); await options.lyric?.() },
        createDownloadTasks: async music => { calls.push('create'); return music.map(item => ({ ...task(item.id), status: STATUS.WAITING })) },
      },
      dispose: () => { disposed++ },
    }
  })
  const states = []
  const runtime = loadTs('src/renderer/core/features/downloadRuntime.ts', {
    '@common/utils/vueTools': vue,
    '@common/performance/featurePolicy': { getFeatureMode: () => settings['performance.features.download'] },
    '@renderer/store/setting': { appSetting: settings },
    '@renderer/worker/utils': { downloadWorkerManager: manager },
    './runtime': { reportFeatureState: (_id, status) => { states.push(status) }, registerFeaturePreparation: () => () => {} },
  })
  const actions = loadTs('src/renderer/store/download/action.ts', {
    '@renderer/utils/ipc': {
      downloadTasksGet: async() => [], downloadTasksCreate: async() => {}, downloadTasksRemove: async() => {},
      downloadTasksUpdate: async tasks => { await options.save?.(); saved = Array.from(tasks, item => ({ id: item.id, status: item.status })) },
    },
    './state': { downloadList: list },
    '@common/utils/vueTools': vue,
    '@renderer/core/music/online': {
      getPrimaryMusicUrl: options.url ?? (async() => ({ url: 'https://audio.test/file.mp3' })),
      getPicUrl: async() => 'https://audio.test/cover.jpg', getLyricInfo: options.getLyric ?? (async() => ({ lyric: 'line' })),
    },
    '../setting': { appSetting: settings },
    '..': { qualityList: { value: {} } },
    '@renderer/worker/utils': { proxyCallback: value => value },
    '@renderer/utils': { arrPush: (target, items) => target.push(...items), arrUnshift: (target, items) => target.unshift(...items), joinPath: (...items) => items.join('/') },
    '@common/constants': { DOWNLOAD_STATUS: STATUS },
    '../index': { proxy: {} }, './utils': { buildSavePath: () => 'out' },
    '@renderer/core/music/primarySource': { ensurePrimarySourceCapabilities: async() => {} },
    '@renderer/core/features/downloadRuntime': runtime,
  }, {
    window: { lx: { worker: { download: manager.facade } }, app_event: { downloadListUpdate() {} }, i18n: { t: key => key } },
  })
  return { actions, runtime, list, settings, calls, manager, states, event: (id, action, data) => events.get(id)({ action, data }), get created() { return created }, get disposed() { return disposed }, get saved() { return saved } }
}

test('off rejects enqueue and resume, and resident prewarm does not resume paused tasks', async() => {
  const h = harness()
  h.settings['performance.features.download'] = 'off'
  await h.runtime.prepareDownloadRuntime()
  const first = task('one'); h.list.push(first)
  await h.actions.createDownloadTasks([{ id: 'new' }], '320k')
  await h.actions.startDownloadTasks([first])
  assert.equal(h.created, 0)
  assert.equal(first.status, STATUS.PAUSE)
  h.settings['performance.features.download'] = 'resident'
  await h.runtime.prepareDownloadRuntime()
  assert.equal(h.created, 1)
  assert.equal(h.calls.length, 0)
})

test('disable drains both metadata and lyric writes and preserves queued tasks paused', async() => {
  const meta = deferred(); const lyric = deferred()
  const h = harness({ meta: () => meta.promise, lyric: () => lyric.promise })
  const first = task('one'); const second = task('two'); h.list.push(first, second)
  await h.runtime.prepareDownloadRuntime()
  await h.actions.startDownloadTasks(h.list)
  await tick()
  h.settings['performance.features.download'] = 'off'
  h.event('one', 'complete')
  await tick()
  assert.equal(second.status, STATUS.PAUSE)
  assert.equal(h.disposed, 0)
  assert.equal(h.runtime.getDownloadRuntimeStatus().draining, true)
  meta.resolve(); await tick()
  assert.equal(h.disposed, 0)
  lyric.resolve(); await tick()
  assert.equal(h.disposed, 1)
  assert.equal(first.status, STATUS.COMPLETED)
  assert.equal(h.calls.includes('start:two'), false)
})

test('a URL requested before disable cannot start after re-enable', async() => {
  const url = deferred()
  const h = harness({ url: () => url.promise })
  const first = task('one', null); h.list.push(first)
  await h.runtime.prepareDownloadRuntime()
  await h.actions.startDownloadTasks([first])
  h.settings['performance.features.download'] = 'off'
  h.settings['performance.features.download'] = 'onDemand'
  url.resolve({ url: 'https://late.test/file' }); await tick()
  assert.equal(h.calls.includes('start:one'), false)
  assert.equal(first.status, STATUS.PAUSE)
  assert.equal(h.manager.getStatus().active, false)
})

test('manual pause during drain waits for initialization and pending disk writes', async() => {
  const start = deferred(); const pause = deferred()
  const h = harness({ start: () => start.promise, pause: () => pause.promise })
  const first = task('one'); h.list.push(first)
  await h.runtime.prepareDownloadRuntime()
  await h.actions.startDownloadTasks([first]); await tick()
  h.settings['performance.features.download'] = 'off'
  const pausing = h.runtime.pauseDownloadsForShutdown()
  await tick()
  assert.equal(h.calls.includes('pause:one'), false)
  start.resolve(); await tick()
  assert.equal(h.calls.includes('pause:one'), true)
  assert.equal(h.disposed, 0)
  pause.resolve(); await pausing; await tick()
  assert.equal(h.disposed, 1)
  assert.equal(first.status, STATUS.PAUSE)
  assert.deepEqual(h.saved, [{ id: 'one', status: STATUS.PAUSE }])
})

test('failure after disable does not start the next task and removal affects only selected IDs', async() => {
  const h = harness()
  const first = task('one'); const second = task('two'); h.list.push(first, second)
  await h.runtime.prepareDownloadRuntime()
  await h.actions.startDownloadTasks(h.list); await tick()
  await h.actions.removeDownloadTasks(['two'])
  assert.equal(h.calls.includes('remove:one'), false)
  h.settings['performance.features.download'] = 'off'
  h.event('one', 'error', { message: 'network error' }); await tick()
  assert.equal(first.status, STATUS.ERROR)
  assert.equal(h.disposed, 1)
})

test('re-enable during drain reuses the Worker without resuming the preserved queue', async() => {
  const meta = deferred()
  const h = harness({ meta: () => meta.promise })
  const first = task('one'); const second = task('two'); h.list.push(first, second)
  await h.runtime.prepareDownloadRuntime()
  await h.actions.startDownloadTasks(h.list); await tick()
  h.settings['performance.features.download'] = 'off'
  h.event('one', 'complete'); await tick()
  h.settings['performance.features.download'] = 'resident'
  await h.runtime.prepareDownloadRuntime()
  meta.resolve(); await tick()
  assert.equal(h.created, 1)
  assert.equal(h.disposed, 0)
  assert.equal(second.status, STATUS.PAUSE)
  assert.equal(h.calls.includes('start:two'), false)
})

test('shutdown waits for postprocessing even after a metadata error', async() => {
  const lyric = deferred()
  const h = harness({ meta: async() => { throw new Error('tag write failed') }, lyric: () => lyric.promise })
  const first = task('one'); h.list.push(first)
  await h.runtime.prepareDownloadRuntime()
  await h.actions.startDownloadTasks(h.list); await tick()
  h.event('one', 'complete'); await tick()
  let settled = false
  const pausing = h.runtime.pauseDownloadsForShutdown().finally(() => { settled = true })
  const rejected = assert.rejects(pausing, /tag write failed/)
  await tick()
  assert.equal(settled, false)
  lyric.resolve(); await rejected
  assert.equal(first.status, STATUS.ERROR)
  assert.match(h.runtime.getDownloadRuntimeStatus().error, /tag write failed/)
})

test('queue persistence failures reject shutdown and can be retried', async() => {
  let fail = true
  const h = harness({ save: async() => { if (fail) throw new Error('storage unavailable') } })
  const first = task('one'); h.list.push(first)
  await h.runtime.prepareDownloadRuntime()
  await h.actions.startDownloadTasks(h.list); await tick()
  await assert.rejects(h.runtime.pauseDownloadsForShutdown(), /storage unavailable/)
  fail = false
  await h.runtime.pauseDownloadsForShutdown()
  assert.equal(h.saved[0].status, STATUS.PAUSE)
})
