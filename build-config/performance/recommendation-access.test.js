const assert = require('node:assert/strict')
const test = require('node:test')
const vue = require('vue')
const { EventEmitter } = require('node:events')
const { loadTs, deferred, tick } = require('./download-harness')

const featurePolicy = { getFeatureMode: (settings, feature) => settings['performance.features.' + feature] ?? 'onDemand' }
const mainHarness = () => {
  const settings = { 'performance.features.qqRecommend': 'onDemand', 'performance.features.neteaseRecommend': 'onDemand' }
  const sender = Object.assign(new EventEmitter(), { mainFrame: {} })
  const event = { sender, senderFrame: sender.mainFrame }
  const api = loadTs('src/main/services/recommendationSessions.ts', {
    '@common/performance/featurePolicy': featurePolicy,
    '@main/modules/winMain/main': { getWebContents: () => sender, isRendererAlive: () => true },
  }, { global: { lx: { appSetting: settings } } })
  return { api, settings, event }
}

test('off blocks page requests and new sessions while registered continuations survive', () => {
  const h = mainHarness()
  h.api.handleRecommendationSession('qqRecommend', 'guessLike', h.event, { featureSession: 'start' })
  h.settings['performance.features.qqRecommend'] = 'off'
  assert.throws(() => h.api.assertRecommendationRequest('qqRecommend', h.event), /disabled/)
  assert.throws(() => h.api.handleRecommendationSession('qqRecommend', 'brush', h.event, { featureSession: 'start' }), /disabled/)
  h.api.assertRecommendationRequest('qqRecommend', h.event, 'guessLike')
  h.api.handleRecommendationSession('qqRecommend', 'guessLike', h.event, { featureSession: 'end' })
  assert.throws(() => h.api.assertRecommendationRequest('qqRecommend', h.event, 'guessLike'), /disabled/)
})

test('session markers validate sender frame and exact marker shape', () => {
  const h = mainHarness()
  assert.throws(() => h.api.handleRecommendationSession('qqRecommend', 'guessLike', { ...h.event, senderFrame: {} }, { featureSession: 'start' }), /Untrusted/)
  assert.throws(() => h.api.handleRecommendationSession('qqRecommend', 'guessLike', h.event, { featureSession: 'start', continuation: true }), /Invalid/)
  assert.throws(() => h.api.handleRecommendationSession('qqRecommend', 'guessLike', h.event, { featureSession: 'unknown' }), /Invalid/)
})

test('a full renderer navigation revokes old playback sessions', () => {
  const h = mainHarness()
  h.api.handleRecommendationSession('neteaseRecommend', 'fm', h.event, { featureSession: 'start' })
  h.settings['performance.features.neteaseRecommend'] = 'off'
  h.event.sender.emit('did-start-navigation', {}, 'file:///app#settings', true, true)
  h.api.assertRecommendationRequest('neteaseRecommend', h.event, 'fm')
  h.event.sender.emit('did-start-navigation', {}, 'file:///app', false, true)
  assert.throws(() => h.api.assertRecommendationRequest('neteaseRecommend', h.event, 'fm'), /disabled/)
})

const rendererHarness = () => {
  const settings = vue.reactive({ 'performance.features.qqRecommend': 'onDemand', 'performance.features.neteaseRecommend': 'onDemand', 'performance.features.kugouRecommend': 'onDemand', 'recommend.qqGuessLikeApiVersion': 'new' })
  const markers = []
  const api = loadTs('src/renderer/core/features/recommendationAccess.ts', {
    vue,
    '@common/performance/featurePolicy': featurePolicy,
    '@renderer/store/setting': { appSetting: settings },
    '@common/rendererIpc': { rendererInvoke: async(channel, params) => { markers.push({ channel, params }); return [] } },
    '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: { netease_get_private_fm: 'fm', qq_music_get_guess_like_songs: 'qq' } },
  })
  return { api, settings, markers }
}

