const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const typescript = require('typescript')
const { compileFunction } = require('node:vm')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })
  return { promise, resolve, reject }
}

const summary = (kind, sourceListId, accountKey = '42', overrides = {}) => ({
  provider: 'netease',
  kind,
  id: sourceListId,
  sourceListId,
  accountKey,
  name: `${kind} ${sourceListId}`,
  coverUrl: 'https://example.com/cover.jpg',
  ...overrides,
})

const createHarness = () => {
  const modules = new Map()
  const dbLists = new Map()
  const dbSongs = new Map()
  const detailRequests = []
  const details = { get: async id => [{ id: `song-${id}`, source: 'wy', name: `Song ${id}` }] }
  const metadata = {}
  const settings = {}
  const accounts = {
    netease: { value: { isLoggedIn: true, profile: { userId: 42 } } },
    qq_music: { value: { isLoggedIn: false, profile: null } },
    kugou: { value: { isLoggedIn: false, profile: null } },
  }
  const requests = { netease: 0, qq_music: 0, kugou: 0 }
  const responses = { netease: async() => [], qq_music: async() => [], kugou: async() => [] }
  const beforeListWrite = { add: async() => {}, update: async() => {} }
  const ipcEvents = []
  const identity = value => value
  const doubles = {
    '@common/utils/vueTools': {
      reactive: identity,
      markRaw: identity,
      markRawList: identity,
      toRaw: identity,
      computed: getter => ({ get value() { return getter() } }),
    },
    '@common/constants': { LIST_IDS: { DEFAULT: 'default', LOVE: 'love', TEMP: 'temp', WEBDAV: 'webdav' } },
    '@common/utils': { log: { error() {} }, throttle: identity },
    '@renderer/utils/index': { dateFormat: String },
    '@renderer/store/list/action': {
      setUpdateTime() {},
      setFetchingListStatus() {},
      overwriteListMusics: async data => load('src/renderer/store/list/listManage/rendererListManage.ts').overwriteListMusics(data),
    },
    '@common/utils/common': { dateFormat: String },
    '@renderer/utils': { toMD5: value => require('node:crypto').createHash('md5').update(value).digest('hex') },
    '@renderer/store/songList/action': {
      getListDetailAll: async(id, source, refresh) => {
        detailRequests.push({ id, source, refresh })
        return details.get(id)
      },
    },
    '@renderer/store/setting': { appSetting: settings },
    '@renderer/store/netease': { accountStatus: accounts.netease },
    '@renderer/store/qqMusic': { accountStatus: accounts.qq_music },
    '@renderer/store/kugouMusic': { accountStatus: accounts.kugou },
    '@renderer/utils/ipc': Object.fromEntries([
      ['netease', 'getNeteaseUserPlaylists'], ['qq_music', 'getQQMusicUserPlaylists'], ['kugou', 'getKugouUserPlaylists'],
    ].map(([provider, name]) => [name, async() => {
      requests[provider]++
      return responses[provider]()
    }])),
    '@renderer/utils/storageState': {
      getPlaylistMetadata: async() => structuredClone(metadata),
      getLocalState: async() => ({ listScrollPosition: {} }),
      setLocalState: async() => {},
      mutatePlaylistMetadata: async input => {
        const command = load('src/common/storage/stateValidation.ts').parsePlaylistMetadataCommand(input)
        if (command.action == 'upsert') metadata[command.playlistId] = command.value
        else if (command.action == 'remove') delete metadata[command.playlistId]
        else {
          for (const id of Object.keys(metadata)) {
            if (!command.playlistIds.includes(id)) delete metadata[id]
          }
        }
        return structuredClone(metadata)
      },
    },
    '@common/rendererIpc': {
      rendererOn() {},
      rendererOff() {},
      rendererInvoke: async(event, data) => {
        ipcEvents.push(event)
        const names = load('src/common/ipcNames.ts').PLAYER_EVENT_NAME
        const local = load('src/renderer/store/list/listManage/action.ts')
        if (event == names.list_get) return [...dbLists.values()].map(info => ({ ...info }))
        if (event == names.list_add) {
          await beforeListWrite.add()
          for (const info of data.listInfos) {
            assert.equal(dbLists.has(info.id), false, 'database list IDs must be unique')
            dbLists.set(info.id, { ...info })
            local.userListCreate({ ...info, position: data.position })
          }
        } else if (event == names.list_update) {
          await beforeListWrite.update()
          for (const info of data) {
            assert.ok(dbLists.has(info.id), 'updated list must have been persisted')
            dbLists.set(info.id, { ...info })
          }
          local.userListsUpdate(data)
        } else if (event == names.list_remove) {
          for (const id of data) dbLists.delete(id)
          local.userListsRemove(data)
        } else if (event == names.list_music_overwrite) {
          assert.ok(dbLists.has(data.listId), 'songs require a persisted playlist')
          dbSongs.set(data.listId, structuredClone(data.musicInfos))
        } else throw new Error(`Unexpected list IPC: ${event}`)
      },
    },
  }

  function load(relativePath) {
    const filename = path.resolve(root, relativePath)
    if (modules.has(filename)) return modules.get(filename).exports
    const mod = { exports: {} }
    modules.set(filename, mod)
    const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
      fileName: filename,
    }).outputText
    const requireModule = request => {
      if (doubles[request]) return doubles[request]
      let resolved
      if (request.startsWith('@')) resolved = path.join(root, 'src', request.slice(1))
      else if (request.startsWith('.')) resolved = path.resolve(path.dirname(filename), request)
      else return require(request)
      if (resolved == path.join(root, 'src/renderer/store/list/action')) return doubles['@renderer/store/list/action']
      if (resolved == path.join(root, 'src/renderer/utils/index')) return doubles['@renderer/utils/index']
      if (fs.existsSync(`${resolved}.ts`)) return load(`${resolved}.ts`)
      return load(path.join(resolved, 'index.ts'))
    }
    // Run production modules in this realm so strict storage validation checks real object prototypes.
    compileFunction(output, ['require', 'module', 'exports'], { filename })(requireModule, mod, mod.exports)
    return mod.exports
  }

  const action = load('src/renderer/store/platformPlaylists/action.ts')
  const reconcile = load('src/renderer/store/platformPlaylists/reconcile.ts')
  const lists = load('src/renderer/store/list/listManage/state.ts').userLists
  const seed = (...summaries) => {
    for (const item of summaries) {
      const id = `platform:${item.provider}:${item.accountKey}:${item.kind}:${item.sourceListId}`
      const info = { id, name: item.name, source: 'wy', sourceListId: item.sourceListId, locationUpdateTime: null }
      dbLists.set(id, info)
      lists.push({ ...info })
      metadata[id] = {
        updateTime: 0,
        isAutoUpdate: false,
        profile: { managed: true, provider: item.provider, accountKey: item.accountKey, kind: item.kind },
      }
    }
  }
  return { ...action, ...reconcile, accounts, settings, requests, responses, dbLists, dbSongs, details, detailRequests, metadata, lists, seed, ipcEvents, beforeListWrite }
}

