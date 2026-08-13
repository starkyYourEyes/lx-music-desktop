const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describe, it } = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')
const {
  createAdapterHarness,
  observePlaybackCachePersistence,
} = require('../test-utils/playback-fallback-harness')

const root = path.resolve(__dirname, '../..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const readTree = directory => fs.readdirSync(path.join(root, directory), { withFileTypes: true })
  .flatMap(entry => {
    const relative = path.join(directory, entry.name)
    if (entry.isDirectory()) return readTree(relative)
    return /\.(?:ts|js|vue|sql)$/.test(entry.name) ? [{ file: relative, text: read(relative) }] : []
  })

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const music = (id, source) => ({
  id,
  name: `name-${id}`,
  singer: `singer-${id}`,
  source,
  interval: null,
  meta: {
    songId: id,
    albumName: `album-${id}`,
    qualitys: [],
    _qualitys: { '320k': { size: null } },
  },
})

const createUrlRaceHarness = ({
  musicSdk,
  findMusic = async() => [],
  getOtherSourcesFromCache = async() => [],
  getCachedMusicUrl = async() => '',
  localMusicApi = {},
  onAuthorize = () => {},
}) => {
  const saves = []
  const cacheReads = []
  const requestEvents = []
  const neteaseProfile = { value: { userId: 1, nickname: '', avatarUrl: '' } }
  const qqMusicProfile = { value: { uin: '10001', nickname: '' } }
  const neteaseLoggedIn = { value: true }
  const qqMusicLoggedIn = { value: true }
  const apiSource = { value: 'official' }
  const cacheValidation = loadTsModule(path.join(root, 'src/common/storage/cacheValidation.ts'))
  const ipc = {
    requestMusicUrlAuthorization: async(provider) => {
      requestEvents.push(`authorize:${provider}`)
      onAuthorize(provider)
      const accountScope = provider == 'wy'
        ? cacheValidation.neteaseAccountScope(neteaseProfile.value)
        : cacheValidation.qqMusicAccountScope(qqMusicProfile.value)
      return accountScope == null ? null : { version: 1, provider, accountScope, generation: 1 }
    },
    getMusicUrl: async key => {
      cacheReads.push(structuredClone(key))
      requestEvents.push(`cache:${key.authorization.provider}`)
      return getCachedMusicUrl(key)
    },
    saveMusicUrl: async(key, url) => { saves.push({ key: structuredClone(key), url }) },
    getOtherSourcesFromCache,
    putOtherSourcesInCache: async() => {},
    getPlayerLyric: async() => ({ lyric: '' }),
    saveLyric: async() => {},
  }
  const appSetting = { 'player.playQuality': '320k', 'player.isS2t': false }
  const candidates = loadTsModule(path.join(root, 'src/renderer/core/music/playback/candidates.ts'), {
    '@renderer/utils/musicSdk': { findMusic },
    '@renderer/utils': { toNewMusicInfo: value => value },
  })
  const utils = loadTsModule(path.join(root, 'src/renderer/core/music/utils.ts'), {
    '@renderer/store': {
      apiSource,
      qualityList: { value: { wy: ['128k', '320k'], tx: ['128k', '320k'] } },
    },
    '@renderer/store/netease': { profile: neteaseProfile, isLoggedIn: neteaseLoggedIn },
    '@renderer/store/qqMusic': { profile: qqMusicProfile, isLoggedIn: qqMusicLoggedIn },
    '@common/storage/cacheValidation': cacheValidation,
    '@renderer/store/utils': { assertApiSupport: () => true },
    '@renderer/utils/musicSdk': { ...musicSdk, findMusic },
    '@renderer/utils/ipc': ipc,
    '@renderer/store/setting': { appSetting },
    '@renderer/utils': { langS2T: async value => value, toNewMusicInfo: value => value, toOldMusicInfo: value => value },
    '@renderer/utils/message': { requestMsg: { tooManyRequests: 'too many requests' } },
    '@renderer/utils/musicSdk/api-source': { apis: () => localMusicApi },
    './playback/candidates': candidates,
    './playback/cache': { playbackUrlCache: { adoptCacheGeneration() {} } },
  })
  const online = loadTsModule(path.join(root, 'src/renderer/core/music/online.ts'), {
    '@renderer/store/list/action': { updateListMusics: async() => {} },
    '@renderer/store/setting': { appSetting },
    '@renderer/utils/ipc': ipc,
    './utils': utils,
  })
  return { apiSource, cacheReads, neteaseProfile, online, qqMusicProfile, requestEvents, saves, utils }
}

const loadMusicUrlIpcBoundary = authorization => {
  const handlers = new Map()
  const names = new Proxy({}, { get: (_target, key) => String(key) })
  const cacheContracts = loadTsModule(path.join(root, 'src/common/storage/cache.ts'))
  const cacheValidation = loadTsModule(path.join(root, 'src/common/storage/cacheValidation.ts'))
  const rendererEvent = loadTsModule(path.join(root, 'src/main/modules/winMain/rendererEvent/music.ts'), {
    '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: names },
    '@common/mainIpc': { mainHandle: (name, handler) => handlers.set(name, handler) },
    '@common/storage/cacheValidation': cacheValidation,
  })
  rendererEvent.default()
  const hotKeyGroup = new Proxy({}, { get: (_target, key) => ({ name: String(key), action: String(key) }) })
  const ipc = loadTsModule(path.join(root, 'src/renderer/utils/ipc.ts'), {
    '@common/ipcNames': {
      CMMON_EVENT_NAME: names,
      HOTKEY_RENDERER_EVENT_NAME: names,
      WIN_MAIN_RENDERER_EVENT_NAME: names,
    },
    '@common/storage/cache': cacheContracts,
    '@common/rendererIpc': {
      rendererInvoke: async(name, params) => {
        const handler = handlers.get(name)
        if (handler == null) throw new Error(`Missing main handler: ${name}`)
        return handler({ params })
      },
      rendererOn: () => {},
      rendererOff: () => {},
      rendererSend: () => {},
    },
    '@common/utils/vueTools': { markRaw: value => value, toRaw: value => value },
    '@common/utils': { log: { error: () => {} } },
    '@common/hotKey': {
      HOTKEY_COMMON: hotKeyGroup,
      HOTKEY_DESKTOP_LYRIC: hotKeyGroup,
      HOTKEY_PLAYER: hotKeyGroup,
    },
    '@common/constants': { APP_EVENT_NAMES: {}, DATA_KEYS: {} },
    './storageState': { getLocalState: async() => {}, setLocalState: async() => {} },
    './shutdown': { registerShutdownFlusher: () => {} },
  })
  return { authorization, handlers, ipc }
}

describe('scoped cache ownership callsites', () => {
  const authorizedKey = {
    authorization: {
      version: 1,
      provider: 'wy',
      accountScope: 'profile-v1:user-id:7',
      generation: 1,
    },
    sourceTrackId: 'track',
    quality: '320k',
  }

  it('keeps a structured unavailable read as a normal cache miss across renderer and main', async() => {
    const previousLx = global.lx
    const reads = []
    global.lx = {
      musicUrlAuthorization: {
        async read(input) {
          reads.push(structuredClone(input))
          return { status: 'unavailable', code: 'cache_open_failed' }
        },
      },
      worker: { dbService: {} },
    }
    try {
      const { ipc } = loadMusicUrlIpcBoundary(global.lx.musicUrlAuthorization)
      assert.equal(await ipc.getMusicUrl(authorizedKey), '')
      assert.equal(reads.length, 1)
    } finally {
      global.lx = previousLx
    }
  })

  it('rejects a structured unavailable URL write with a bounded diagnostic across renderer and main', async() => {
    const previousLx = global.lx
    global.lx = {
      musicUrlAuthorization: {
        async write() { return { status: 'unavailable', code: 'cache_operation_failed' } },
      },
      worker: { dbService: {} },
    }
    try {
      const { ipc } = loadMusicUrlIpcBoundary(global.lx.musicUrlAuthorization)
      await assert.rejects(
        ipc.saveMusicUrl(authorizedKey, 'https://media.invalid/rejected'),
        error => error?.name == 'Error' && error?.code == 'cache_operation_failed',
      )
    } finally {
      global.lx = previousLx
    }
  })

  it('uses exact delete without a cache read and rejects structured unavailable persistence', async() => {
    const previousLx = global.lx
    const operations = []
    global.lx = {
      musicUrlAuthorization: {
        async read() {
          operations.push('read')
          return { status: 'hit', value: 'https://media.invalid/rejected' }
        },
        async write() {
          operations.push('write')
          return { status: 'stored' }
        },
        async delete(input) {
          operations.push({ delete: structuredClone(input) })
          return { status: 'unavailable', code: 'cache_open_failed' }
        },
      },
      worker: { dbService: {} },
    }
    try {
      const { ipc } = loadMusicUrlIpcBoundary(global.lx.musicUrlAuthorization)
      await assert.rejects(
        ipc.removeMusicUrl(authorizedKey),
        error => error?.name == 'Error' && error?.code == 'cache_open_failed',
      )
      assert.deepEqual(operations, [{ delete: authorizedKey }])
    } finally {
      global.lx = previousLx
    }
  })

  it('defines strict scoped DTOs and exposes only scoped worker repository APIs', () => {
    const contracts = read('src/common/storage/cache.ts')
    const worker = [
      read('src/main/worker/dbService/modules/index.ts'),
      read('src/main/worker/dbService/index.ts'),
      read('src/main/worker/dbService/modules/music_url/index.ts'),
      read('src/main/worker/dbService/modules/music_other_source/index.ts'),
      read('src/main/types/db_service.d.ts'),
      read('src/main/types/worker.d.ts'),
    ].join('\n')
    assert.match(contracts, /interface\s+AuthorizedMusicUrlKeyV1[\s\S]*authorization[\s\S]*sourceTrackId[\s\S]*quality/)
    assert.match(contracts, /interface\s+TrackIdentityV1[\s\S]*originalProvider[\s\S]*originalTrackId/)
    for (const name of ['musicUrlGet', 'musicUrlPut', 'musicUrlInvalidateAccount', 'musicUrlInvalidateSource', 'otherSourcesGet', 'otherSourcesPut']) {
      assert.match(worker, new RegExp(`\\b${name}\\b`), `${name} is not exported across the worker boundary`)
    }
    assert.doesNotMatch(worker, /\b(getMusicUrl|musicUrlSave|musicUrlRemove|musicInfoOtherSourceAdd|musicInfoOtherSourceRemove)\b/)
  })

  it('uses scoped cache IPC payloads and validates hostile renderer input before worker dispatch', () => {
    const names = read('src/common/ipcNames.ts')
    const ipc = read('src/renderer/utils/ipc.ts')
    const main = read('src/main/modules/winMain/rendererEvent/music.ts')
    assert.match(names, /music_url_get/)
    assert.match(names, /music_url_put/)
    assert.match(names, /music_url_authorize/)
    assert.match(names, /other_sources_get/)
    assert.match(names, /other_sources_put/)
    assert.match(ipc, /AuthorizedMusicUrlKeyV1/)
    assert.match(ipc, /requestMusicUrlAuthorization/)
    assert.match(ipc, /TrackIdentityV1/)
    assert.doesNotMatch(ipc, /`\$\{musicInfo\.id\}_\$\{type\}`/)
    assert.match(main, /parseAuthorizedMusicUrlGetInput/)
    assert.match(main, /parseAuthorizedMusicUrlPutInput/)
    assert.match(main, /parseMusicUrlAuthorizationRequest/)
    assert.match(main, /parseOtherSourcesGetInput/)
    assert.match(main, /parseOtherSourcesPutInput/)
  })

  it('rejects noncanonical URL ownership at main IPC before worker dispatch', async() => {
    const handlers = new Map()
    const dispatched = []
    const previousLx = global.lx
    global.lx = {
      musicUrlAuthorization: {
        authorize: async provider => ({
          version: 1, provider, accountScope: 'profile-v1:uin:10001', generation: 1,
        }),
        write: async input => { dispatched.push(structuredClone(input)); return { status: 'stored' } },
      },
      worker: { dbService: {} },
    }
    try {
      const names = new Proxy({}, { get: (_target, key) => String(key) })
      const cacheValidation = loadTsModule(path.join(root, 'src/common/storage/cacheValidation.ts'))
      const rendererEvent = loadTsModule(path.join(root, 'src/main/modules/winMain/rendererEvent/music.ts'), {
        '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: names },
        '@common/mainIpc': { mainHandle: (name, handler) => handlers.set(name, handler) },
        '@common/storage/cacheValidation': cacheValidation,
      })
      rendererEvent.default()
      const put = handlers.get('music_url_put')
      const authorize = handlers.get('music_url_authorize')
      for (const params of [
        { provider: 'kw', accountScope: 'profile-v1:uin:10001', quality: '320k' },
        { provider: 'wy', accountScope: 'profile-v1:uin:10001', quality: '320k' },
        { provider: 'tx', accountScope: 'profile-v1:user-id:7', quality: '320k' },
        { provider: 'tx', accountScope: 'profile-v1:uin:10001', quality: 'hires' },
      ]) {
        await assert.rejects(put({
          params: {
            ...params, sourceTrackId: 'track', url: 'https://media.invalid/rejected', nowMs: 1,
          },
        }), error => error?.code == 'music_url_input_invalid')
      }
      assert.equal(dispatched.length, 0)
      await put({
        params: {
          authorization: {
            version: 1,
            provider: 'tx',
            accountScope: 'profile-v1:uin:10001',
            generation: 1,
          },
          sourceTrackId: 'track',
          quality: 'wav',
          url: 'https://media.invalid/accepted',
          nowMs: 1,
        },
      })
      assert.equal(dispatched.length, 1)
      assert.deepEqual(await authorize({ params: { provider: 'tx' } }), {
        version: 1, provider: 'tx', accountScope: 'profile-v1:uin:10001', generation: 1,
      })
      await assert.rejects(authorize({ params: { provider: 'tx', accountScope: 'forged' } }),
        error => error?.code == 'music_url_input_invalid')
    } finally {
      global.lx = previousLx
    }
  })

  it('persists URLs only for validated public profiles and never assigns an identity-less scope', () => {
    const ipc = read('src/renderer/utils/ipc.ts')
    const online = read('src/renderer/core/music/online.ts')
    const local = read('src/renderer/core/music/local.ts')
    const utils = read('src/renderer/core/music/utils.ts')
    const identity = [ipc, utils, read('src/common/storage/cacheValidation.ts')].join('\n')
    assert.doesNotMatch(utils, /neteaseAccountScope|qqMusicAccountScope/)
    assert.match(ipc, /requestMusicUrlAuthorization/)
    assert.match(utils, /isNeteaseLoggedIn\.value/)
    assert.match(utils, /isQQMusicLoggedIn\.value/)
    assert.match(identity, /MusicUrlAuthorizationV1/)
    assert.match([online, local, utils].join('\n'), /persistentCache/)
    assert.doesNotMatch([ipc, online, local, utils].join('\n'), /accountScope\s*:\s*['"](?:guest|anonymous|public)['"]/i)
    assert.doesNotMatch([ipc, online, local, utils].join('\n'), /(?:cookie|token|authorization).*accountScope|accountScope.*(?:cookie|token|authorization)/i)
  })

  it('carries the direct authorization captured before its provider request starts', async() => {
    const previousWindow = global.window
    const request = deferred()
    const started = deferred()
    global.window = { lx: { apiInitPromise: [Promise.resolve(true)] }, i18n: { t: value => value } }
    try {
      const harness = createUrlRaceHarness({
        musicSdk: {
          wy: {
            getMusicUrl() {
              started.resolve()
              return { promise: request.promise }
            },
          },
        },
      })
      const result = harness.online.getMusicUrl({
        musicInfo: music('wy-track', 'wy'), quality: '320k', isRefresh: false,
      })
      await started.promise
      harness.neteaseProfile.value = { userId: 2, nickname: '', avatarUrl: '' }
      request.resolve({ type: '320k', url: 'https://media.invalid/account-a' })
      assert.deepEqual(await result, {
        url: 'https://media.invalid/account-a',
        quality: '320k',
        musicInfo: music('wy-track', 'wy'),
      })
      assert.deepEqual(harness.cacheReads, [{
        authorization: {
          version: 1,
          provider: 'wy',
          accountScope: 'profile-v1:user-id:1',
          generation: 1,
        },
        sourceTrackId: 'wy-track',
        quality: '320k',
      }])
    } finally {
      global.window = previousWindow
    }
  })

  it('obtains authorization before each direct and fallback provider network request', async() => {
    const previousWindow = global.window
    const previousConsoleLog = console.log
    const events = []
    global.window = { lx: { apiInitPromise: [Promise.resolve(true)] }, i18n: { t: value => value } }
    console.log = () => {}
    try {
      const harness = createUrlRaceHarness({
        onAuthorize: provider => { events.push(`authorize:${provider}`) },
        musicSdk: {
          wy: {
            getMusicUrl() {
              events.push('network:wy')
              return { promise: Promise.reject(new Error('primary failed')) }
            },
          },
          tx: {
            getMusicUrl() {
              events.push('network:tx')
              return { promise: Promise.resolve({ type: '320k', url: 'https://media.invalid/fallback' }) }
            },
          },
        },
        findMusic: async() => [music('tx-target', 'tx')],
      })
      assert.equal(await harness.online.getMusicUrl({
        musicInfo: music('wy-original', 'wy'), quality: '320k', isRefresh: false, allowToggleSource: true,
      }).then(result => result.url), 'https://media.invalid/fallback')
      assert.deepEqual(events, ['authorize:wy', 'network:wy', 'authorize:tx', 'network:tx'])
      assert.deepEqual(harness.requestEvents, [
        'authorize:wy', 'cache:wy', 'authorize:tx', 'cache:tx',
      ])
    } finally {
      global.window = previousWindow
      console.log = previousConsoleLog
    }
  })

  it('never requests authorization or persistence for User API and local User API URLs', async() => {
    const previousWindow = global.window
    global.window = { lx: { apiInitPromise: [Promise.resolve(true)] }, i18n: { t: value => value } }
    try {
      const harness = createUrlRaceHarness({
        musicSdk: {
          wy: { getMusicUrl: () => ({ promise: Promise.resolve({ type: '320k', url: 'https://media.invalid/user-api' }) }) },
        },
        localMusicApi: {
          getMusicUrl: () => ({ promise: Promise.resolve({ url: 'https://media.invalid/local-user-api', persistentCache: false }) }),
        },
      })
      harness.apiSource.value = 'user_api:test'
      assert.equal((await harness.online.getMusicUrl({
        musicInfo: music('wy-user-api', 'wy'), quality: '320k', isRefresh: false,
      })).url, 'https://media.invalid/user-api')
      assert.equal((await harness.utils.getOnlineOtherSourceMusicUrlByLocal({
        ...music('local-track', 'local'),
        meta: {
          songId: 'local-track', albumName: 'local', filePath: 'C:\\music\\local.mp3', ext: 'mp3',
        },
      }, false)).url, 'https://media.invalid/local-user-api')
      assert.deepEqual(harness.requestEvents, [])
      assert.deepEqual(harness.saves, [])
    } finally {
      global.window = previousWindow
    }
  })

  it('rewrites only the captured direct key quality to the provider result', async() => {
    const previousWindow = global.window
    global.window = { lx: { apiInitPromise: [Promise.resolve(true)] }, i18n: { t: value => value } }
    try {
      const harness = createUrlRaceHarness({
        musicSdk: {
          wy: {
            getMusicUrl: () => ({ promise: Promise.resolve({
              type: '128k', url: 'https://media.invalid/direct-returned-quality',
            }) }),
          },
        },
      })
      const musicInfo = music('wy-quality-track', 'wy')
      const cacheKey = await harness.utils.getMusicUrlCacheKey(musicInfo, '320k')
      const result = await harness.utils.handleGetOnlineMusicUrl({
        musicInfo,
        quality: '320k',
        isRefresh: false,
        allowToggleSource: false,
        onToggleSource() {},
        cacheKey,
      })
      assert.equal(result.url, 'https://media.invalid/direct-returned-quality')
      assert.deepEqual(result.cacheKey, {
        authorization: {
          version: 1,
          provider: 'wy',
          accountScope: 'profile-v1:user-id:1',
          generation: 1,
        },
        sourceTrackId: 'wy-quality-track',
        quality: '128k',
      })
    } finally {
      global.window = previousWindow
    }
  })

  it('carries the matched target authorization captured before that provider request starts', async() => {
    const previousWindow = global.window
    const previousConsoleLog = console.log
    const request = deferred()
    const started = deferred()
    const target = music('tx-target', 'tx')
    global.window = { lx: { apiInitPromise: [Promise.resolve(true)] }, i18n: { t: value => value } }
    console.log = () => {}
    try {
      const harness = createUrlRaceHarness({
        musicSdk: {
          wy: { getMusicUrl: () => ({ promise: Promise.reject(new Error('primary failed')) }) },
          tx: {
            getMusicUrl() {
              started.resolve()
              return { promise: request.promise }
            },
          },
        },
        findMusic: async() => [target],
      })
      const result = harness.online.getMusicUrl({
        musicInfo: music('wy-original', 'wy'), quality: '320k', isRefresh: false, allowToggleSource: true,
      })
      await started.promise
      harness.qqMusicProfile.value = { uin: '20002', nickname: '' }
      request.resolve({ type: '320k', url: 'https://media.invalid/qq-account-a' })
      assert.equal((await result).url, 'https://media.invalid/qq-account-a')
      assert.deepEqual(harness.cacheReads.at(-1), {
        authorization: {
          version: 1,
          provider: 'tx',
          accountScope: 'profile-v1:uin:10001',
          generation: 1,
        },
        sourceTrackId: 'tx-target',
        quality: '320k',
      })
    } finally {
      global.window = previousWindow
      console.log = previousConsoleLog
    }
  })

  it('rewrites only the matched fallback key quality to the provider result', async() => {
    const previousWindow = global.window
    const previousConsoleLog = console.log
    global.window = { lx: { apiInitPromise: [Promise.resolve(true)] }, i18n: { t: value => value } }
    console.log = () => {}
    try {
      const harness = createUrlRaceHarness({
        musicSdk: {
          wy: { getMusicUrl: () => ({ promise: Promise.reject(new Error('primary failed')) }) },
          tx: {
            getMusicUrl: () => ({ promise: Promise.resolve({
              type: '128k', url: 'https://media.invalid/fallback-returned-quality',
            }) }),
          },
        },
        findMusic: async() => [music('tx-quality-target', 'tx')],
      })
      const musicInfo = music('wy-quality-original', 'wy')
      const cacheKey = await harness.utils.getMusicUrlCacheKey(musicInfo, '320k')
      const result = await harness.utils.handleGetOnlineMusicUrl({
        musicInfo,
        quality: '320k',
        isRefresh: false,
        allowToggleSource: true,
        onToggleSource() {},
        cacheKey,
      })
      assert.equal(result.url, 'https://media.invalid/fallback-returned-quality')
      assert.deepEqual(result.cacheKey, {
        authorization: {
          version: 1,
          provider: 'tx',
          accountScope: 'profile-v1:uin:10001',
          generation: 1,
        },
        sourceTrackId: 'tx-quality-target',
        quality: '128k',
      })
    } finally {
      global.window = previousWindow
      console.log = previousConsoleLog
    }
  })

  it('carries one fallback authorization from cache read through the provider request', async() => {
    const previousWindow = global.window
    const cacheRead = deferred()
    const cacheReadStarted = deferred()
    const request = deferred()
    const started = deferred()
    global.window = { lx: { apiInitPromise: [Promise.resolve(true)] }, i18n: { t: value => value } }
    try {
      const harness = createUrlRaceHarness({
        musicSdk: {
          tx: {
            getMusicUrl() {
              started.resolve()
              return { promise: request.promise }
            },
          },
        },
        getCachedMusicUrl: () => {
          cacheReadStarted.resolve()
          return cacheRead.promise
        },
      })
      const result = harness.utils.getOnlineOtherSourceMusicUrl({
        musicInfos: [music('tx-target', 'tx')], quality: '320k', onToggleSource() {}, isRefresh: false,
      })
      await cacheReadStarted.promise
      harness.qqMusicProfile.value = { uin: '20002', nickname: '' }
      cacheRead.resolve('')
      await started.promise
      request.resolve({ type: '320k', url: 'https://media.invalid/qq-account-b' })
      assert.deepEqual((await result).cacheKey, {
        authorization: {
          version: 1,
          provider: 'tx',
          accountScope: 'profile-v1:uin:10001',
          generation: 1,
        },
        sourceTrackId: 'tx-target',
        quality: '320k',
      })
      assert.deepEqual(harness.requestEvents, ['authorize:tx', 'cache:tx'])
    } finally {
      global.window = previousWindow
    }
  })

  for (const persistentState of ['expiry', 'explicit clear', 'unavailable']) {
    it(`does not resurrect alternate sources from memory after persistent ${persistentState}`, async() => {
      let searches = 0
      const original = music('original', 'wy')
      const harness = createUrlRaceHarness({
        musicSdk: {},
        findMusic: async() => [music(`candidate-${++searches}`, 'tx')],
        getOtherSourcesFromCache: async() => [],
      })
      assert.deepEqual((await harness.utils.getOtherSource(original)).map(value => value.id), ['candidate-1'])
      assert.deepEqual((await harness.utils.getOtherSource(original)).map(value => value.id), ['candidate-2'])
      assert.equal(searches, 2)
    })
  }

  it('deduplicates in-flight alternate-source discovery by canonical provider and track owner', async() => {
    const search = deferred()
    let searches = 0
    const original = music('same-owner', 'local')
    const harness = createUrlRaceHarness({
      musicSdk: {},
      findMusic() {
        searches++
        return search.promise
      },
      getOtherSourcesFromCache: async() => [],
    })
    const first = harness.utils.getOtherSource({ id: 'download-a', progress: 0, metadata: { musicInfo: original } })
    const second = harness.utils.getOtherSource({ id: 'download-b', progress: 0, metadata: { musicInfo: original } })
    await new Promise(resolve => setImmediate(resolve))
    const observedSearches = searches
    search.resolve([music('candidate', 'tx')])
    assert.deepEqual(await Promise.all([first, second]), [
      [music('candidate', 'tx')],
      [music('candidate', 'tx')],
    ])
    assert.equal(observedSearches, 1)
  })

  it('classifies User API playback as nonpersistent before requesting its URL', async() => {
    let authorizationRequests = 0
    const adapter = createAdapterHarness({
      getMusicUrlCacheKey: async() => {
        authorizationRequests++
        throw new Error('custom playback must not request URL authorization')
      },
    })
    const controller = new AbortController()
    const musicInfo = music('custom-track', 'wy')
    assert.equal(await adapter.authorizeMusicUrl({
      apiId: 'user_api/custom', musicInfo, quality: '320k', signal: controller.signal,
    }), null)
    assert.deepEqual(await adapter.getMusicUrl({
      apiId: 'user_api/custom',
      requestId: 'custom-request',
      musicInfo,
      quality: '320k',
      signal: controller.signal,
    }), {
      url: 'https://audio/custom',
      resolvedQuality: '320k',
      reportedQuality: '320k',
    })
    assert.equal(authorizationRequests, 0)
  })

  it('activates scoped alternate-source persistence around discovery', () => {
    const utils = read('src/renderer/core/music/utils.ts')
    assert.match(utils, /getOtherSourcesFromCache/)
    assert.match(utils, /putOtherSourcesInCache/)
    assert.match(utils, /originalProvider\s*:/)
    assert.match(utils, /originalTrackId\s*:/)
    assert.doesNotMatch(utils, /\/\/\s*(?:if \(!isRefresh.*getOtherSourceFromStore|if \(otherSource\.length\).*saveOtherSourceFromStore)/)
  })

  it('observes a rejected durable playback write without rejecting foreground playback', async() => {
    const reports = []
    const error = Object.assign(new Error('cache unavailable'), { code: 'SQLITE_BUSY' })
    await assert.doesNotReject(observePlaybackCachePersistence(
      Promise.reject(error),
      'commit',
      report => { reports.push(report) },
    ))
    assert.deepEqual(reports, [{
      operation: 'commit',
      errorName: 'Error',
      errorCode: 'SQLITE_BUSY',
    }])
  })

  it('has no active ID-only URL or alternate-source API or authoritative cache query', () => {
    const trees = [
      ...readTree('src/renderer'),
      ...readTree('src/main/modules'),
      ...readTree('src/main/worker/dbService/modules'),
      ...readTree('src/common'),
    ]
    const active = trees
      .filter(({ file }) => !file.includes(`${path.sep}migration${path.sep}`))
      .map(({ file, text }) => `/* ${file} */\n${text}`)
      .join('\n')
    assert.doesNotMatch(active, /\bgetMusicUrl\s*=\s*\(id:\s*string\)|\bmusicUrlSave\b|\bmusicInfoOtherSourceAdd\b|\bmusicInfoOtherSourceRemove\b/)
    assert.doesNotMatch(active, /FROM\s+["']?(?:main\.)?["']?music_url["']?\s+WHERE\s+["']?id["']?\s*=\s*\?/i)
    assert.doesNotMatch(active, /music_info_other_source[\s\S]{0,160}WHERE\s+["']?source_id["']?\s*=\s*\?/i)
  })

  it('keeps database ownership explicit and confines authoritative raw reads to migration', () => {
    const trees = [
      ...readTree('src/main/worker/dbService'),
      ...readTree('build-config/storage-electron'),
      ...readTree('build-config/storage'),
    ]
    const combined = trees.map(({ file, text }) => `/* ${file} */\n${text}`).join('\n')
    assert.doesNotMatch(combined, new RegExp(`\\bget${'D'}B\\b`))

    const authoritativeRawReaders = [
      ...readTree('src/main'),
      ...readTree('build-config'),
    ].filter(({ file, text }) =>
      file != path.join('src', 'main', 'migration', 'cache', 'rawLyrics.ts') &&
      /\bFROM\s+(?:["'`]?(?:main\.)?["'`]?)?lyric\b[\s\S]{0,240}\bsource\s*=\s*["']raw["']/i.test(text),
    ).map(({ file }) => file)
    assert.deepEqual(authoritativeRawReaders, [])
  })
})
