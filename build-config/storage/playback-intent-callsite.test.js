const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describe, it } = require('node:test')
const { pathToFileURL } = require('node:url')
const typescript = require('typescript')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const rendererRoot = path.resolve(__dirname, '../../src/renderer')

const rendererFiles = () => {
  const files = []
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (/\.(?:js|ts|vue)$/.test(entry.name)) files.push(target)
    }
  }
  visit(rendererRoot)
  return files.sort()
}

const readRendererSource = () => rendererFiles()
  .map(file => fs.readFileSync(file, 'utf8'))
  .join('\n')

const readRendererFile = file => fs.readFileSync(path.join(rendererRoot, file), 'utf8')

const collectCallsites = pattern => rendererFiles().flatMap(file => {
  const relative = path.relative(rendererRoot, file).replaceAll('\\', '/')
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, index) => (
    pattern.test(line) ? [`${relative}:${index + 1}: ${line.trim()}`] : []
  ))
})

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  module._compile(output, filename)
}

const loadStandaloneTsModule = filename => {
  const source = fs.readFileSync(filename, 'utf8')
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(filename).href))
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  const loadedModule = { exports: {} }
  // eslint-disable-next-line no-new-func
  Function('module', 'exports', 'require', output)(loadedModule, loadedModule.exports, require)
  return loadedModule.exports
}

const loadPlayerActions = advances => {
  const first = { id: 'first', source: 'local', name: 'First', singer: 'Singer', meta: {} }
  const second = { id: 'second', source: 'local', name: 'Second', singer: 'Singer', meta: {} }
  const list = [first, second]
  const playInfo = { playerListId: 'list', playerPlayIndex: 0, playIndex: 0 }
  const playMusicInfo = { musicInfo: first, listId: 'list', isTempPlay: false }
  const setPlayMusicInfo = (listId, musicInfo, isTempPlay = false) => {
    playMusicInfo.listId = listId
    playMusicInfo.musicInfo = musicInfo
    playMusicInfo.isTempPlay = isTempPlay
    playInfo.playerPlayIndex = list.indexOf(musicInfo)
    playInfo.playIndex = playInfo.playerPlayIndex
  }

  const actions = loadTsModule(path.join(rendererRoot, 'core/player/action.ts'), {
    '@renderer/plugins/player': {
      isEmpty: () => false,
      setPause() {},
      setPlay() {},
      setResource() {},
      setStop() {},
    },
    '@renderer/store/player/state': {
      isPlay: { value: false },
      playedList: [],
      playInfo,
      playMusicInfo,
      tempPlayList: [],
      musicInfo: {},
    },
    '@renderer/store/player/action': {
      getList: () => list,
      clearPlayedList() {},
      clearTempPlayeList() {},
      setPlayMusicInfo,
      addPlayedList() {},
      setMusicInfo() {},
      setAllStatus() {},
      removeTempPlayList() {},
      setPlayListId: listId => { playInfo.playerListId = listId },
      removePlayedList() {},
    },
    '@renderer/store/setting': {
      appSetting: {
        'player.autoSkipOnError': false,
        'player.isAutoCleanPlayedList': false,
        'player.togglePlayMethod': 'listLoop',
      },
    },
    '@renderer/store/party': { party: { room: null } },
    '../music/index': {
      getMusicUrl: async() => 'url',
      getPicPath: async() => '',
      getLyricInfo: async() => ({ lyric: '', tlyric: '', lxlyric: '', rlyric: '', rawlrcInfo: { lyric: '' } }),
    },
    './utils': {
      filterList: async() => ({ filteredList: list, playerIndex: playInfo.playerPlayIndex }),
    },
    '@renderer/utils/message': { requestMsg: {} },
    '@renderer/utils/index': { getRandom: () => 1, toNewMusicInfo: value => value },
    '@renderer/store/list/action': { addListMusics() {}, removeListMusics() {} },
    '@renderer/store/list/state': { loveList: { id: 'love' } },
    '@renderer/core/dislikeList': { addDislikeInfo: async() => {} },
    '@renderer/utils/musicSdk': { default: {} },
    '@renderer/store/utils': { assertApiSupport: () => false },
  })

  return { actions, first, second, playInfo, playMusicInfo, setPlayMusicInfo }
}