test('confirmed playlist IDs import songs through the existing online playlist detail and persistence path', async() => {
  const h = createHarness()
  h.responses.netease = async() => [summary('created', '1'), summary('collected', '2')]
  await h.refreshPlatformUserPlaylists()
  assert.deepEqual(h.detailRequests.map(({ id, source }) => ({ id, source })), [{ id: '1', source: 'wy' }, { id: '2', source: 'wy' }])
  assert.deepEqual(h.dbSongs.get('platform:netease:42:created:1'), [{ id: 'song-1', source: 'wy', name: 'Song 1' }])
  assert.deepEqual(h.dbSongs.get('platform:netease:42:collected:2'), [{ id: 'song-2', source: 'wy', name: 'Song 2' }])
  assert.ok(h.metadata['platform:netease:42:created:1'].updateTime > 0)
})

test('one failed song import retains cached songs and continues other playlists, reporting the affected kind', async() => {
  const h = createHarness()
  h.seed(summary('created', '1'))
  h.dbSongs.set('platform:netease:42:created:1', [{ id: 'cached-song' }])
  h.responses.netease = async() => [summary('created', '1'), summary('collected', '2')]
  h.details.get = async id => {
    if (id == '1') throw new Error('playlist unavailable')
    return [{ id: 'song-2' }]
  }
  await h.refreshPlatformUserPlaylists()
  assert.deepEqual(h.dbSongs.get('platform:netease:42:created:1'), [{ id: 'cached-song' }])
  assert.deepEqual(h.dbSongs.get('platform:netease:42:collected:2'), [{ id: 'song-2' }])
  assert.equal(h.platformPlaylistStatuses['netease:created'].status, 'partial')
  assert.match(h.platformPlaylistStatuses['netease:created'].errorMessage, /playlist unavailable/)
  assert.equal(h.platformPlaylistStatuses['netease:collected'].status, 'ready')
})