test('QQ page drops late results across disable/re-enable and clears reusable page cache', async() => {
  const h = rendererHarness()
  const response = deferred()
  let calls = 0
  const { useQQHomeRecommendData } = loadTs('src/renderer/views/QQRecommend/useQQHomeRecommendData.ts', {
    '@common/utils/vueTools': vue,
    '@renderer/store/qqMusic': { initQQMusicAccount: async() => {} },
    '@renderer/utils/ipc': { getQQMusicHomeRecommendation: async() => { calls++; return response.promise } },
    '@renderer/core/features/recommendationAccess': h.api,
  })
  const scope = vue.effectScope()
  const page = scope.run(() => useQQHomeRecommendData({ accountKey: vue.ref('account') }))
  const pending = page.load()
  h.settings['performance.features.qqRecommend'] = 'off'
  await page.load(true)
  assert.equal(calls, 1)
  h.settings['performance.features.qqRecommend'] = 'onDemand'
  response.resolve({ relatedSongs: [] }); await pending
  assert.equal(page.data.value, null)
  await page.load()
  assert.equal(calls, 2)
  scope.stop()
  assert.equal(page.data.value, null)
})

for (const kind of ['GuessLike', 'BrushMode']) {
  test(`QQ ${kind} preserves active continuation while off and denies a new session`, async() => {
    const h = rendererHarness()
    const brush = kind == 'BrushMode'
    const folder = brush ? 'qqBrushMode' : 'qqGuessLike'
    const state = loadTs(`src/renderer/store/${folder}/state.ts`, { '@common/utils/vueTools': vue })
    const playInfo = { playerListId: 'temp' }; const playMusicInfo = { musicInfo: null }; const tempListMeta = { id: '' }
    const calls = []
    const constants = { QQ_GUESS_LIKE_TEMP_LIST_ID: 'guess', QQ_BRUSH_MODE_TEMP_LIST_ID: 'brush' }
    const ipc = async continuation => { calls.push(continuation); return [{ id: calls.length == 1 ? 'one' : 'two', meta: {} }] }
    const actions = loadTs(`src/renderer/store/${folder}/action.ts`, {
      '@common/utils/vueTools': { ...vue, markRawList: list => list }, '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
      '@renderer/core/player': { playList() {} }, '@renderer/store/list/action': { setTempList: async id => { tempListMeta.id = id } },
      '@renderer/store/list/state': { tempListMeta }, '@renderer/store/player/action': { clearPlayedList() {} },
      '@renderer/store/player/state': { playInfo, playMusicInfo }, '@renderer/store/setting': { appSetting: h.settings },
      '@renderer/utils/ipc': { getQQMusicGuessLikeSongs: ipc, getQQMusicBrushSongs: ipc },
      '@renderer/views/Recommend/constants': constants, './state': state,
      '@renderer/core/features/recommendationAccess': h.api,
    })
    const enter = actions[brush ? 'enterQQBrushMode' : 'enterQQGuessLikeMode']
    await enter('account')
    playMusicInfo.musicInfo = { id: 'one', meta: {} }
    h.settings['performance.features.qqRecommend'] = 'off'
    await actions[brush ? 'ensureQQBrushModeNextSongs' : 'ensureQQGuessLikeNextSongs']('account')
    assert.deepEqual(calls, [false, true])
    assert.equal(state[brush ? 'isQQBrushMode' : 'isQQGuessLikeMode'].value, true)
    playInfo.playerListId = 'library'
    actions[brush ? 'syncQQBrushModeWithPlayer' : 'syncQQGuessLikeModeWithPlayer']('account')
    await tick()
    await assert.rejects(enter('account'), /disabled/)
    assert.equal(h.markers.filter(item => item.params.featureSession == 'start').length, 1)
    assert.equal(h.markers.filter(item => item.params.featureSession == 'end').length, 1)
  })
}

