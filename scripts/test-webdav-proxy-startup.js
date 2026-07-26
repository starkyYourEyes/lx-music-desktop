const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const rootUrl = 'https://music.example/dav/library/'
const musicInfo = {
  meta: {
    url: rootUrl,
    path: 'song.mp3',
    ext: 'mp3',
  },
}

const loadWebDAV = createServer => {
  global.lx = {
    appSetting: {
      'webdav.url': rootUrl,
      'webdav.username': 'user',
      'webdav.password': 'password',
      'localMusic.dirs': [],
    },
  }

  return loadTsModule(path.join(__dirname, '../src/main/modules/webdav.ts'), {
    'node:http': { createServer },
    undici: { request: async() => { throw new Error('unexpected request') } },
    jschardet: { detect: () => ({}) },
    'iconv-lite': { encodingExists: () => false, decode: () => '' },
    '@common/utils/lyricUtils/kg': { decodeKrc: () => null },
    '@common/utils/common': { formatPlayTime: () => '' },
    '@common/utils/localMusicWebdav': {
      normalizeWebDAVSubDir: value => value,
      createLocalMusicWebDAVPath: () => '',
    },
    '@common/utils/localMusicSettings': {
      normalizeLocalMusicWebDAVDir: value => value,
      normalizeLocalMusicDirs: value => value,
    },
    '@common/utils/webdavUrl': require('../src/common/utils/webdavUrl'),
  })
}

const createFakeServer = ({ port, error }) => {
  const server = new EventEmitter()
  server.listen = () => {
    setImmediate(() => server.emit(error ? 'error' : 'listening', error))
  }
  server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port })
  server.close = callback => callback?.()
  return server
}

const run = async() => {
  let createCount = 0
  const concurrentWebDAV = loadWebDAV(() => {
    createCount++
    return createFakeServer({ port: 43123 })
  })
  const urls = await Promise.all([
    concurrentWebDAV.getWebDAVMusicUrl(musicInfo),
    concurrentWebDAV.getWebDAVMusicUrl(musicInfo),
  ])
  assert.strictEqual(createCount, 1, 'Concurrent startup should create one proxy server')
  assert(urls.every(url => url.startsWith('http://127.0.0.1:43123/')))

  let attempt = 0
  const retryWebDAV = loadWebDAV(() => {
    attempt++
    return createFakeServer(attempt == 1
      ? { port: 0, error: new Error('listen failed') }
      : { port: 43124 })
  })
  await assert.rejects(retryWebDAV.getWebDAVMusicUrl(musicInfo), /listen failed/)
  const retryUrl = await retryWebDAV.getWebDAVMusicUrl(musicInfo)
  assert.strictEqual(attempt, 2, 'A failed proxy startup should be retried')
  assert(retryUrl.startsWith('http://127.0.0.1:43124/'))
}

run().then(() => {
  console.log('WebDAV proxy startup tests passed')
}).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