test('22 recognized playlists with one inaccessible detail report one song failure, not a directory failure', async() => {
  const h = createHarness()
  h.responses.netease = async() => Array.from({ length: 22 }, (_, i) => summary('collected', String(i + 1)))
  h.details.get = async id => {
    if (id == '22') throw new Error('Private playlist (401)')
    return [{ id: `song-${id}` }]
  }
  await h.refreshPlatformUserPlaylists()
  const group = h.platformPlaylistStatuses['netease:collected']
  assert.equal(group.lists.length, 22)
  assert.equal(h.dbSongs.size, 21)
  assert.equal(group.status, 'partial')
  assert.ok(group.lastDirectorySuccessAt > 0)
  assert.equal(group.errorStage, undefined)
  assert.deepEqual(group.failures, [{ listId: 'platform:netease:42:collected:22', sourceListId: '22', name: 'collected 22', kind: 'collected', message: 'Private playlist (401)', hasCache: false }])
  assert.deepEqual(h.getPlatformPlaylistFailure('platform:netease:42:collected:22'), group.failures[0])
})

test('song retry leaves successful lists untouched and clears a recovered failure without fetching the directory', async() => {
  const h = createHarness()
  h.responses.netease = async() => [summary('created', '1'), summary('collected', '2'), summary('collected', '3')]
  h.details.get = async id => {
    if (id == '2') throw new Error('offline')
    return [{ id: `song-${id}` }]
  }
  await h.refreshPlatformUserPlaylists()
  h.detailRequests.length = 0
  h.details.get = async id => [{ id: `recovered-${id}` }]
  await h.retryPlatformUserPlaylistGroup('netease', 'collected')
  assert.deepEqual(h.detailRequests.map(request => request.id), ['2'])
  assert.equal(h.requests.netease, 1)
  assert.equal(h.dbLists.size, 3)
  assert.deepEqual(h.dbSongs.get('platform:netease:42:collected:3'), [{ id: 'song-3' }])
  assert.deepEqual(h.dbSongs.get('platform:netease:42:collected:2'), [{ id: 'recovered-2' }])
  assert.equal(h.platformPlaylistStatuses['netease:collected'].status, 'ready')
  assert.deepEqual(h.platformPlaylistStatuses['netease:collected'].failures, [])
  assert.equal(h.getPlatformPlaylistFailure('platform:netease:42:collected:2'), undefined)
})

test('failed refresh and retry preserve previously imported songs and identify that a cache is available', async() => {
  const h = createHarness()
  h.responses.netease = async() => [summary('collected', '1')]
  await h.refreshPlatformUserPlaylists()
  const previousSync = h.metadata['platform:netease:42:collected:1'].updateTime
  h.details.get = async() => { throw new Error('temporarily unavailable') }
  await h.refreshPlatformUserPlaylists()
  await h.retryPlatformUserPlaylistGroup('netease', 'collected')
  const group = h.platformPlaylistStatuses['netease:collected']
  assert.equal(group.status, 'partial')
  assert.equal(group.failures[0].hasCache, true)
  assert.deepEqual(h.dbSongs.get('platform:netease:42:collected:1'), [{ id: 'song-1', source: 'wy', name: 'Song 1' }])
  assert.equal(h.metadata['platform:netease:42:collected:1'].updateTime, previousSync)
})

