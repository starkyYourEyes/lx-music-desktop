const assert = require('node:assert')
const path = require('node:path')

const loadTsModule = require('./test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const onlinePath = path.join(root, 'src/renderer/core/music/online.ts')
const indexPath = path.join(root, 'src/renderer/core/music/index.ts')
const playbackPath = path.join(root, 'src/renderer/core/music/playback/index.ts')

const createOnlineMusicInfo = (source, id) => ({
  id,
  name: `song-${id}`,
  singer: 'singer',
  source,
  interval: '03:00',
  meta: {
    songId: id,
    albumName: 'album',
    qualitys: [
      { type: '128k', size: null },
      { type: '320k', size: null },
    ],
    _qualitys: {
      '128k': { size: null },
      '320k': { size: null },
    },
  },
})

const loadOnlineModule = ({ cachedUrl = null, resolvedResult }) => loadTsModule(onlinePath, {
  '@renderer/store/list/action': { updateListMusics: () => {} },
  '@renderer/store/setting': { appSetting: { 'player.playQuality': '320k' } },
  '@renderer/utils/ipc': {
    saveLyric: () => {},
    saveMusicUrl: () => {},
    getMusicUrl: async() => cachedUrl,
  },
  './utils': {
    buildLyricInfo: value => value,
    getPlayQuality: quality => quality,
    handleGetOnlineLyricInfo: async() => { throw new Error('not used') },
    handleGetOnlineMusicUrl: typeof resolvedResult === 'function'
      ? resolvedResult
      : async() => resolvedResult,
    handleGetOnlinePicUrl: async() => { throw new Error('not used') },
    getCachedLyricInfo: async() => null,
  },
})

const testCachedUrlIncludesRequestedQualityAndMusicInfo = async() => {
  const musicInfo = createOnlineMusicInfo('kw', 'cached')
  const online = loadOnlineModule({
    cachedUrl: 'https://audio.test/cached.mp3',
    resolvedResult: async() => { throw new Error('SDK should not run for a cache hit') },
  })

  const result = await online.getMusicUrl({
    musicInfo,
    quality: '320k',
    isRefresh: false,
  })

  assert.deepStrictEqual(result, {
    url: 'https://audio.test/cached.mp3',
    quality: '320k',
    musicInfo,
  })
}

const testResolvedUrlIncludesActualQualityAndMatchedMusicInfo = async() => {
  const requestedMusicInfo = createOnlineMusicInfo('kw', 'requested')
  const matchedMusicInfo = createOnlineMusicInfo('tx', 'matched')
  const online = loadOnlineModule({
    resolvedResult: {
      url: 'https://audio.test/matched.mp3',
      quality: '128k',
      musicInfo: matchedMusicInfo,
      isFromCache: false,
    },
  })

  const result = await online.getMusicUrl({
    musicInfo: requestedMusicInfo,
    quality: '320k',
    isRefresh: false,
  })

  assert.deepStrictEqual(result, {
    url: 'https://audio.test/matched.mp3',
    quality: '128k',
    musicInfo: matchedMusicInfo,
  })
}

const testCommonEntryKeepsOnlineMetadataAndWrapsDirectUrls = async() => {
  const musicInfo = createOnlineMusicInfo('kw', 'online')
  const onlineResult = {
    url: 'https://audio.test/online.mp3',
    quality: '320k',
    musicInfo,
  }
  const common = loadTsModule(indexPath, {
    './online': {
      getMusicUrl: async() => onlineResult,
      getPrimaryMusicUrl: async() => onlineResult,
      getPicUrl: async() => '',
      getLyricInfo: async() => ({}),
    },
    './download': {
      getMusicUrl: async() => 'D:/music/downloaded.mp3',
      getPrimaryMusicUrl: async() => 'D:/music/downloaded.mp3',
      getPicUrl: async() => '',
      getLyricInfo: async() => ({}),
    },
    './local': {
      getMusicUrl: async() => 'D:/music/local.mp3',
      getPrimaryMusicUrl: async() => 'D:/music/local.mp3',
      getPicUrl: async() => '',
      getLyricInfo: async() => ({}),
    },
    './webdav': {
      getMusicUrl: async() => 'https://dav.test/music.mp3',
      getPicUrl: async() => '',
      getLyricInfo: async() => ({}),
    },
    './playback': { createPlaybackRequest: async() => { throw new Error('not used') } },
  })

  assert.deepStrictEqual(await common.getMusicUrl({ musicInfo }), onlineResult)
  assert.deepStrictEqual(await common.getMusicUrl({
    musicInfo: {
      id: 'local',
      name: 'local',
      singer: '',
      source: 'local',
      interval: null,
      meta: {
        songId: 'local',
        albumName: '',
        filePath: 'D:/music/local.mp3',
        ext: 'mp3',
      },
    },
  }), { url: 'D:/music/local.mp3' })
}

const testPlaybackFacadeReturnsDirectOrSessionControlFlow = async() => {
  const session = { id: 'session' }
  const originalWindow = global.window
  global.window = { setTimeout, clearTimeout }
  const playback = loadTsModule(playbackPath, {
    '@common/utils': { encodePath: value => value, log: { debug() {}, error() {} } },
    '@renderer/store/setting': {
      appSetting: {
        'common.apiSource': 'primary',
        'common.apiFallbackSources': [],
        'player.playQuality': '320k',
      },
    },
    '@renderer/store/download/utils': { buildSavePath: () => '' },
    '@renderer/plugins/player': { clearResourceIf() {} },
    '@renderer/utils/music': {
      getDownloadFilePath: async() => null,
      getLocalFilePath: async() => null,
    },
    '../webdav': { getMusicUrl: async() => 'https://dav.test/song.mp3' },
    './cache': {
      observePlaybackCachePersistence: async promise => { await promise.catch(() => {}) },
      playbackUrlCache: { invalidateQualityRange: async() => {} },
    },
    './candidates': {
      createOnlineCandidateProvider: () => ({}),
      createLocalCandidateProvider: () => ({}),
      findPlaybackCandidates: async() => [],
    },
    './coordinator': {
      createPlaybackResolutionCoordinator: () => ({}),
      getPlaybackSongIdentity: musicInfo => `${musicInfo.source}:${musicInfo.id}`,
    },
    './session': { createPlaybackResolveSession: () => session },
    './sourceAdapter': { playbackSourceAdapter: {} },
  })
  global.window = originalWindow
  const facade = playback.createPlaybackMusicFacade({
    getDownloadFilePath: async() => null,
    buildSavePath: () => '',
    getLocalFilePath: async() => 'D:/music/local.mp3',
    encodePath: value => `encoded:${value}`,
    getWebDAVMusicUrl: async() => 'https://dav.test/song.mp3',
    createOnlinePlaybackSession: async() => session,
    createLocalPlaybackSession: async() => session,
  })
  const local = {
    id: 'local', name: 'local', singer: '', source: 'local', interval: null,
    meta: { songId: 'local', albumName: '', filePath: 'D:/music/local.mp3', ext: 'mp3' },
  }
  assert.deepStrictEqual(await facade.createPlaybackRequest({
    musicInfo: local,
    reason: 'initial',
  }), {
    kind: 'direct',
    resource: {
      kind: 'direct',
      songIdentity: 'local:local',
      url: 'encoded:D:/music/local.mp3',
    },
  })
  assert.deepStrictEqual(await facade.createPlaybackRequest({
    musicInfo: createOnlineMusicInfo('kw', 'online-session'),
    reason: 'initial',
  }), { kind: 'session', session })
}

const main = async() => {
  await testCachedUrlIncludesRequestedQualityAndMusicInfo()
  await testResolvedUrlIncludesActualQualityAndMatchedMusicInfo()
  await testCommonEntryKeepsOnlineMetadataAndWrapsDirectUrls()
  await testPlaybackFacadeReturnsDirectOrSessionControlFlow()
  console.log('Music URL result tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
