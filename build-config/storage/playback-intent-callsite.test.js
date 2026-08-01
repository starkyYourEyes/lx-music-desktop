const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { describe, it } = require('node:test')
const { pathToFileURL } = require('node:url')
const typescript = require('typescript')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const rendererRoot = path.resolve(__dirname, '../../src/renderer')
const storePlayerActionPath = path.join(rendererRoot, 'store/player/action.ts')

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

const loadSourceModule = (source, filename, mocks) => {
  const output = typescript.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      allowJs: true,
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  const loadedModule = { exports: {} }
  const localRequire = request => Object.prototype.hasOwnProperty.call(mocks, request)
    ? mocks[request]
    : require(request)
  // eslint-disable-next-line no-new-func
  Function('module', 'exports', 'require', output)(loadedModule, loadedModule.exports, localRequire)
  return loadedModule.exports
}

const createEventHub = () => {
  const { AppEvent } = require('../../src/renderer/event/appEvent.ts')
  return new AppEvent()
}

const flushAsync = () => new Promise(resolve => setImmediate(resolve))

const muteExpectedConsoleOutput = () => {
  const previousLog = console.log
  const previousWarn = console.warn
  console.log = () => {}
  console.warn = () => {}
  return () => {
    console.log = previousLog
    console.warn = previousWarn
  }
}

const installFakeTimers = () => {
  const previousSetTimeout = global.setTimeout
  const previousClearTimeout = global.clearTimeout
  const timers = []
  global.setTimeout = (callback, delay = 0, ...args) => {
    const timer = { callback, delay, args, cleared: false }
    timers.push(timer)
    return timer
  }
  global.clearTimeout = timer => {
    if (timer) timer.cleared = true
  }
  return {
    runNext(delay) {
      const timer = timers.find(item => !item.cleared && item.delay === delay)
      assert.ok(timer, `expected a pending ${delay}ms timer`)
      timer.cleared = true
      timer.callback(...timer.args)
    },
    restore() {
      global.setTimeout = previousSetTimeout
      global.clearTimeout = previousClearTimeout
    },
  }
}

const loadPlayerActions = ({
  list: suppliedList,
  playMethod = 'listLoop',
  playerIndex = 0,
  autoSkipOnError = true,
  eventLog = [],
  getMusicUrl = async() => 'url',
  requestMsg = {},
} = {}) => {
  const first = { id: 'first', source: 'local', name: 'First', singer: 'Singer', meta: {} }
  const second = { id: 'second', source: 'local', name: 'Second', singer: 'Singer', meta: {} }
  const list = suppliedList ?? [first, second]
  const initialMusic = list[playerIndex] ?? first
  const playInfo = { playerListId: 'list', playerPlayIndex: playerIndex, playIndex: playerIndex }
  const playMusicInfo = { musicInfo: initialMusic, listId: 'list', isTempPlay: false }
  const musicInfo = { ...initialMusic }
  const setPlayMusicInfo = (listId, musicInfo, isTempPlay = false, selectionIntent) => {
    eventLog.push(['setPlayMusicInfo', listId, musicInfo?.id ?? null])
    playMusicInfo.listId = listId
    playMusicInfo.musicInfo = musicInfo
    playMusicInfo.isTempPlay = isTempPlay
    playInfo.playerPlayIndex = list.indexOf(musicInfo)
    playInfo.playIndex = playInfo.playerPlayIndex
    if (musicInfo && selectionIntent) global.window.app_event.musicToggled(selectionIntent)
  }

  const actions = loadTsModule(path.join(rendererRoot, 'core/player/action.ts'), {
    '@renderer/plugins/player': {
      isEmpty: () => false,
      setPause() {},
      setPlay() {},
      setResource() {},
      setStop() { eventLog.push(['setStop']) },
    },
    '@renderer/store/player/state': {
      isPlay: { value: false },
      playedList: [],
      playInfo,
      playMusicInfo,
      tempPlayList: [],
      musicInfo,
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
        'player.autoSkipOnError': autoSkipOnError,
        'player.isAutoCleanPlayedList': false,
        'player.isSavePlayTime': true,
        'player.togglePlayMethod': playMethod,
      },
    },
    '@renderer/store/party': { party: { room: null } },
    '../music/index': {
      getMusicUrl,
      getPicPath: async() => '',
      getLyricInfo: async() => ({ lyric: '', tlyric: '', lxlyric: '', rlyric: '', rawlrcInfo: { lyric: '' } }),
    },
    './utils': {
      filterList: async({ playerMusicInfo }) => ({ filteredList: list, playerIndex: list.indexOf(playerMusicInfo) }),
    },
    '@renderer/utils/message': { requestMsg },
    '@renderer/utils/index': { getRandom: () => 1, toNewMusicInfo: value => value },
    '@renderer/store/list/action': { addListMusics() {}, removeListMusics() {} },
    '@renderer/store/list/state': { loveList: { id: 'love' } },
    '@renderer/core/dislikeList': { addDislikeInfo: async() => {} },
    '@renderer/utils/musicSdk': { default: {} },
    '@renderer/store/utils': { assertApiSupport: () => false },
  })

  return { actions, first, second, list, playInfo, playMusicInfo, musicInfo, setPlayMusicInfo }
}