test('directory failure retains cached song failures and cannot be reported as a successful index refresh', async() => {
  const h = createHarness()
  h.responses.netease = async() => [summary('collected', '1')]
  h.details.get = async() => { throw new Error('private') }
  await h.refreshPlatformUserPlaylists()
  const group = h.platformPlaylistStatuses['netease:collected']
  const previousIndexSync = group.lastDirectorySuccessAt
  h.responses.netease = async() => { throw new Error('directory offline') }
  await h.refreshPlatformUserPlaylists()
  assert.equal(group.status, 'error')
  assert.equal(group.errorStage, 'directory')
  assert.equal(group.lists.length, 1)
  assert.equal(group.failures.length, 1)
  assert.equal(group.lastDirectorySuccessAt, previousIndexSync)
})

test('directory and song errors show the upstream reason without Electron IPC implementation details', async() => {
  const h = createHarness()
  h.responses.netease = async() => { throw new Error("Error invoking remote method 'winMain_netease_get_user_playlist_summaries': Error: Login expired") }
  await h.refreshPlatformUserPlaylists()
  assert.equal(h.platformPlaylistStatuses['netease:collected'].errorMessage, 'Login expired')
  h.responses.netease = async() => [summary('collected', '1')]
  h.details.get = async() => { throw new Error("Error invoking remote method 'winMain_netease_get_playlist_detail': Error: Private playlist (401)") }
  await h.refreshPlatformUserPlaylists()
  assert.equal(h.platformPlaylistStatuses['netease:collected'].failures[0].message, 'Private playlist (401)')
})

for (const change of ['logout', 'disable', 'switch']) {
  test(`${change} during a failed-song retry prevents late writes and stale failure badges`, async() => {
    const h = createHarness()
    h.responses.netease = async() => [summary('collected', '1')]
    h.details.get = async() => { throw new Error('private') }
    await h.refreshPlatformUserPlaylists()
    const response = deferred()
    const started = deferred()
    h.details.get = () => { started.resolve(); return response.promise }
    const retry = h.retryPlatformUserPlaylistGroup('netease', 'collected')
    await started.promise
    if (change == 'logout') h.accounts.netease.value = { isLoggedIn: false, profile: null }
    else if (change == 'disable') h.settings['list.platformPlaylists.netease.collected'] = false
    else h.accounts.netease.value = { isLoggedIn: true, profile: { userId: 99 } }
    h.responses.netease = async() => []
    const refresh = h.refreshPlatformUserPlaylists()
    response.resolve([{ id: 'late-song' }])
    await Promise.all([retry, refresh])
    assert.equal(h.dbSongs.size, 0)
    assert.deepEqual(h.platformPlaylistStatuses['netease:collected'].failures, [])
    assert.equal(h.getPlatformPlaylistFailure('platform:netease:42:collected:1'), undefined)
  })
}

test('a full refresh requested during retry still fetches the latest directory afterwards', async() => {
  const h = createHarness()
  h.responses.netease = async() => [summary('collected', '1')]
  h.details.get = async() => { throw new Error('offline') }
  await h.refreshPlatformUserPlaylists()
  const response = deferred()
  const started = deferred()
  h.details.get = () => { started.resolve(); return response.promise }
  const retry = h.retryPlatformUserPlaylistGroup('netease', 'collected')
  await started.promise
  h.responses.netease = async() => [summary('collected', '2')]
  const refresh = h.refreshPlatformUserPlaylists({ force: true })
  response.resolve([{ id: 'recovered' }])
  await Promise.all([retry, refresh])
  assert.equal(h.requests.netease, 2)
  assert.deepEqual(h.platformPlaylistStatuses['netease:collected'].lists.map(list => list.sourceListId), ['2'])
})

test('repeated retry clicks share the failed-song request without starting a full refresh', async() => {
  const h = createHarness()
  h.responses.netease = async() => [summary('collected', '1')]
  h.details.get = async() => { throw new Error('offline') }
  await h.refreshPlatformUserPlaylists()
  h.detailRequests.length = 0
  const response = deferred()
  const started = deferred()
  h.details.get = () => { started.resolve(); return response.promise }
  const first = h.retryPlatformUserPlaylistGroup('netease', 'collected')
  await started.promise
  const second = h.retryPlatformUserPlaylistGroup('netease', 'collected')
  response.resolve([{ id: 'recovered' }])
  await Promise.all([first, second])
  assert.equal(h.requests.netease, 1)
  assert.deepEqual(h.detailRequests.map(request => request.id), ['1'])
})