describe('typed playback intent callsites', () => {
  it('contains no boolean automatic-next calls or originless seeks', () => {
    const source = readRendererSource()
    const ambiguous = {
      automaticAdvance: collectCallsites(/play(?:Next|Prev)\((?:true|false)\)/),
      originlessSeek: collectCallsites(/app_event\.setProgress\([^,\n\)]*\)/),
    }

    assert.deepEqual(ambiguous, { automaticAdvance: [], originlessSeek: [] })
    assert.doesNotMatch(source, /playNext\((true|false)\)/)
    assert.doesNotMatch(source, /playPrev\((true|false)\)/)
    assert.doesNotMatch(source, /app_event\.setProgress\([^,\n\)]*\)/)
  })

  it('assigns every automatic transition and seek source its exact typed classification', () => {
    const advanceMappings = [
      ['core/player/action.ts', ['error', 'load_timeout', 'dislike', 'select']],
      ['core/useApp/usePlayer/usePlayEvent.ts', ['load_timeout', 'error']],
      ['core/useApp/usePlayer/usePlayProgress.ts', ['buffer_timeout']],
      ['core/useApp/usePlayer/usePlayer.ts', ['natural_end']],
      ['core/useApp/usePlayer/useWatchList.ts', ['queue_removed']],
      ['components/layout/PlayBar/ModernBar.vue', ['dislike']],
      ['components/material/OnlineList/useMusicActions.js', ['dislike']],
      ['store/qqDailyRecommend/action.ts', ['dislike']],
      ['views/List/MusicList/useMusicActions.js', ['dislike']],
    ]
    const seekMappings = [
      ['components/common/ProgressBar.vue', 'bar'],
      ['core/player/action.ts', 'restore'],
      ['core/useApp/usePlayer/useMediaSessionInfo.ts', 'media_session'],
      ['core/useApp/usePlayer/usePlayProgress.ts', 'buffer_recovery'],
      ['core/useApp/usePlayer/usePlayStatus.ts', 'media_session'],
      ['core/useApp/usePlayer/usePlayer.ts', 'hotkey'],
      ['core/useApp/useParty.ts', 'party'],
      ['utils/compositions/useLyric.js', 'lyric'],
    ]

    for (const [file, reasons] of advanceMappings) {
      const source = readRendererFile(file)
      for (const reason of reasons) assert.match(source, new RegExp(`reason: ['"]${reason}['"]`), `${file} must carry ${reason}`)
    }
    for (const [file, origin] of seekMappings) {
      assert.match(readRendererFile(file), new RegExp(`setProgress\\([^\\n]+['"]${origin}['"]`), `${file} must carry ${origin}`)
    }
  })

  it('propagates typed advance and seek payloads through AppEvent', () => {
    const { AppEvent } = require('../../src/renderer/event/appEvent.ts')
    const event = new AppEvent()
    const advances = []
    const seeks = []
    event.on('playbackAdvance', options => advances.push(options))
    event.on('setProgress', (...args) => seeks.push(args))

    event.playbackAdvance({ automatic: true, reason: 'buffer_timeout' })
    event.setProgress(12, 'bar', 120)

    assert.deepEqual(advances, [{ automatic: true, reason: 'buffer_timeout' }])
    assert.deepEqual(seeks, [[12, 'bar', 120]])
  })

  it('carries exact next, previous, dislike, and selection reasons through player actions', async() => {
    const previousWindow = global.window
    const advances = []
    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: null },
      i18n: { t: value => value },
      app_event: {
        playbackAdvance: options => advances.push(options),
        pause() {},
        picUpdated() {},
        lyricUpdated() {},
        error() {},
      },
    }

    try {
      const harness = loadPlayerActions(advances)
      await harness.actions.playNext({ automatic: true, reason: 'buffer_timeout' })

      harness.setPlayMusicInfo('list', harness.second)
      await harness.actions.playPrev()

      harness.setPlayMusicInfo('list', harness.first)
      await harness.actions.dislikeMusic()

      harness.setPlayMusicInfo('list', harness.first)
      harness.actions.playList('list', 1)
      await new Promise(resolve => setImmediate(resolve))

      assert.deepEqual(advances, [
        { automatic: true, reason: 'buffer_timeout' },
        { automatic: false, reason: 'previous' },
        { automatic: true, reason: 'dislike' },
        { automatic: false, reason: 'select' },
      ])
    } finally {
      global.window = previousWindow
    }
  })

  it('keeps QQ Daily dislike intent when it selects a replacement from the remaining list', () => {
    const source = readRendererFile('store/qqDailyRecommend/action.ts')
    assert.match(
      source,
      /playList\([^\n]+\{ automatic: true, reason: ['"]dislike['"] \}\)/,
    )
  })

  it('subscribes and unsubscribes native seek, rate, waiting, and canplay events', () => {
    class FakeAudio {
      static instance

      constructor() {
        FakeAudio.instance = this
        this.listeners = new Map()
      }

      addEventListener(name, listener) {
        const listeners = this.listeners.get(name) ?? []
        listeners.push(listener)
        this.listeners.set(name, listeners)
      }

      removeEventListener(name, listener) {
        const listeners = this.listeners.get(name) ?? []
        this.listeners.set(name, listeners.filter(item => item !== listener))
      }

      dispatch(name) {
        for (const listener of this.listeners.get(name) ?? []) listener()
      }
    }

    const previousWindow = global.window
    global.window = { Audio: FakeAudio }
    try {
      const player = loadStandaloneTsModule(path.join(rendererRoot, 'plugins/player/index.ts'))
      player.createAudio()

      const received = []
      const subscriptions = [
        ['seeking', player.onSeeking],
        ['seeked', player.onSeeked],
        ['ratechange', player.onRatechange],
        ['waiting', player.onWaiting],
        ['canplay', player.onCanplay],
      ].map(([name, subscribe]) => subscribe(() => received.push(name)))

      for (const name of ['seeking', 'seeked', 'ratechange', 'waiting', 'canplay']) {
        FakeAudio.instance.dispatch(name)
      }
      assert.deepEqual(received, ['seeking', 'seeked', 'ratechange', 'waiting', 'canplay'])

      for (const unsubscribe of subscriptions) unsubscribe()
      received.length = 0
      for (const name of ['seeking', 'seeked', 'ratechange', 'waiting', 'canplay']) {
        FakeAudio.instance.dispatch(name)
      }
      assert.deepEqual(received, [])
    } finally {
      global.window = previousWindow
    }
  })
})