test('NetEase and Kugou pages discard pending responses when disabled', async() => {
  for (const provider of ['netease', 'kugou']) {
    const h = rendererHarness()
    const response = deferred()
    let calls = 0
    const request = async() => { calls++; return response.promise }
    const scope = vue.effectScope()
    if (provider == 'netease') {
      const { useRecommendData } = loadTs('src/renderer/views/Recommend/useRecommendData.ts', {
        '@common/utils/vueTools': vue,
        '@renderer/utils/ipc': { getNeteaseRecommendPlaylists: request },
        '@renderer/store/netease': { isLoggedIn: vue.ref(false) }, '@renderer/store/setting': { appSetting: h.settings },
        '@renderer/store/privateFm/state': { isPrivateFmMode: vue.ref(false) }, '@renderer/store/privateFm/action': {}, '@renderer/store/dailyRecommend/action': {},
        './constants': { RECOMMEND_CACHE_TTL: 10000, EXPLORE_PLAYLIST_LIMIT: 30 }, '@renderer/core/features/recommendationAccess': h.api,
      })
      const page = scope.run(() => useRecommendData({ accountKey: vue.ref('account'), isExploreMode: vue.ref(true), playlistScrollRef: vue.ref(null), onHomeSongsUpdated() {} }))
      const pending = page.loadRecommendPlaylists()
      h.settings['performance.features.neteaseRecommend'] = 'off'
      await page.loadRecommendPlaylists(true)
      response.resolve([{ id: 'late' }]); await pending
      assert.equal(page.recommendPlaylists.value.length, 0)
    } else {
      const { useKugouRecommendData } = loadTs('src/renderer/views/KugouRecommend/useKugouRecommendData.ts', {
        '@common/utils/vueTools': { ...vue, onBeforeUnmount() {} }, '@common/kugouMusic': { isKugouAuthError: () => false },
        '@renderer/store/kugouMusic': {}, '@renderer/utils/ipc': { getKugouPublicRecommendation: request },
        '@renderer/core/features/recommendationAccess': h.api,
      })
      const page = scope.run(() => useKugouRecommendData({ accountKey: vue.ref(null) }))
      const pending = page.loadPublicRecommendation()
      h.settings['performance.features.kugouRecommend'] = 'off'
      await page.loadPublicRecommendation(true)
      response.resolve({ playlists: [{ id: 'late' }], ranks: [] }); await pending
      assert.equal(page.publicRecommendation.value, null)
    }
    assert.equal(calls, 1)
    scope.stop()
  }
})

test('NetEase FM survives disable, stops its session on exit and cannot start a new one', async() => {
  const h = rendererHarness()
  const state = loadTs('src/renderer/store/privateFm/state.ts', { '@common/utils/vueTools': vue })
  const playInfo = { playerListId: 'temp' }; const playMusicInfo = { musicInfo: { id: 'one' } }; const tempListMeta = { id: '' }
  const requests = []
  const actions = loadTs('src/renderer/store/privateFm/action.ts', {
    '@common/utils/vueTools': { ...vue, markRawList: value => value }, '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
    '@renderer/store/player/state': { playInfo, playMusicInfo }, '@renderer/store/player/action': { clearPlayedList() {} },
    '@renderer/core/player': { playList() {} }, '@renderer/store/list/action': { setTempList: async id => { tempListMeta.id = id } },
    '@renderer/store/list/state': { tempListMeta }, '@renderer/utils/ipc': { getNeteasePrivateFm: async params => { requests.push(params.continuation); return [{ id: requests.length == 1 ? 'one' : 'two', meta: {} }] } },
    './state': state, '@renderer/core/features/recommendationAccess': h.api,
  })
  await actions.enterPrivateFmMode()
  h.settings['performance.features.neteaseRecommend'] = 'off'
  await actions.ensurePrivateFmNextSongs()
  assert.deepEqual(requests, [false, true])
  assert.equal(state.privateFmQueue.length, 2)
  actions.exitPrivateFmMode(); await tick()
  assert.equal(state.privateFmQueue.length, 0)
  await assert.rejects(actions.enterPrivateFmMode(), /disabled/)
  assert.equal(requests.length, 2)
})