test('logout during song loading prevents late song writes', async() => {
  const h = createHarness()
  const response = deferred()
  const started = deferred()
  h.responses.netease = async() => [summary('created', '1')]
  h.details.get = () => { started.resolve(); return response.promise }
  const pending = h.refreshPlatformUserPlaylists()
  await started.promise
  h.accounts.netease.value = { isLoggedIn: false, profile: null }
  await h.refreshPlatformUserPlaylists()
  response.resolve([{ id: 'late-song' }])
  await pending
  assert.equal(h.dbSongs.size, 0)
  assert.deepEqual(h.platformPlaylistStatuses['netease:created'].lists, [])
})

test('reconciliation persists new playlists and profiles through the actual list IPC and metadata validator', async() => {
  const h = createHarness()
  await h.reconcilePlatformPlaylistSummaries([summary('created', '1'), summary('collected', '2', '42', { coverUrl: '' })], 'netease', '42')
  assert.deepEqual([...h.dbLists.keys()], ['platform:netease:42:created:1', 'platform:netease:42:collected:2'])
  assert.equal(h.metadata['platform:netease:42:created:1'].profile.managed, true)
  assert.equal(Object.hasOwn(h.metadata['platform:netease:42:collected:2'].profile, 'coverUrl'), false)
  assert.equal(h.lists.length, 2)
})

test('refresh fetches once and preserves created and collected lists across consecutive refreshes', async() => {
  const h = createHarness()
  h.responses.netease = async() => [summary('created', '1'), summary('collected', '2')]
  await h.refreshPlatformUserPlaylists()
  await h.refreshPlatformUserPlaylists({ force: true })
  assert.equal(h.requests.netease, 2)
  assert.equal(h.dbLists.size, 2)
  assert.deepEqual(h.platformPlaylistStatuses['netease:created'].lists.map(info => info.sourceListId), ['1'])
  assert.deepEqual(h.platformPlaylistStatuses['netease:collected'].lists.map(info => info.sourceListId), ['2'])
  assert.equal(h.platformPlaylistStatuses['netease:created'].status, 'ready')
  assert.equal(h.platformPlaylistStatuses['netease:collected'].status, 'ready')
})

test('startup restores persisted playlists before reconciling an uninitialized renderer list', async() => {
  const h = createHarness()
  h.seed(summary('created', '1'), summary('collected', '2'))
  h.lists.splice(0)
  h.responses.netease = async() => [summary('created', '1', '42', { name: 'Renamed' }), summary('collected', '2')]
  await h.refreshPlatformUserPlaylists()
  assert.equal(h.platformPlaylistStatuses['netease:created'].status, 'ready')
  assert.equal(h.dbLists.size, 2)
  assert.equal(h.dbLists.get('platform:netease:42:created:1').name, 'Renamed')
  assert.equal(h.platformPlaylistStatuses['netease:collected'].lists.length, 1)
})

test('disabled groups hide their lists without deleting cached playlists', async() => {
  const h = createHarness()
  h.seed(summary('created', '1'), summary('collected', '2'))
  h.settings['list.platformPlaylists.netease.collected'] = false
  h.responses.netease = async() => [summary('created', '3')]
  await h.refreshPlatformUserPlaylists()
  assert.deepEqual([...h.dbLists.keys()].sort(), ['platform:netease:42:collected:2', 'platform:netease:42:created:3'])
  assert.deepEqual(h.platformPlaylistStatuses['netease:collected'].lists, [])
  assert.equal(h.getPlatformPlaylistGroups().value.some(group => group.provider == 'netease' && group.kind == 'collected'), false)
  h.settings['list.platformPlaylists.netease.created'] = false
  await h.refreshPlatformUserPlaylists()
  assert.equal(h.requests.netease, 1)
  assert.equal(h.dbLists.size, 2)
})