describe('typed playback intent callsites', () => {
  it('contains no boolean automatic-next calls or originless seeks', () => {
    const source = readRendererSource()
    const ambiguous = {
      automaticAdvance: collectCallsites(/play(?:Next|Prev)\((?:true|false)\)/),
      originlessSeek: collectCallsites(/app_event\.setProgress\([^,\n)]*\)/),
    }

    assert.deepEqual(ambiguous, { automaticAdvance: [], originlessSeek: [] })
    assert.doesNotMatch(source, /playNext\((true|false)\)/)
    assert.doesNotMatch(source, /playPrev\((true|false)\)/)
    assert.doesNotMatch(source, /app_event\.setProgress\([^,\n)]*\)/)
  })

  it('propagates typed selection, advance, seek, and error payloads through AppEvent', () => {
    const { AppEvent } = require('../../src/renderer/event/appEvent.ts')
    const event = new AppEvent()
    const selections = []
    const advances = []
    const seeks = []
    const seekFacts = []
    const errors = []
    const attempts = []
    const pauseRequests = []
    const resumeRequests = []
    event.on('musicToggled', intent => selections.push(intent))
    event.on('playbackAdvance', options => advances.push(options))
    event.on('setProgress', (...args) => seeks.push(args))
    event.on('playbackSeek', intent => seekFacts.push(intent))
    event.on('playbackError', error => errors.push(error))
    event.on('playbackNewAttempt', () => attempts.push('attempt'))
    event.on('playbackPauseRequested', reason => pauseRequests.push(reason))
    event.on('playbackResumeRequested', reason => resumeRequests.push(reason))

    const selection = {
      track: { source: 'local', sourceTrackId: 'first', name: 'First', singer: 'Singer', durationMs: null, playablePayload: null },
      context: { type: 'playlist', id: 'list' },
      resume: { listId: 'list', indexHint: 0 },
      startReason: 'remote',
      startPositionMs: 4_000,
    }
    event.musicToggled(selection)
    event.playbackAdvance({ automatic: true, reason: 'buffer_timeout' })
    event.setProgress(12, 'bar', 120)
    event.playbackSeek({ origin: 'bar', fromMs: 10_000, toMs: 12_000 })
    event.playbackError({ stage: 'decode', code: 3, recoverable: false, attempt: 2 })
    event.playbackNewAttempt()
    event.playbackPauseRequested('remote')
    event.playbackResumeRequested('recovery')

    assert.deepEqual(selections, [selection])
    assert.deepEqual(advances, [{ automatic: true, reason: 'buffer_timeout' }])
    assert.deepEqual(seeks, [[12, 'bar', 120]])
    assert.deepEqual(seekFacts, [{ origin: 'bar', fromMs: 10_000, toMs: 12_000 }])
    assert.deepEqual(errors, [{ stage: 'decode', code: 3, recoverable: false, attempt: 2 }])
    assert.deepEqual(attempts, ['attempt'])
    assert.deepEqual(pauseRequests, ['remote'])
    assert.deepEqual(resumeRequests, ['recovery'])
  })

  it('propagates explicit select, restore, remote, and automatic start reasons through player actions', async() => {
    const previousWindow = global.window
    const appEvent = createEventHub()
    const selections = []
    appEvent.on('musicToggled', intent => selections.push(intent))
    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: null },
      i18n: { t: value => value },
      app_event: appEvent,
    }

    try {
      const harness = loadPlayerActions({ autoSkipOnError: false })
      harness.actions.playList('list', 1)
      harness.actions.playList('list', 0, { automatic: false, reason: 'select', startReason: 'restore' })
      harness.actions.playMusicByInfo(harness.second, { startReason: 'remote' })
      await harness.actions.playNext({ automatic: true, reason: 'error', startReason: 'auto' })
      await flushAsync()
      await flushAsync()

      assert.deepEqual(selections, [
        { startReason: 'select', startPositionMs: 0 },
        { startReason: 'restore', startPositionMs: 0 },
        { startReason: 'remote', startPositionMs: 0 },
        { startReason: 'auto', startPositionMs: 0 },
      ])
    } finally {
      global.window = previousWindow
    }
  })

  it('emits manual attempt and default user pause/resume request causes from player actions', () => {
    const previousWindow = global.window
    const appEvent = createEventHub()
    const events = []
    appEvent.on('playbackNewAttempt', () => events.push(['attempt']))
    appEvent.on('playbackPauseRequested', reason => events.push(['pause', reason]))
    appEvent.on('playbackResumeRequested', reason => events.push(['resume', reason]))
    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: null },
      i18n: { t: value => value },
      app_event: appEvent,
    }

    try {
      const harness = loadPlayerActions()
      harness.actions.pause()
      harness.actions.play()
      assert.deepEqual(events, [
        ['pause', 'user'],
        ['attempt'],
        ['resume', 'user'],
      ])
    } finally {
      global.window = previousWindow
    }
  })

  it('labels party control requests as remote and device-removal pauses as system', () => {
    const partySource = readRendererFile('core/useApp/useParty.ts')
    const mediaDeviceSource = readRendererFile('core/useApp/usePlayer/useMediaDevice.ts')
    assert.match(partySource, /room\.playback\.playing\) play\('remote'\)/)
    assert.match(partySource, /isPlay\.value\) pause\('remote'\)/)
    assert.match(mediaDeviceSource, /pause\('system'\)/)
  })

  it('emits a copied selection snapshot at the store action boundary', () => {
    const previousWindow = global.window
    const appEvent = createEventHub()
    const selections = []
    const first = { id: 'first', source: 'local', name: 'First', singer: 'Singer', meta: { filePath: 'D:/first.flac' } }
    const second = { id: 'second', source: 'local', name: 'Second', singer: 'Singer', meta: { filePath: 'D:/second.flac' } }
    const list = [first, second]
    const playInfo = { playerListId: 'list', playerPlayIndex: 0, playIndex: 0 }
    const playMusicInfo = { musicInfo: first, listId: 'list', isTempPlay: false }
    const playerMusic = { id: null, pic: null, name: '', singer: '', album: '', lrc: null, tlrc: null, rlrc: null, lxlrc: null, rawlrc: null }
    appEvent.on('musicToggled', intent => selections.push(intent))
    global.window = { app_event: appEvent }

    try {
      const actions = loadTsModule(storePlayerActionPath, {
        './state': {
          musicInfo: playerMusic,
          isPlay: { value: false },
          status: { value: '' },
          statusText: { value: '' },
          isShowPlayerDetail: { value: false },
          isShowPlayComment: { value: false },
          isShowLrcSelectContent: { value: false },
          playInfo,
          playMusicInfo,
          playedList: [],
          tempPlayList: [],
        },
        '@renderer/store/list/action': { getListMusicsFromCache: () => list },
        '@renderer/store/download/state': { downloadList: [] },
        './playProgress': { setProgress() {} },
        '@renderer/core/player': { playNext() {} },
        '@common/constants': { LIST_IDS: { DOWNLOAD: 'download' } },
        '@common/utils/vueTools': { toRaw: value => value },
        '@common/utils/common': { arrPush() {}, arrUnshift() {} },
      })

      actions.setPlayMusicInfo('list', second, false, { startReason: 'select', startPositionMs: 0 })
      second.meta.filePath = 'D:/mutated.flac'

      assert.deepEqual(selections, [{
        track: {
          source: 'local',
          sourceTrackId: 'second',
          name: 'Second',
          singer: 'Singer',
          durationMs: null,
          playablePayload: { id: 'second', source: 'local', name: 'Second', singer: 'Singer', meta: { filePath: 'D:/second.flac' } },
        },
        context: { type: 'playlist', id: 'list' },
        resume: { listId: 'list', indexHint: 1 },
        startReason: 'select',
        startPositionMs: 0,
      }])
    } finally {
      global.window = previousWindow
    }
  })

  it('carries exact next, previous, dislike, and selection reasons through player actions', async() => {
    const previousWindow = global.window
    const advances = []
    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: null },
      i18n: { t: value => value },
      app_event: createEventHub(),
    }
    global.window.app_event.on('playbackAdvance', options => advances.push(options))

    try {
      const harness = loadPlayerActions()
      await harness.actions.playNext({ automatic: true, reason: 'buffer_timeout' })

      harness.setPlayMusicInfo('list', harness.second)
      await harness.actions.playPrev()

      harness.setPlayMusicInfo('list', harness.first)
      await harness.actions.dislikeMusic()

      harness.setPlayMusicInfo('list', harness.first)
      harness.actions.playList('list', 1)
      await flushAsync()

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

  it('emits an exhausted load timeout separately from an exhausted player error', async() => {
    const previousWindow = global.window
    const previousDocument = global.document
    const timers = installFakeTimers()
    const restoreConsole = muteExpectedConsoleOutput()
    const appEvent = createEventHub()
    const advances = []
    const errors = []
    appEvent.on('playbackAdvance', options => advances.push(options))
    appEvent.on('playbackError', error => errors.push(error))
    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: null },
      i18n: { t: value => value },
      app_event: appEvent,
    }
    global.document = { hidden: true }

    try {
      const harness = loadPlayerActions()
      const usePlayEvent = loadTsModule(path.join(rendererRoot, 'core/useApp/usePlayer/usePlayEvent.ts'), {
        '@common/utils/vueTools': { onBeforeUnmount() {} },
        '@renderer/plugins/i18n': { useI18n: () => value => value },
        '@renderer/store/player/state': {
          musicInfo: harness.musicInfo,
          playMusicInfo: harness.playMusicInfo,
        },
        '@renderer/plugins/player': { setStop() {}, isEmpty: () => false },
        '@renderer/core/player': harness.actions,
        '@renderer/store/player/action': { setAllStatus() {} },
        '@renderer/store/setting': { appSetting: { 'player.autoSkipOnError': true } },
      }).default
      usePlayEvent()

      appEvent.playerLoadstart()
      timers.runNext(25000)
      appEvent.playerLoadstart()
      timers.runNext(25000)
      await flushAsync()
      await flushAsync()

      harness.setPlayMusicInfo('list', harness.first)
      appEvent.musicToggled()
      appEvent.playerError(2)
      appEvent.playerError(2)
      appEvent.playerError(2)
      await flushAsync()

      assert.deepEqual(advances, [
        { automatic: true, reason: 'load_timeout' },
        { automatic: true, reason: 'error' },
      ])
      assert.deepEqual(errors, [
        { stage: 'load', code: null, recoverable: true, attempt: 1 },
        { stage: 'load', code: null, recoverable: false, attempt: 2 },
        { stage: 'load', code: 2, recoverable: true, attempt: 1 },
        { stage: 'load', code: 2, recoverable: true, attempt: 2 },
        { stage: 'load', code: 2, recoverable: false, attempt: 3 },
      ])
    } finally {
      timers.restore()
      restoreConsole()
      global.window = previousWindow
      global.document = previousDocument
    }
  })

  it('keeps action-level delayed load and terminal error reasons distinct', async() => {
    const previousWindow = global.window
    const timers = installFakeTimers()
    const restoreConsole = muteExpectedConsoleOutput()
    const appEvent = createEventHub()
    const advances = []
    const errors = []
    appEvent.on('playbackAdvance', options => advances.push(options))
    appEvent.on('playbackError', error => errors.push(error))
    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: null },
      i18n: { t: value => value },
      app_event: appEvent,
    }

    try {
      const pendingUrl = new Promise(() => {})
      const loadTimeoutHarness = loadPlayerActions({ getMusicUrl: () => pendingUrl })
      loadTimeoutHarness.actions.setMusicUrl(loadTimeoutHarness.first)
      timers.runNext(100000)
      await flushAsync()
      await flushAsync()

      let failedAttempts = 0
      const errorHarness = loadPlayerActions({
        getMusicUrl: () => {
          if (++failedAttempts <= 2) return Promise.reject(new Error('url failed'))
          return pendingUrl
        },
      })
      errorHarness.actions.setMusicUrl(errorHarness.first)
      await flushAsync()
      await flushAsync()
      timers.runNext(5000)
      await flushAsync()
      await flushAsync()

      assert.deepEqual(advances, [
        { automatic: true, reason: 'load_timeout' },
        { automatic: true, reason: 'error' },
      ])
      assert.deepEqual(errors, [
        { stage: 'url', code: null, recoverable: false, attempt: 2 },
      ])
    } finally {
      timers.restore()
      restoreConsole()
      global.window = previousWindow
    }
  })

  it('reports the actual terminal URL attempt after repeated delayed retries', async() => {
    const previousWindow = global.window
    const timers = installFakeTimers()
    const restoreConsole = muteExpectedConsoleOutput()
    const appEvent = createEventHub()
    const errors = []
    appEvent.on('playbackError', error => errors.push(error))
    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: null },
      i18n: { t: value => value },
      app_event: appEvent,
    }

    try {
      let attempts = 0
      const tooManyRequests = 'too many requests'
      const harness = loadPlayerActions({
        autoSkipOnError: false,
        requestMsg: { tooManyRequests, cancelRequest: 'cancel request' },
        getMusicUrl: async() => {
          attempts++
          throw new Error(attempts <= 2 ? tooManyRequests : 'url failed')
        },
      })

      harness.actions.setMusicUrl(harness.first)
      await flushAsync()
      await flushAsync()
      timers.runNext(1000)
      await flushAsync()
      await flushAsync()
      timers.runNext(1000)
      await flushAsync()
      await flushAsync()

      assert.equal(attempts, 3)
      assert.deepEqual(errors, [
        { stage: 'url', code: null, recoverable: false, attempt: 3 },
      ])
    } finally {
      timers.restore()
      restoreConsole()
      global.window = previousWindow
    }
  })

  it('emits buffer recovery seeks and buffer exhaustion intent through the real progress path', async() => {
    const previousWindow = global.window
    const previousDocument = global.document
    const timers = installFakeTimers()
    const restoreConsole = muteExpectedConsoleOutput()
    const appEvent = createEventHub()
    const advances = []
    const seeks = []
    const seekFacts = []
    let currentTime = 10
    appEvent.on('playbackAdvance', options => advances.push(options))
    appEvent.on('setProgress', (...args) => seeks.push(args))
    appEvent.on('playbackSeek', intent => seekFacts.push(intent))
    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: null },
      i18n: { t: value => value },
      app_event: appEvent,
    }
    global.document = { hidden: false }

    try {
      const harness = loadPlayerActions()
      const playProgress = { nowPlayTime: 10, maxPlayTime: 100 }
      const usePlayProgress = loadTsModule(path.join(rendererRoot, 'core/useApp/usePlayer/usePlayProgress.ts'), {
        '@common/utils/vueTools': { onBeforeUnmount() {}, watch() {} },
        '@common/utils/common': { formatPlayTime2: String, getRandom: () => 3 },
        '@common/utils': { throttle: callback => callback },
        '@renderer/utils/ipc': { savePlayInfo() {} },
        '@renderer/plugins/player': {
          onTimeupdate: () => () => {},
          onVisibilityChange: () => () => {},
          getCurrentTime: () => currentTime,
          getDuration: () => 100,
          setCurrentTime: value => { currentTime = value },
        },
        '@renderer/store/player/playProgress': {
          playProgress,
          setNowPlayTime: value => { playProgress.nowPlayTime = value },
          setMaxplayTime: value => { playProgress.maxPlayTime = value },
        },
        '@renderer/store/player/state': {
          isPlay: { value: false },
          musicInfo: harness.musicInfo,
          playMusicInfo: harness.playMusicInfo,
          playInfo: harness.playInfo,
        },
        '@renderer/store/setting': { appSetting: { 'player.autoSkipOnError': true, 'player.isSavePlayTime': false } },
        '@renderer/core/player': harness.actions,
        '@renderer/store/list/action': { updateListMusics() {} },
        '@renderer/store/listeningTime/action': { addCurrentListeningTime() {} },
      }).default
      usePlayProgress()

      appEvent.playerWaiting()
      timers.runNext(3000)
      appEvent.playerPlaying()
      assert.deepEqual(seeks, [
        [13, 'buffer_recovery', undefined],
        [13, 'buffer_recovery', undefined],
      ])
      assert.deepEqual(seekFacts, [
        { origin: 'buffer_recovery', fromMs: 10_000, toMs: 13_000 },
      ])

      playProgress.maxPlayTime = 13.5
      currentTime = 13
      appEvent.playerWaiting()
      timers.runNext(3000)
      await flushAsync()
      assert.deepEqual(advances, [{ automatic: true, reason: 'buffer_timeout' }])
    } finally {
      timers.restore()
      restoreConsole()
      global.window = previousWindow
      global.document = previousDocument
    }
  })

  it('emits queue removal before stopping and clearing an empty queue', async() => {
    const previousWindow = global.window
    const timers = installFakeTimers()
    const restoreConsole = muteExpectedConsoleOutput()
    const appEvent = createEventHub()
    const eventLog = []
    appEvent.on('playbackAdvance', options => eventLog.push(['playbackAdvance', options]))
    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: null },
      i18n: { t: value => value },
      app_event: appEvent,
    }

    try {
      const harness = loadPlayerActions({ list: [], eventLog })
      const useWatchList = loadTsModule(path.join(rendererRoot, 'core/useApp/usePlayer/useWatchList.ts'), {
        '@common/utils/vueTools': { onBeforeUnmount() {} },
        '@common/utils': { throttle: callback => callback },
        '@renderer/store/player/state': {
          playInfo: harness.playInfo,
          playMusicInfo: harness.playMusicInfo,
        },
        '@renderer/store/player/action': {
          updatePlayIndex: () => ({ playIndex: -1 }),
          setPlayMusicInfo: harness.setPlayMusicInfo,
        },
        '@renderer/core/player': harness.actions,
      }).default
      useWatchList()

      appEvent.myListUpdate(['list'])
      await flushAsync()
      await flushAsync()
      timers.runNext(0)
      timers.runNext(0)

      assert.deepEqual(eventLog, [
        ['playbackAdvance', { automatic: true, reason: 'queue_removed' }],
        ['setStop'],
        ['setPlayMusicInfo', null, null],
      ])
    } finally {
      timers.restore()
      restoreConsole()
      global.window = previousWindow
    }
  })

  it('preserves list and single-loop behavior based on automatic intent', async() => {
    const previousWindow = global.window
    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: null },
      i18n: { t: value => value },
      app_event: createEventHub(),
    }

    try {
      const automaticList = loadPlayerActions({ playMethod: 'list', playerIndex: 1 })
      await automaticList.actions.playNext({ automatic: true, reason: 'natural_end' })

      const manualList = loadPlayerActions({ playMethod: 'list', playerIndex: 1 })
      await manualList.actions.playNext()

      const automaticSingle = loadPlayerActions({ playMethod: 'singleLoop', playerIndex: 0 })
      await automaticSingle.actions.playNext({ automatic: true, reason: 'natural_end' })

      const manualSingle = loadPlayerActions({ playMethod: 'singleLoop', playerIndex: 0 })
      await manualSingle.actions.playNext()
      await flushAsync()
      await flushAsync()
      assert.deepEqual([
        automaticList.playMusicInfo.musicInfo.id,
        manualList.playMusicInfo.musicInfo.id,
        automaticSingle.playMusicInfo.musicInfo.id,
        manualSingle.playMusicInfo.musicInfo.id,
      ], ['second', 'first', 'first', 'second'])
    } finally {
      global.window = previousWindow
    }
  })

  it('carries restore seek time and duration through the real player action', async() => {
    const previousWindow = global.window
    const appEvent = createEventHub()
    const seeks = []
    appEvent.on('setProgress', (...args) => seeks.push(args))
    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: { time: 42, maxTime: 180, listId: 'list', index: 0 } },
      i18n: { t: value => value },
      app_event: appEvent,
    }

    try {
      const harness = loadPlayerActions()
      harness.actions.playList('list', 0)
      await flushAsync()
      assert.deepEqual(seeks, [[42, 'restore', 180]])
    } finally {
      global.window = previousWindow
    }
  })

  it('emits natural-end intent and hotkey seek origin from the real player lifecycle', async() => {
    const previousWindow = global.window
    const appEvent = createEventHub()
    const keyEvent = createEventHub()
    const advances = []
    const seeks = []
    appEvent.on('playbackAdvance', options => advances.push(options))
    appEvent.on('setProgress', (...args) => seeks.push(args))
    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: null },
      i18n: { t: value => value },
      app_event: appEvent,
      key_event: keyEvent,
    }

    try {
      const harness = loadPlayerActions()
      const noOpComposable = { __esModule: true, default: () => {} }
      const usePlayer = loadTsModule(path.join(rendererRoot, 'core/useApp/usePlayer/usePlayer.ts'), {
        '@common/utils/vueTools': { onBeforeUnmount() {}, watch() {} },
        '@renderer/plugins/i18n': { useI18n: () => value => value },
        '@renderer/utils': { setTitle() {} },
        '@renderer/plugins/player': {
          getCurrentTime: () => 10,
          getDuration: () => 100,
          setPause() {},
          setStop() {},
        },
        './useMediaSessionInfo': noOpComposable,
        './usePlaybackRecorder': noOpComposable,
        './usePlayProgress': noOpComposable,
        './usePlayEvent': noOpComposable,
        './useLyric': noOpComposable,
        './useVolume': noOpComposable,
        './useMaxOutputChannelCount': noOpComposable,
        './useSoundEffect': noOpComposable,
        './usePlaybackRate': noOpComposable,
        './useWatchList': noOpComposable,
        './usePreloadNextMusic': noOpComposable,
        '@renderer/store/player/state': {
          musicInfo: harness.musicInfo,
          playInfo: harness.playInfo,
          playMusicInfo: harness.playMusicInfo,
          playedList: [],
        },
        '@renderer/store/list/state': { tempListMeta: { id: 'temp' } },
        '@renderer/store/player/action': {
          setPlay() {},
          setAllStatus() {},
          addPlayedList() {},
          clearPlayedList() {},
        },
        '@renderer/store/recentPlay/action': { addRecentPlayMusic() {}, initRecentPlayList: async() => {} },
        '@renderer/store/listeningTime/action': { initListeningTimeStats: async() => {}, saveListeningTimeStatsNow() {} },
        '@renderer/store/setting': { appSetting: { 'player.togglePlayMethod': 'listLoop' } },
        '@common/hotKey': {
          HOTKEY_PLAYER: {
            next: { action: 'next' },
            prev: { action: 'prev' },
            toggle_play: { action: 'toggle' },
            music_love: { action: 'love' },
            music_unlove: { action: 'unlove' },
            music_dislike: { action: 'dislike' },
            seekbackward: { action: 'seekbackward' },
            seekforward: { action: 'seekforward' },
          },
        },
        '@renderer/core/player': harness.actions,
        '@renderer/core/player/utils': { setPowerSaveBlocker() {} },
        '@renderer/store/privateFm/action': { ensurePrivateFmNextSongs: async() => {}, syncPrivateFmModeWithPlayer() {} },
        '@renderer/store/qqGuessLike/action': { ensureQQGuessLikeNextSongs: async() => {}, syncQQGuessLikeModeWithPlayer() {} },
        '@renderer/store/qqBrushMode/action': { ensureQQBrushModeNextSongs: async() => {}, syncQQBrushModeWithPlayer() {} },
        '@renderer/store/qqMusic': { getQQMusicAccountKey: () => 'account', initQQMusicAccount: async() => {} },
      }).default
      usePlayer()

      keyEvent.emit('seekforward')
      appEvent.playerEnded()
      await flushAsync()
      await flushAsync()

      assert.deepEqual(seeks, [[15, 'hotkey', undefined]])
      assert.deepEqual(advances, [{ automatic: true, reason: 'natural_end' }])
    } finally {
      global.window = previousWindow
    }
  })

  it('carries party seek progress and duration through remote playback application', async() => {
    const previousWindow = global.window
    const appEvent = createEventHub()
    const seeks = []
    appEvent.on('setProgress', (...args) => seeks.push(args))
    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: null },
      i18n: { t: value => value },
      app_event: appEvent,
    }

    try {
      const harness = loadPlayerActions()
      harness.actions.playMusicByInfo(harness.first, { listId: 'list', isTempPlay: false })
      await flushAsync()
      const party = { room: null, selfClientId: 'self' }
      const playback = {
        currentMusic: harness.first,
        currentIndex: 0,
        queue: [{ musicInfo: harness.first }],
        playing: false,
        progress: 42000,
        progressAt: Date.now(),
        duration: 180000,
        rate: 1,
        version: 1,
        operator: { clientId: 'remote' },
      }
      const room = { roomId: 'room', playback }
      const useParty = loadTsModule(path.join(rendererRoot, 'core/useApp/useParty.ts'), {
        '@common/utils': { debounce: callback => callback },
        '@common/utils/vueTools': { onBeforeUnmount() {} },
        '@renderer/core/lyric': { setPlaybackRate() {} },
        '@renderer/core/player': harness.actions,
        '@renderer/plugins/player': { setCurrentTime() {}, setPlaybackRate() {} },
        '@renderer/core/party': {
          syncPartyPlayback: async() => {},
          canControlPartyPlayback: () => false,
          loadPartyState: async() => ({ room }),
        },
        '@renderer/store/player/playProgress': { playProgress: { nowPlayTime: 0, maxPlayTime: 180 } },
        '@renderer/store/player/playbackRate': { playbackRate: { value: 1 } },
        '@renderer/store/player/state': {
          isPlay: { value: false },
          playMusicInfo: harness.playMusicInfo,
        },
        '@renderer/store/party': {
          party,
          setPartyState: state => { party.room = state.room },
        },
        '@renderer/utils/ipc': { onPartyAction: () => () => {} },
      }).default
      const initializeParty = useParty()
      await initializeParty()

      assert.deepEqual(seeks, [[42, 'party', 180]])
    } finally {
      global.window = previousWindow
    }
  })

  it('emits bar seek origin from the real progress-bar interaction', () => {
    const previousWindow = global.window
    const previousDocument = global.document
    const appEvent = createEventHub()
    const seeks = []
    const documentListeners = new Map()
    appEvent.on('setProgress', (...args) => seeks.push(args))
    global.window = { app_event: appEvent }
    global.document = {
      addEventListener: (name, listener) => documentListeners.set(name, listener),
      removeEventListener() {},
    }

    try {
      const source = readRendererFile('components/common/ProgressBar.vue')
      const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1]
      assert.ok(script, 'ProgressBar.vue must contain a script block')
      const component = loadSourceModule(script, 'ProgressBar.vue', {
        '@common/utils/vueTools': { ref: value => ({ value }), onBeforeUnmount() {} },
        '@renderer/store/player/playProgress': { playProgress: { maxPlayTime: 120 } },
      }).default
      const controls = component.setup({})
      controls.dom_progress.value = { clientWidth: 100 }

      controls.handleMsDown({ clientX: 25, offsetX: 25 })
      documentListeners.get('mouseup')()

      assert.deepEqual(seeks, [[30, 'bar', undefined]])
    } finally {
      global.window = previousWindow
      global.document = previousDocument
    }
  })

  it('emits media-session origins from browser and taskbar seek controls', async() => {
    const previousWindow = global.window
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator')
    const previousAudio = global.Audio
    const previousMediaMetadata = global.MediaMetadata
    const appEvent = createEventHub()
    const seeks = []
    const mediaHandlers = new Map()
    const restoreConsole = muteExpectedConsoleOutput()
    let playerAction
    appEvent.on('setProgress', (...args) => seeks.push(args))

    class FakeAudio {
      play() { return Promise.resolve() }
      pause() {}
    }
    class FakeMediaMetadata {}

    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: null },
      i18n: { t: value => value },
      app_event: appEvent,
      MediaMetadata: FakeMediaMetadata,
    }
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: {
        mediaSession: {
          metadata: null,
          playbackState: 'none',
          setPositionState() {},
          setActionHandler: (name, handler) => mediaHandlers.set(name, handler),
        },
      },
    })
    global.Audio = FakeAudio
    global.MediaMetadata = FakeMediaMetadata

    try {
      const harness = loadPlayerActions()
      const state = {
        isPlay: { value: false },
        musicInfo: { id: 'first', name: 'First', singer: 'Singer', album: '', pic: '' },
        playMusicInfo: harness.playMusicInfo,
      }
      const progress = { nowPlayTime: 10, maxPlayTime: 120 }
      const useMediaSessionInfo = loadTsModule(path.join(rendererRoot, 'core/useApp/usePlayer/useMediaSessionInfo.ts'), {
        '@common/utils/vueTools': { onBeforeUnmount() {} },
        '@renderer/assets/medias/Silence02s.mp3': 'silence',
        '@renderer/plugins/player': { getDuration: () => 120, getPlaybackRate: () => 1, getCurrentTime: () => 10 },
        '@renderer/store/player/state': state,
        '@renderer/store/player/playProgress': { playProgress: progress },
        '@renderer/core/player': harness.actions,
      }).default
      const originalLoad = Module._load
      Module._load = (request, parent, isMain) => request === '@renderer/assets/medias/Silence02s.mp3'
        ? 'silence'
        : originalLoad(request, parent, isMain)
      try {
        useMediaSessionInfo()
      } finally {
        Module._load = originalLoad
      }
      mediaHandlers.get('seekto')({ seekTime: 48 })

      const usePlayStatus = loadTsModule(path.join(rendererRoot, 'core/useApp/usePlayer/usePlayStatus.ts'), {
        '@common/utils/vueTools': { onBeforeUnmount() {}, watch() {} },
        '@renderer/utils/ipc': {
          sendPlayerStatus() {},
          onPlayerAction: callback => {
            playerAction = callback
            return () => {}
          },
        },
        '@renderer/store/list/state': { loveList: { id: 'love' } },
        '@renderer/store/list/action': { addListMusics() {}, removeListMusics() {}, checkListExistMusic: async() => false },
        '@renderer/store/player/state': state,
        '@common/utils': { throttle: callback => callback },
        '@renderer/core/player': harness.actions,
        '@renderer/store/player/playProgress': { playProgress: progress },
        '@renderer/store/setting': { appSetting: { 'player.playbackRate': 1 } },
        '@renderer/store/player/lyric': { lyric: { lines: [] } },
      }).default
      usePlayStatus()
      await playerAction({ params: { action: 'seek', data: 999 } })

      assert.deepEqual(seeks, [
        [48, 'media_session', undefined],
        [120, 'media_session', undefined],
      ])
    } finally {
      global.window = previousWindow
      if (navigatorDescriptor) Object.defineProperty(global, 'navigator', navigatorDescriptor)
      else delete global.navigator
      global.Audio = previousAudio
      global.MediaMetadata = previousMediaMetadata
      restoreConsole()
    }
  })

  it('emits lyric seek origin from the real lyric interaction path', () => {
    const previousWindow = global.window
    const previousDocument = global.document
    const timers = installFakeTimers()
    const restoreConsole = muteExpectedConsoleOutput()
    const appEvent = createEventHub()
    const seeks = []
    appEvent.on('setProgress', (...args) => seeks.push(args))
    global.window = { app_event: appEvent }
    global.document = {
      elementFromPoint: () => ({
        tagName: 'DIV',
        time: 42000,
        classList: { contains: () => false },
      }),
      addEventListener() {},
      removeEventListener() {},
      createDocumentFragment: () => ({ appendChild() {} }),
    }

    try {
      const useLyric = loadTsModule(path.join(rendererRoot, 'utils/compositions/useLyric.js'), {
        '@common/utils/vueTools': {
          ref: value => ({ value }),
          onMounted() {},
          onBeforeUnmount() {},
          watch() {},
          nextTick: callback => callback(),
        },
        '@common/utils/common': { throttle: callback => callback, formatPlayTime2: String },
        '@common/utils/renderer': { scrollTo: () => () => {} },
        '@renderer/core/player/action': { play() {} },
        '@renderer/store/setting': { appSetting: { 'playDetail.isDelayScroll': false } },
      }).default
      const controls = useLyric({
        isPlay: { value: true },
        lyric: { lines: [], line: 0, offset: 0, tempOffset: 0 },
        playProgress: { maxPlayTime: 120 },
        isShowLyricProgressSetting: { value: true },
        offset: { value: 0 },
      })
      controls.dom_lyric.value = { scrollTop: 0 }
      controls.dom_skip_line.value = { getBoundingClientRect: () => ({ x: 1, y: 1 }) }

      controls.handleWheel({ deltaY: 0 })
      controls.handleSkipPlay()

      assert.deepEqual(seeks, [[42, 'lyric', undefined]])
    } finally {
      timers.restore()
      restoreConsole()
      global.window = previousWindow
      global.document = previousDocument
    }
  })

  it('carries automatic dislike intent through every dedicated dislike adapter', async() => {
    const previousWindow = global.window
    const appEvent = createEventHub()
    const advances = []
    appEvent.on('playbackAdvance', options => advances.push(options))
    global.window = {
      lx: { isPlayedStop: false, restorePlayInfo: null },
      i18n: { t: value => value },
      app_event: appEvent,
    }

    try {
      const modernHarness = loadPlayerActions()
      const modernSource = readRendererFile('components/layout/PlayBar/ModernBar.vue')
      const modernScript = modernSource.match(/<script>([\s\S]*?)<\/script>/)?.[1]
      assert.ok(modernScript, 'ModernBar.vue must contain a script block')
      const modernBar = loadSourceModule(modernScript, 'ModernBar.vue', {
        '@common/utils/vueTools': { ref: value => ({ value }), watch() {} },
        '@common/utils/vueRouter': { useRouter: () => ({ push: async() => {} }) },
        '@common/utils/electron': { clipboardWriteText() {} },
        './ControlBtns.vue': {},
        './PlayProgress.vue': {},
        '../PlayQueue.vue': {},
        '@renderer/utils/compositions/usePlayProgress': () => ({
          nowPlayTimeStr: { value: '' },
          maxPlayTimeStr: { value: '' },
          progress: { value: 0 },
          isActiveTransition: { value: false },
          handleTransitionEnd() {},
        }),
        '@renderer/store/player/state': {
          statusText: { value: '' },
          musicInfo: modernHarness.musicInfo,
          isShowPlayerDetail: { value: false },
          isPlay: { value: false },
          playInfo: modernHarness.playInfo,
          playMusicInfo: modernHarness.playMusicInfo,
        },
        '@renderer/store/player/action': { setMusicInfo() {}, setShowPlayerDetail() {} },
        '@renderer/core/player': modernHarness.actions,
        '@common/constants': { LIST_IDS: { DOWNLOAD: 'download' } },
        '@renderer/store/party': { party: { room: null } },
        '@renderer/store/privateFm/state': { isPrivateFmMode: { value: true } },
        '@renderer/utils/ipc': { trashNeteasePrivateFmMusic: async() => {} },
      }).default
      await modernBar.setup().handleTrashPrivateFmMusic()

      const onlineHarness = loadPlayerActions()
      const onlineActions = loadTsModule(path.join(rendererRoot, 'components/material/OnlineList/useMusicActions.js'), {
        '@common/utils/vueRouter': { useRouter: () => ({ push: async() => {} }) },
        '@renderer/utils/musicSdk': {},
        '@common/utils/electron': { openUrl() {} },
        '@renderer/utils': { toOldMusicInfo: value => value },
        '@renderer/core/dislikeList': { addDislikeInfo: async() => {}, hasDislike: () => true },
        '@renderer/core/player': onlineHarness.actions,
        '@renderer/store/player/state': { playMusicInfo: onlineHarness.playMusicInfo },
        '@renderer/plugins/Dialog': { dialog: { confirm: async() => true } },
        '@renderer/plugins/i18n': { useI18n: () => value => value },
      }).default({ props: { list: [onlineHarness.first] } })
      await onlineActions.handleDislikeMusic(0)
      await flushAsync()

      const listHarness = loadPlayerActions()
      const listActions = loadTsModule(path.join(rendererRoot, 'views/List/MusicList/useMusicActions.js'), {
        '@common/utils/vueRouter': { useRouter: () => ({ push: async() => {} }) },
        '@renderer/utils/musicSdk': {},
        '@common/utils/electron': { openUrl() {}, clipboardWriteText() {} },
        '@renderer/plugins/Dialog': { dialog: { confirm: async() => true } },
        '@renderer/plugins/i18n': { useI18n: () => value => value },
        '@renderer/store/list/action': { removeListMusics() {} },
        '@renderer/store/setting': { appSetting: { 'download.fileName': 'song' } },
        '@renderer/utils/index': { toOldMusicInfo: value => value },
        '@renderer/core/dislikeList': { addDislikeInfo: async() => {}, hasDislike: () => true },
        '@renderer/core/player': listHarness.actions,
        '@renderer/store/player/state': { playMusicInfo: listHarness.playMusicInfo },
      }).default({
        props: { listId: 'list' },
        list: { value: [listHarness.first] },
        selectedList: { value: [] },
        removeAllSelect() {},
      })
      await listActions.handleDislikeMusic(0)
      await flushAsync()

      const dailySongs = [
        { id: 'tx_one', source: 'tx', name: 'One', singer: 'Singer', meta: {} },
        { id: 'tx_two', source: 'tx', name: 'Two', singer: 'Singer', meta: {} },
        { id: 'tx_three', source: 'tx', name: 'Three', singer: 'Singer', meta: {} },
      ]
      const dailyHarness = loadPlayerActions({ list: [...dailySongs] })
      const tempListMeta = { id: null }
      const vueTools = {
        ref: value => ({ value }),
        shallowReactive: value => value,
        markRawList: value => value,
        toRaw: value => value,
      }
      const dailyState = loadTsModule(path.join(rendererRoot, 'store/qqDailyRecommend/state.ts'), {
        '@common/utils/vueTools': vueTools,
        '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
        '@renderer/store/player/state': { playInfo: dailyHarness.playInfo },
        '@renderer/store/list/state': { tempListMeta },
      })
      const dailyAction = loadTsModule(path.join(rendererRoot, 'store/qqDailyRecommend/action.ts'), {
        '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
        '@common/utils/vueTools': vueTools,
        '@renderer/core/player': dailyHarness.actions,
        '@renderer/store/list/action': {
          getListMusicsFromCache: () => dailyHarness.list,
          setTempList: async(id, songs) => {
            tempListMeta.id = id
            dailyHarness.list.splice(0, dailyHarness.list.length, ...songs)
          },
        },
        '@renderer/store/list/state': { tempListMeta },
        '@renderer/store/player/action': { clearPlayedList() {} },
        '@renderer/store/player/state': {
          playInfo: dailyHarness.playInfo,
          playMusicInfo: dailyHarness.playMusicInfo,
        },
        '@renderer/store/qqMusic': { getQQMusicAccountKey: () => 'A' },
        '@renderer/utils/ipc': {
          dislikeQQMusic: async() => {},
          getQQMusicDailyRecommendSongs: async() => dailySongs,
        },
        './state': dailyState,
      })
      await dailyAction.prepareQQDailyRecommend('A')
      const priorAdapterCount = advances.length
      await dailyAction.playQQDailyRecommend('A', 1)
      advances.splice(priorAdapterCount)
      const snapshot = dailyAction.getQQDailyRecommendFeedbackSnapshot(dailySongs[1], 'A')
      assert.ok(snapshot)
      assert.equal(await dailyAction.dislikeQQDailyRecommendMusic(dailySongs[1], snapshot), true)
      await flushAsync()
      await flushAsync()

      assert.deepEqual(advances, [
        { automatic: true, reason: 'dislike' },
        { automatic: true, reason: 'dislike' },
        { automatic: true, reason: 'dislike' },
        { automatic: true, reason: 'dislike' },
      ])
    } finally {
      global.window = previousWindow
    }
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