test('restored active FM registers its session before asking for continuation', async() => {
  const h = rendererHarness()
  const state = loadTs('src/renderer/store/privateFm/state.ts', { '@common/utils/vueTools': vue })
  state.isPrivateFmMode.value = true
  state.privateFmQueue.push({ id: 'one', meta: {} })
  const actions = loadTs('src/renderer/store/privateFm/action.ts', {
    '@common/utils/vueTools': { ...vue, markRawList: value => value }, '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
    '@renderer/store/player/state': { playInfo: { playerListId: 'temp' }, playMusicInfo: { musicInfo: { id: 'one' } } },
    '@renderer/store/player/action': {}, '@renderer/core/player': {}, '@renderer/store/list/action': { setTempList: async() => {} },
    '@renderer/store/list/state': { tempListMeta: { id: state.PRIVATE_FM_TEMP_LIST_ID } },
    '@renderer/utils/ipc': { getNeteasePrivateFm: async params => {
      assert.equal(h.markers.at(-1).params.featureSession, 'start')
      assert.equal(params.continuation, true)
      return [{ id: 'two' }]
    } },
    './state': state, '@renderer/core/features/recommendationAccess': h.api,
  })
  await actions.ensurePrivateFmNextSongs()
  assert.equal(state.privateFmQueue.length, 2)
})

test('daily recommendation results cannot refill a cache after disable/re-enable', async() => {
  const h = rendererHarness()
  const response = deferred()
  const state = { dailyRecommendSongs: [], isLoadingDailyRecommend: vue.ref(false) }
  let requests = 0
  const actions = loadTs('src/renderer/store/dailyRecommend/action.ts', {
    '@common/utils/vueTools': { ...vue, markRawList: value => value }, '@common/constants': {},
    '@renderer/store/player/action': {}, '@renderer/core/player': {}, '@renderer/store/list/action': {},
    '@renderer/utils/ipc': { getNeteaseRecommendSongs: async() => { requests++; return response.promise } },
    './state': state, '@renderer/core/features/recommendationAccess': h.api,
  })
  const pending = actions.loadDailyRecommendSongs()
  h.settings['performance.features.neteaseRecommend'] = 'off'
  await actions.loadDailyRecommendSongs(true)
  await assert.rejects(actions.playDailyRecommend(), /disabled/)
  h.settings['performance.features.neteaseRecommend'] = 'onDemand'
  response.resolve([{ id: 'late' }]); await pending
  assert.equal(state.dailyRecommendSongs.length, 0)
  assert.equal(requests, 1)
})

test('disable during a session registration revokes the marker and never reports active playback', async() => {
  const settings = vue.reactive({ 'performance.features.qqRecommend': 'onDemand' })
  const response = deferred(); const markers = []
  const api = loadTs('src/renderer/core/features/recommendationAccess.ts', {
    vue, '@common/performance/featurePolicy': featurePolicy,
    '@renderer/store/setting': { appSetting: settings },
    '@common/rendererIpc': { rendererInvoke: async(_channel, params) => { markers.push(params.featureSession); if (params.featureSession == 'start') await response.promise } },
    '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: {} },
  })
  const starting = api.beginRecommendationSession('qqGuessLike')
  settings['performance.features.qqRecommend'] = 'off'
  response.resolve()
  await assert.rejects(starting, /disabled/)
  assert.deepEqual(markers, ['start', 'end'])
  assert.equal(api.recommendationPlaybackActive.qqRecommend, false)
})