test('failed refresh retains both cached groups and exposes the failure', async() => {
  const h = createHarness()
  h.seed(summary('created', '1'), summary('collected', '2'))
  h.responses.netease = async() => { throw new Error('network unavailable') }
  await h.refreshPlatformUserPlaylists()
  assert.equal(h.dbLists.size, 2)
  for (const kind of ['created', 'collected']) {
    const group = h.platformPlaylistStatuses[`netease:${kind}`]
    assert.equal(group.status, 'error')
    assert.equal(group.errorMessage, 'network unavailable')
    assert.equal(group.lists.length, 1)
  }
})

test('concurrent refreshes share one in-flight request and ignore duplicate playlist IDs', async() => {
  const h = createHarness()
  const response = deferred()
  const started = deferred()
  h.responses.netease = () => { started.resolve(); return response.promise }
  const first = h.refreshPlatformUserPlaylists()
  await started.promise
  const second = h.refreshPlatformUserPlaylists({ force: true })
  response.resolve([summary('created', '1'), summary('created', '1')])
  await Promise.all([first, second])
  assert.equal(h.requests.netease, 1)
  assert.equal(h.dbLists.size, 1)
  assert.equal(h.platformPlaylistStatuses['netease:created'].status, 'ready')
})

test('late responses from a previous account cannot replace the new account playlists or status', async() => {
  const h = createHarness()
  h.seed(summary('created', '1'))
  const oldResponse = deferred()
  const started = deferred()
  h.responses.netease = () => { started.resolve(); return oldResponse.promise }
  const oldRefresh = h.refreshPlatformUserPlaylists()
  await started.promise
  h.accounts.netease.value = { isLoggedIn: true, profile: { userId: 99 } }
  h.responses.netease = async() => [summary('collected', '9', '99')]
  await h.refreshPlatformUserPlaylists()
  oldResponse.resolve([summary('created', '2')])
  await oldRefresh
  assert.deepEqual([...h.dbLists.keys()], ['platform:netease:99:collected:9'])
  for (const kind of ['created', 'collected']) {
    assert.equal(h.platformPlaylistStatuses[`netease:${kind}`].accountKey, '99')
    assert.equal(h.platformPlaylistStatuses[`netease:${kind}`].status, 'ready')
  }
})

test('logout hides cached lists and rejects late responses, while logging into the same account restores cache', async() => {
  const h = createHarness()
  h.seed(summary('created', '1'))
  const response = deferred()
  const started = deferred()
  h.responses.netease = () => { started.resolve(); return response.promise }
  const pending = h.refreshPlatformUserPlaylists()
  await started.promise
  h.accounts.netease.value = { isLoggedIn: false, profile: null }
  await h.refreshPlatformUserPlaylists()
  response.resolve([summary('created', '2')])
  await pending
  assert.deepEqual([...h.dbLists.keys()], ['platform:netease:42:created:1'])
  assert.deepEqual(h.platformPlaylistStatuses['netease:created'].lists, [])
  assert.equal(h.platformPlaylistStatuses['netease:created'].status, 'idle')
  h.accounts.netease.value = { isLoggedIn: true, profile: { userId: 42 } }
  h.responses.netease = async() => { throw new Error('offline') }
  await h.refreshPlatformUserPlaylists()
  assert.deepEqual(h.platformPlaylistStatuses['netease:created'].lists.map(info => info.sourceListId), ['1'])
})

test('retry only refreshes the requested provider', async() => {
  const h = createHarness()
  h.accounts.qq_music.value = { isLoggedIn: true, profile: { uin: '7' } }
  h.responses.netease = async() => [summary('created', '1')]
  await h.retryPlatformUserPlaylistGroup('netease', 'created')
  assert.equal(h.requests.netease, 1)
  assert.equal(h.requests.qq_music, 0)
})

