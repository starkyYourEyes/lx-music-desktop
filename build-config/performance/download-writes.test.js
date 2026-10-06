const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { PassThrough, Writable } = require('node:stream')
const { EventEmitter } = require('node:events')
const { loadTs, deferred, tick, root } = require('./download-harness')

const loadJs = (file, stubs) => {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), { module, exports: module.exports, require: id => id in stubs ? stubs[id] : require(id), console, URL })
  return module.exports
}

test('worker metadata operation returns the actual metadata completion promise', async() => {
  const write = deferred()
  const common = loadTs('src/renderer/worker/download/common.ts', {
    '@common/utils/musicMeta': { setMeta: () => write.promise },
    './lrcTool': { buildLyrics: () => 'lyric' }, './utils': { saveLrc() {} },
  })
  let settled = false
  const done = Promise.resolve(common.writeMeta({ filePath: 'one.mp3' }, { lyric: '' })).then(() => { settled = true })
  await tick()
  assert.equal(settled, false)
  write.resolve(); await done
})

test('metadata dispatcher preserves mp3 and flac completion promises', async() => {
  const write = deferred()
  const api = loadJs('src/common/utils/musicMeta/index.js', { './mp3Meta': () => write.promise, './flacMeta': () => write.promise })
  assert.equal(api.setMeta('one.mp3', {}), write.promise)
  assert.equal(api.setMeta('one.flac', {}), write.promise)
  write.resolve()
})

test('mp3 metadata waits for cover download, tag write, and temporary cover removal', async() => {
  const download = deferred(); const unlink = deferred(); const calls = []
  const write = loadJs('src/common/utils/musicMeta/mp3Meta.js', {
    'node-id3': { write: () => { calls.push('tag'); return true } },
    fs: { promises: { unlink: () => { calls.push('unlink'); return unlink.promise } } },
    './downloader': () => download.promise,
  })
  let settled = false
  const done = Promise.resolve(write('one.mp3', { APIC: 'https://example.test/pic.jpg' })).then(() => { settled = true })
  await tick(); assert.equal(settled, false)
  download.resolve(true); await tick()
  assert.deepEqual(calls, ['tag', 'unlink']); assert.equal(settled, false)
  unlink.resolve(); await done
})

test('flac metadata waits for the output stream and final file replacement', async() => {
  const rename = deferred(); const calls = []
  const reader = new PassThrough()
  const writer = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  class Processor extends PassThrough { writeMeta() {} }
  const write = loadJs('src/common/utils/musicMeta/flacMeta.js', {
    fs: {
      promises: { unlink: async() => { calls.push('unlink') }, rename: () => { calls.push('rename'); return rename.promise } },
      createReadStream: () => reader, createWriteStream: () => writer,
    },
    'image-size': () => ({}), './downloader': async() => false, './flac-metadata/index': Processor,
  })
  let settled = false
  const done = Promise.resolve(write('one.flac', {})).then(() => { settled = true })
  await tick(); assert.equal(settled, false)
  reader.end(Buffer.from('audio')); await tick()
  assert.deepEqual(calls, ['unlink', 'rename']); assert.equal(settled, false)
  rename.resolve(); await done
})

test('lyric saving resolves only when the file write completes and propagates failure', async() => {
  const write = deferred()
  const api = loadTs('src/renderer/worker/download/utils.ts', {
    '@common/constants': {}, '@common/utils/common': {}, './lrcTool': { buildLyrics: () => 'lyric' },
    '@common/utils/tools': {}, fs: { promises: { writeFile: () => write.promise }, writeFile() {} },
    'iconv-lite': { encode: () => Buffer.from('lyric') },
  })
  let settled = false
  const done = api.saveLrc({ lyric: 'line' }, { filePath: 'one.lrc', format: 'utf8' }).then(() => { settled = true })
  await tick(); assert.equal(settled, false)
  write.reject(new Error('disk full'))
  await assert.rejects(done, /disk full/)
})

const coverHarness = (options = {}) => {
  const response = new PassThrough()
  response.statusCode = options.status ?? 200
  response.complete = true
  response.on('error', () => {})
  const calls = []
  const request = protocol => () => {
    calls.push(protocol)
    const req = new EventEmitter()
    req.end = () => { queueMicrotask(() => req.emit('response', response)) }
    req.setTimeout = () => req
    return req
  }
  const api = loadJs('src/common/utils/musicMeta/downloader.js', {
    http: { request: request('http') }, https: { request: request('https') },
    tunnel: {}, fs: {
      promises: { unlink: options.unlink ?? (async() => {}) },
      createWriteStream: () => new Writable({ write(_chunk, _encoding, callback) { callback() }, final: options.final ?? (callback => callback()) }),
    },
  })
  return { api, response, calls }
}

test('cover fetching uses HTTPS and waits for the file stream to finish', async() => {
  let finish
  const h = coverHarness({ final: callback => { finish = callback } })
  let settled = false
  const done = h.api('https://cover.test/cover.jpg', 'cover.jpg').then(value => { settled = true; return value })
  await tick()
  h.response.end('image'); await tick()
  assert.deepEqual(h.calls, ['https'])
  assert.equal(settled, false)
  finish(); assert.equal(await done, true)
})

test('unavailable cover completes without leaving an unresolved download', async() => {
  const h = coverHarness({ status: 404 })
  let result
  const done = h.api('https://cover.test/missing.jpg', 'cover.jpg').then(value => { result = value })
  await tick()
  assert.equal(result, false)
  await done
})

test('failed cover waits for partial-file cleanup before settling', async() => {
  const unlink = deferred()
  const h = coverHarness({ unlink: () => unlink.promise })
  let settled = false
  const done = h.api('https://cover.test/broken.jpg', 'cover.jpg').then(value => { settled = true; return value })
  await tick()
  h.response.destroy(new Error('interrupted'))
  await tick()
  assert.equal(settled, false)
  unlink.resolve()
  assert.equal(await done, false)
})
