const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

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

const storageStatePath = '../../src/main/modules/winMain/rendererEvent/storageState.ts'
const dataHandlerPath = '../../src/main/modules/winMain/rendererEvent/data.ts'
const rendererDataPath = '../../src/renderer/utils/data.ts'
const searchActionPath = '../../src/renderer/store/search/action.ts'
const commonRoot = path.resolve(__dirname, '../../src/common')

const loadSourceModule = modulePath => {
  const originalLoad = Module._load
  Module._load = function(request, parent, isMain) {
    if (request == '@common/mainIpc') return { mainHandle: () => {}, mainOn: () => {} }
    if (request == '@main/utils') return { updateCatalogPreferences: () => { throw new Error('unexpected settings write') } }
    if (request == '@main/utils/store') return () => { throw new Error('unexpected Store access') }
    if (request.startsWith('@common/')) {
      return originalLoad.call(this, path.join(commonRoot, `${request.slice('@common/'.length)}.ts`), parent, isMain)
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return require(modulePath)
  } finally {
    Module._load = originalLoad
  }
}

afterEach(() => {
  for (const modulePath of [storageStatePath, dataHandlerPath, rendererDataPath, searchActionPath]) {
    try { delete require.cache[require.resolve(modulePath)] } catch {}
  }
})

describe('typed non-activity IPC', () => {
  it('rejects unknown operations and oversized state before worker dispatch', async() => {
    const workerCalls = []
    const { createStorageStateDispatcher } = loadSourceModule(storageStatePath)
    const dispatch = createStorageStateDispatcher({
      getCatalogPreferences: () => { throw new Error('unexpected Store read') },
      updateCatalogPreferences: () => { throw new Error('unexpected Store write') },
      getLocalState: () => { workerCalls.push('local:get') },
      setLocalState: update => { workerCalls.push(['local:set', update]) },
      getPlaylistMetadata: () => { workerCalls.push('playlist:get') },
      applyPlaylistMetadata: command => { workerCalls.push(['playlist:mutate', command]) },
      getSearchHistory: () => { workerCalls.push('search:get') },
      applySearchHistory: command => { workerCalls.push(['search:mutate', command]) },
    })

    await assert.rejects(dispatch({ type: 'local_state.set', update: { key: 'unknown', value: {} } }))
    await assert.rejects(dispatch({ type: 'search_history.mutate', command: {
      version: 1,
      action: 'record',
      term: 'x'.repeat(201),
      usedAtMs: 1,
    } }))
    await assert.rejects(dispatch({ type: 'unknown.get' }))
    assert.deepEqual(workerCalls, [])
  })

  it('preserves both sections when catalog preferences are set concurrently', async() => {
    let preferences = {
      version: 1,
      leaderboard: { source: 'kw', boardId: 'kw__16' },
      songList: { source: 'kw', sortId: 'new', tagId: '' },
      search: { temp_source: 'kw', source: 'all', type: 'music' },
    }
    const { createStorageStateDispatcher } = loadSourceModule(storageStatePath)
    const dispatch = createStorageStateDispatcher({
      getCatalogPreferences: async() => structuredClone(preferences),
      updateCatalogPreferences: next => {
        preferences = structuredClone(next)
        return { catalogPreferences: structuredClone(preferences) }
      },
      getLocalState: () => { throw new Error('unexpected local-state read') },
      setLocalState: () => { throw new Error('unexpected local-state write') },
      getPlaylistMetadata: () => { throw new Error('unexpected playlist read') },
      applyPlaylistMetadata: () => { throw new Error('unexpected playlist write') },
      getSearchHistory: () => { throw new Error('unexpected search-history read') },
      applySearchHistory: () => { throw new Error('unexpected search-history write') },
    })

    await Promise.all([
      dispatch({
        type: 'catalog_preference.set',
        section: 'leaderboard',
        value: { source: 'kg', boardId: 'kg__1' },
      }),
      dispatch({
        type: 'catalog_preference.set',
        section: 'search',
        value: { temp_source: 'tx', source: 'tx', type: 'songlist' },
      }),
    ])

    assert.deepEqual(preferences, {
      version: 1,
      leaderboard: { source: 'kg', boardId: 'kg__1' },
      songList: { source: 'kw', sortId: 'new', tagId: '' },
      search: { temp_source: 'tx', source: 'tx', type: 'songlist' },
    })
  })

  it('rejects non-activity and malformed generic data keys before Store access', () => {
    const storeCalls = []
    const { createDataHandlers } = loadSourceModule(dataHandlerPath)
    const handlers = createDataHandlers({
      get: key => { storeCalls.push(['get', key]); return null },
      set: (key, value) => { storeCalls.push(['set', key, value]) },
    })

    for (const key of ['viewPrevState', 'searchHistoryList', 'neteaseAccount', 'unknown', null, {}]) {
      assert.throws(() => handlers.get(key))
    }
    for (const params of [
      { path: 'listUpdateInfo', data: {} },
      { path: 'qqMusicAccount', data: {} },
      { path: 'unknown', data: {} },
      { data: {} },
      null,
    ]) {
      assert.throws(() => handlers.set(params))
    }
    assert.deepEqual(storeCalls, [])

    handlers.get('playInfo')
    handlers.set({ path: 'recentPlayList', data: [] })
    handlers.get('listeningTimeStats')
    assert.deepEqual(storeCalls, [
      ['get', 'playInfo'],
      ['set', 'recentPlayList', []],
      ['get', 'listeningTimeStats'],
    ])
  })

  it('does not let an earlier catalog response replace a newer renderer edit', async() => {
    const initial = {
      version: 1,
      leaderboard: { source: 'kw', boardId: 'kw__16' },
      songList: { source: 'kw', sortId: 'new', tagId: '' },
      search: { temp_source: 'kw', source: 'kw', type: 'music' },
    }
    const writes = []
    let resolveFirstWrite
    const firstWrite = new Promise(resolve => { resolveFirstWrite = resolve })
    const originalLoad = Module._load
    Module._load = function(request, parent, isMain) {
      if (request == '@renderer/utils/storageState') {
        return {
          getCatalogPreferences: async() => structuredClone(initial),
          setCatalogPreference: (section, value) => {
            writes.push({ section, value: structuredClone(value) })
            return writes.length == 1 ? firstWrite : new Promise(() => {})
          },
          getLocalState: () => { throw new Error('unexpected local-state read') },
          getPlaylistMetadata: () => { throw new Error('unexpected playlist read') },
          mutatePlaylistMetadata: () => { throw new Error('unexpected playlist write') },
          setLocalState: () => { throw new Error('unexpected local-state write') },
        }
      }
      if (request == '@common/utils') return { throttle: fn => fn }
      if (request == '@common/constants') {
        return {
          DEFAULT_SETTING: initial,
          LIST_IDS: { DEFAULT: 'default' },
        }
      }
      if (request == '@renderer/store/list/action') return { setUpdateTime: () => {} }
      if (request == './index' && parent?.filename.endsWith('renderer\\utils\\data.ts')) return { dateFormat: () => '' }
      return originalLoad.call(this, request, parent, isMain)
    }

    let data
    try {
      data = require(rendererDataPath)
    } finally {
      Module._load = originalLoad
    }

    await data.getSearchSetting()
    await data.setSearchSetting({ source: 'kg' })
    await data.setSearchSetting({ type: 'songlist' })
    resolveFirstWrite({
      ...structuredClone(initial),
      search: { ...initial.search, source: 'kg' },
    })
    await new Promise(resolve => setImmediate(resolve))

    assert.deepEqual(await data.getSearchSetting(), {
      temp_source: 'kw',
      source: 'kg',
      type: 'songlist',
    })
    assert.deepEqual(writes.map(({ value }) => value), [
      { temp_source: 'kw', source: 'kg', type: 'music' },
      { temp_source: 'kw', source: 'kg', type: 'songlist' },
    ])
  })

  it('shares first catalog initialization across concurrent section setters', async() => {
    const initial = {
      version: 1,
      leaderboard: { source: 'kw', boardId: 'kw__16' },
      songList: { source: 'kw', sortId: 'new', tagId: '' },
      search: { temp_source: 'kw', source: 'kw', type: 'music' },
    }
    const reads = []
    let resolveFirstRead
    let resolveSecondRead
    const firstRead = new Promise(resolve => { resolveFirstRead = resolve })
    const secondRead = new Promise(resolve => { resolveSecondRead = resolve })
    const originalLoad = Module._load
    Module._load = function(request, parent, isMain) {
      if (request == '@renderer/utils/storageState') {
        return {
          getCatalogPreferences: () => {
            reads.push(reads.length + 1)
            return reads.length == 1 ? firstRead : secondRead
          },
          setCatalogPreference: async(section, value) => {
            if (section == 'leaderboard') resolveSecondRead(structuredClone(initial))
            return { ...structuredClone(initial), [section]: structuredClone(value) }
          },
          getLocalState: () => { throw new Error('unexpected local-state read') },
          getPlaylistMetadata: () => { throw new Error('unexpected playlist read') },
          mutatePlaylistMetadata: () => { throw new Error('unexpected playlist write') },
          setLocalState: () => { throw new Error('unexpected local-state write') },
        }
      }
      if (request == '@common/utils') return { throttle: fn => fn }
      if (request == '@common/constants') {
        return {
          DEFAULT_SETTING: initial,
          LIST_IDS: { DEFAULT: 'default' },
        }
      }
      if (request == '@renderer/store/list/action') return { setUpdateTime: () => {} }
      if (request == './index' && parent?.filename.endsWith('renderer\\utils\\data.ts')) return { dateFormat: () => '' }
      return originalLoad.call(this, request, parent, isMain)
    }

    let data
    try {
      data = require(rendererDataPath)
    } finally {
      Module._load = originalLoad
    }

    const leaderboardUpdate = data.setLeaderboardSetting({ source: 'kg', boardId: 'kg__1' })
    const searchUpdate = data.setSearchSetting({ source: 'tx', type: 'songlist' })
    await new Promise(resolve => setImmediate(resolve))
    resolveFirstRead(structuredClone(initial))
    await Promise.all([leaderboardUpdate, searchUpdate])

    assert.deepEqual(await data.getLeaderboardSetting(), { source: 'kg', boardId: 'kg__1' })
    assert.deepEqual(await data.getSearchSetting(), { temp_source: 'kw', source: 'tx', type: 'songlist' })
    assert.equal(reads.length, 1)
  })

  it('keeps existing playlist metadata when a legacy full update fails partway', async() => {
    let persisted = {
      existing: { updateTime: 1, isAutoUpdate: true },
    }
    let mutationCount = 0
    const originalLoad = Module._load
    Module._load = function(request, parent, isMain) {
      if (request == '@renderer/utils/storageState') {
        return {
          getCatalogPreferences: () => { throw new Error('unexpected catalog read') },
          setCatalogPreference: () => { throw new Error('unexpected catalog write') },
          getLocalState: () => { throw new Error('unexpected local-state read') },
          getPlaylistMetadata: async() => structuredClone(persisted),
          mutatePlaylistMetadata: async command => {
            mutationCount++
            if (mutationCount == 2) throw new Error('injected playlist failure')
            if (command.action == 'retain') {
              persisted = Object.fromEntries(Object.entries(persisted).filter(([id]) => command.playlistIds.includes(id)))
            } else if (command.action == 'upsert') {
              persisted[command.playlistId] = structuredClone(command.value)
            }
            return structuredClone(persisted)
          },
          setLocalState: () => { throw new Error('unexpected local-state write') },
        }
      }
      if (request == '@common/utils') return { throttle: fn => fn }
      if (request == '@common/constants') {
        return {
          DEFAULT_SETTING: {},
          LIST_IDS: { DEFAULT: 'default' },
        }
      }
      if (request == '@renderer/store/list/action') return { setUpdateTime: () => {} }
      if (request == './index' && parent?.filename.endsWith('renderer\\utils\\data.ts')) return { dateFormat: () => '' }
      return originalLoad.call(this, request, parent, isMain)
    }

    let data
    try {
      data = require(rendererDataPath)
    } finally {
      Module._load = originalLoad
    }

    await assert.rejects(data.setListUpdateInfo({
      first: { updateTime: 2, isAutoUpdate: false },
      second: { updateTime: 3, isAutoUpdate: false },
    }), /injected playlist failure/)
    assert.deepEqual(persisted.existing, { updateTime: 1, isAutoUpdate: true })
  })

  it('serializes playlist metadata mutations without letting stale responses replace the cache', async() => {
    let persisted = {}
    let resolveFirstMutation
    const firstMutation = new Promise(resolve => { resolveFirstMutation = resolve })
    let mutationCount = 0
    const originalLoad = Module._load
    Module._load = function(request, parent, isMain) {
      if (request == '@renderer/utils/storageState') {
        return {
          getCatalogPreferences: () => { throw new Error('unexpected catalog read') },
          setCatalogPreference: () => { throw new Error('unexpected catalog write') },
          getLocalState: () => { throw new Error('unexpected local-state read') },
          getPlaylistMetadata: async() => structuredClone(persisted),
          mutatePlaylistMetadata: command => {
            mutationCount++
            if (mutationCount == 1) {
              persisted.first = { updateTime: 0, isAutoUpdate: true }
              return firstMutation
            }
            if (mutationCount == 3) return Promise.reject(new Error('injected playlist failure'))
            if (command.action == 'upsert') persisted[command.playlistId] = structuredClone(command.value)
            return Promise.resolve(structuredClone(persisted))
          },
          setLocalState: () => { throw new Error('unexpected local-state write') },
        }
      }
      if (request == '@common/utils') return { throttle: fn => fn }
      if (request == '@common/constants') {
        return {
          DEFAULT_SETTING: {},
          LIST_IDS: { DEFAULT: 'default' },
        }
      }
      if (request == '@renderer/store/list/action') return { setUpdateTime: () => {} }
      if (request == './index' && parent?.filename.endsWith('renderer\\utils\\data.ts')) return { dateFormat: () => '' }
      return originalLoad.call(this, request, parent, isMain)
    }

    let data
    try {
      data = require(rendererDataPath)
    } finally {
      Module._load = originalLoad
    }

    await data.getListUpdateInfo()
    const first = data.setListAutoUpdate('first', true)
    const second = data.setListUpdateTime('second', 2)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(mutationCount, 1)

    resolveFirstMutation({ first: { updateTime: 0, isAutoUpdate: true } })
    await Promise.all([first, second])

    assert.deepEqual(await data.getListUpdateInfo(), {
      first: { updateTime: 0, isAutoUpdate: true },
      second: { updateTime: 2, isAutoUpdate: false },
    })
    assert.deepEqual(persisted, {
      first: { updateTime: 0, isAutoUpdate: true },
      second: { updateTime: 2, isAutoUpdate: false },
    })

    await assert.rejects(data.setListAutoUpdate('rejected', true), /injected playlist failure/)
    await data.setListUpdateTime('after-rejection', 3)

    assert.deepEqual(await data.getListUpdateInfo(), {
      first: { updateTime: 0, isAutoUpdate: true },
      second: { updateTime: 2, isAutoUpdate: false },
      'after-rejection': { updateTime: 3, isAutoUpdate: false },
    })
  })

  it('records an exact-case search term that is already first', async() => {
    const historyList = ['Exact']
    const commands = []
    const originalLoad = Module._load
    Module._load = function(request, parent, isMain) {
      if (request == '@renderer/utils/storageState') {
        return {
          getSearchHistory: async() => historyList,
          mutateSearchHistory: async command => {
            commands.push(structuredClone(command))
            return ['Exact', 'Other']
          },
        }
      }
      if (request == '../setting' && parent?.filename.endsWith('renderer\\store\\search\\action.ts')) {
        return { appSetting: { 'search.isShowHistorySearch': true } }
      }
      if (request == './state' && parent?.filename.endsWith('renderer\\store\\search\\action.ts')) {
        return { searchText: { value: '' }, historyList }
      }
      return originalLoad.call(this, request, parent, isMain)
    }

    let actions
    try {
      actions = require(searchActionPath)
    } finally {
      Module._load = originalLoad
    }

    await actions.addHistoryWord('Exact')

    assert.deepEqual(historyList, ['Exact', 'Other'])
    assert.equal(commands.length, 1)
    assert.equal(commands[0].version, 1)
    assert.equal(commands[0].action, 'record')
    assert.equal(commands[0].term, 'Exact')
    assert.equal(Number.isSafeInteger(commands[0].usedAtMs), true)
  })
})