test('an empty enabled category removes only its own cached lists', async() => {
  const h = createHarness()
  h.seed(summary('created', '1'), summary('collected', '2'), summary('created', '3', '42', { provider: 'qq_music' }))
  const local = { id: 'local-1', name: 'Local', locationUpdateTime: null }
  h.dbLists.set(local.id, local)
  h.lists.push(local)
  await h.reconcilePlatformPlaylistSummaries([], 'netease', '42', Date.now, ['created'])
  assert.deepEqual([...h.dbLists.keys()], ['platform:netease:42:collected:2', 'platform:qq_music:42:created:3', 'local-1'])
})

test('switching accounts during an existing database commit cleans up that commit before writing new playlists', async() => {
  const h = createHarness()
  const started = deferred()
  const releaseWrite = deferred()
  h.beforeListWrite.add = () => { started.resolve(); return releaseWrite.promise }
  h.responses.netease = async() => [summary('created', '1')]
  const oldRefresh = h.refreshPlatformUserPlaylists()
  await started.promise
  h.accounts.netease.value = { isLoggedIn: true, profile: { userId: 99 } }
  h.responses.netease = async() => [summary('created', '9', '99')]
  const newRefresh = h.refreshPlatformUserPlaylists()
  releaseWrite.resolve()
  await Promise.all([oldRefresh, newRefresh])
  assert.deepEqual([...h.dbLists.keys()], ['platform:netease:99:created:9'])
  assert.deepEqual(h.platformPlaylistStatuses['netease:created'].lists.map(info => info.sourceListId), ['9'])
  assert.equal(h.platformPlaylistStatuses['netease:created'].accountKey, '99')
})

for (const change of ['logout', 'disable']) {
  const invalidate = h => {
    if (change == 'logout') h.accounts.netease.value = { isLoggedIn: false, profile: null }
    else {
      h.settings['list.platformPlaylists.netease.created'] = false
      h.settings['list.platformPlaylists.netease.collected'] = false
    }
    return h.refreshPlatformUserPlaylists()
  }

  test(`${change} during creation preserves cached playlists and prevents subsequent metadata writes`, async() => {
    const h = createHarness()
    h.seed(summary('created', '1'))
    h.dbSongs.set('platform:netease:42:created:1', [{ id: 'cached-song' }])
    const started = deferred()
    const release = deferred()
    h.beforeListWrite.add = () => { started.resolve(); return release.promise }
    h.responses.netease = async() => [summary('created', '2')]
    const pending = h.refreshPlatformUserPlaylists()
    await started.promise
    const invalidation = invalidate(h)
    release.resolve()
    await Promise.all([pending, invalidation])
    assert.equal(h.dbLists.has('platform:netease:42:created:1'), true)
    assert.deepEqual(h.dbSongs.get('platform:netease:42:created:1'), [{ id: 'cached-song' }])
    assert.equal(h.metadata['platform:netease:42:created:2'], undefined)
    assert.deepEqual(h.platformPlaylistStatuses['netease:created'].lists, [])
  })

  test(`${change} after an update starts prevents removing other cached playlists`, async() => {
    const h = createHarness()
    h.seed(summary('created', '1'), summary('created', '2'))
    h.dbSongs.set('platform:netease:42:created:2', [{ id: 'cached-song' }])
    const started = deferred()
    const release = deferred()
    h.beforeListWrite.update = () => { started.resolve(); return release.promise }
    h.responses.netease = async() => [summary('created', '1')]
    const pending = h.refreshPlatformUserPlaylists()
    await started.promise
    const invalidation = invalidate(h)
    release.resolve()
    await Promise.all([pending, invalidation])
    assert.equal(h.dbLists.has('platform:netease:42:created:2'), true)
    assert.deepEqual(h.dbSongs.get('platform:netease:42:created:2'), [{ id: 'cached-song' }])
    assert.equal(h.detailRequests.length, 0)
    assert.deepEqual(h.platformPlaylistStatuses['netease:created'].lists, [])
  })
}

test('managed platform lists are excluded from local menu mutations', () => {
  const menu = read('src/renderer/views/List/MyList/useMenu.js')
  assert.match(menu, /startsWith\('platform:'\)/)
  assert.match(menu, /menuControl\.rename = !isManaged/)
  assert.match(menu, /moveGroup\.value = isManaged \? null/)
})