for (const [folder, enterName, activeName, session, feature] of [
  ['qqGuessLike', 'enterQQGuessLikeMode', 'isQQGuessLikeMode', 'qqGuessLike', 'qqRecommend'],
  ['qqBrushMode', 'enterQQBrushMode', 'isQQBrushMode', 'qqBrush', 'qqRecommend'],
  ['privateFm', 'enterPrivateFmMode', 'isPrivateFmMode', 'neteaseFm', 'neteaseRecommend'],
]) {
  const activationHarness = install => {
    const h = rendererHarness()
    const state = loadTs(`src/renderer/store/${folder}/state.ts`, { '@common/utils/vueTools': vue })
    const songs = async() => [{ id: 'one', meta: {} }]
    let plays = 0
    const actions = loadTs(`src/renderer/store/${folder}/action.ts`, {
      '@common/utils/vueTools': { ...vue, markRawList: list => list }, '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
      '@renderer/core/player': { playList() { plays++ } },
      '@renderer/store/list/action': { setTempList: install },
      '@renderer/store/list/state': { tempListMeta: { id: 'previous' } },
      '@renderer/store/player/action': { clearPlayedList() {} }, '@renderer/store/player/state': { playInfo: {}, playMusicInfo: {} },
      '@renderer/store/setting': { appSetting: h.settings },
      '@renderer/utils/ipc': { getQQMusicGuessLikeSongs: songs, getQQMusicBrushSongs: songs, getNeteasePrivateFm: songs },
      '@renderer/views/Recommend/constants': {}, './state': state,
      '@renderer/core/features/recommendationAccess': h.api,
    })
    return { ...h, state, actions, get plays() { return plays } }
  }
  test(`${folder} revokes a newly registered session when playlist installation fails`, async() => {
    const h = activationHarness(async() => { throw new Error('disk write failed') })
    await assert.rejects(h.actions[enterName]('account'), /disk write failed/)
    assert.equal(h.api.hasRecommendationSession(session), false)
    assert.equal(h.api.recommendationPlaybackActive[feature], false)
    assert.equal(h.state[activeName].value, false)
    assert.equal(h.plays, 0)
    assert.deepEqual(h.markers.map(item => item.params.featureSession), ['start', 'end'])
  })
  test(`${folder} finishes an acknowledged playback activation when disabled during its playlist write`, async() => {
    const installation = deferred()
    const started = deferred()
    const h = activationHarness(async() => { started.resolve(); await installation.promise })
    const pending = h.actions[enterName](folder == 'privateFm' ? 0 : 'account')
    await started.promise
    h.settings['performance.features.' + feature] = 'off'
    installation.resolve()
    await pending
    assert.equal(h.api.hasRecommendationSession(session), true)
    assert.equal(h.state[activeName].value, true)
    assert.equal(h.plays, 1)
    await assert.rejects(h.actions[enterName]('account'), /disabled/)
  })
}

test('main IPC gates page-only endpoints while preserving account and core music requests', async() => {
  for (const [provider, feature, pageChannel] of [
    ['netease', 'neteaseRecommend', 'netease_get_home_recommendation'],
    ['qqMusic', 'qqRecommend', 'qq_music_get_home_recommendation'],
    ['kugouMusic', 'kugouRecommend', 'kugou_music_get_public_recommendation'],
  ]) {
    const h = mainHarness()
    h.settings['performance.features.' + feature] = 'off'
    const handlers = new Map(); const calls = []
    const providerApi = new Proxy({}, { get: (_target, name) => async() => { calls.push(name); return [] } })
    const { default: init } = loadTs(`src/main/modules/winMain/rendererEvent/${provider}.ts`, {
      '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: new Proxy({}, { get: (_target, name) => name }) },
      '@common/mainIpc': { mainHandle: (name, callback) => handlers.set(name, callback) },
      ['@main/modules/' + provider]: providerApi, '@main/services/recommendationSessions': h.api,
    }, { global: { lx: { event_app: { on() {} } } } })
    init()
    await assert.rejects(handlers.get(pageChannel)({ event: h.event, params: {} }), /disabled/)
    assert.equal(calls.length, 0)
    const accountChannel = provider == 'netease' ? 'netease_get_account_status' : provider == 'qqMusic' ? 'qq_music_get_account_status' : 'kugou_music_get_account_status'
    await handlers.get(accountChannel)({ event: h.event })
    assert.equal(calls[0], 'getAccountStatus')
    if (provider == 'netease') {
      await handlers.get('netease_get_music_url')({ event: h.event, params: {} })
      assert.equal(calls[1], 'getMusicUrl')
    }
  }
})
