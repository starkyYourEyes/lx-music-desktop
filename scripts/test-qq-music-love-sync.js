const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const createHarness = ({ likeQQMusic = async() => {} } = {}) => {
  const calls = { local: [], netease: [], qq: [] }
  const listManage = {
    registerListAction: () => () => {},
    createUserList: async() => {},
    addListMusics: async data => { calls.local.push(data) },
    moveListMusics: async() => {},
    overwriteListMusics: async() => {},
    getUserLists: async() => [],
    removeUserList: async() => {},
    updateUserList: async() => {},
    updateUserListPosition: async() => {},
    getListMusics: async() => [],
    removeListMusics: async() => {},
    updateListMusics: async() => {},
    updateListMusicsPosition: async() => {},
    clearListMusics: async() => {},
    overwriteListFull: async() => {},
    checkListExistMusic: async() => false,
    getMusicExistListIds: async() => [],
  }
  const action = loadTsModule(
    path.join(__dirname, '../src/renderer/store/list/action.ts'),
    {
      '@common/listGroup': loadTsModule(path.join(__dirname, '../src/common/listGroup.ts')),
      '@common/utils': { log: { error() {} } },
      './group': { initializeUserListGroups: async() => {} },
      '@renderer/store/setting': {
        appSetting: { 'list.addMusicLocationType': 'top' },
      },
      './state': {
        fetchingListStatus: {},
        listUpdateTimes: {},
        allMusicList: new Map(),
        userLists: [],
        tempListMeta: { id: null },
      },
      '@renderer/store/list/listManage': listManage,
      '@renderer/store/list/listManage/action': {
        setMusicList: () => [],
        stageMusicList: () => {},
      },
      '@common/utils/vueTools': { toRaw: value => value },
      '@common/constants': {
        LIST_IDS: {
          DEFAULT: 'default',
          LOVE: 'love',
          WEBDAV: 'webdav',
          TEMP: 'temp',
        },
      },
      '@renderer/utils/ipc': {
        likeNeteaseMusic: async musicInfo => { calls.netease.push(musicInfo) },
        likeQQMusic: async musicInfo => {
          calls.qq.push(musicInfo)
          await likeQQMusic(musicInfo)
        },
        listWebDAVMusics: async() => [],
        uploadLocalMusicToWebDAV: async musicInfo => musicInfo,
      },
    },
  )
  return { action, calls }
}

const mixed = [
  { id: 'wy_1', source: 'wy', name: 'WY', singer: 'Singer', meta: {} },
  { id: 'tx_1', source: 'tx', name: 'TX', singer: 'Singer', meta: { id: 101 } },
  { id: 'kg_1', source: 'kg', name: 'KG', singer: 'Singer', meta: {} },
]

const main = async() => {
  const { action, calls } = createHarness()
  await action.addListMusics('love', mixed, undefined, {
    waitNeteaseSync: true,
    waitQQMusicSync: true,
  })
  assert.deepStrictEqual(calls.local.at(-1).musicInfos, mixed)
  assert.deepStrictEqual(calls.netease.map(music => music.id), ['wy_1'])
  assert.deepStrictEqual(calls.qq.map(music => music.id), ['tx_1'])

  await action.addListMusics('default', mixed, undefined, {
    waitNeteaseSync: true,
    waitQQMusicSync: true,
  })
  assert.strictEqual(calls.netease.length, 1)
  assert.strictEqual(calls.qq.length, 1)

  const warnings = []
  const originalWarn = console.warn
  console.warn = message => { warnings.push(message) }
  try {
    const failed = createHarness({
      likeQQMusic: async() => { throw new Error('cookie=must-not-leak') },
    })
    await assert.doesNotReject(failed.action.addListMusics('love', [mixed[1]], undefined, {
      waitQQMusicSync: true,
    }))
    assert.deepStrictEqual(failed.calls.local.at(-1).musicInfos, [mixed[1]])
    assert.strictEqual(failed.calls.qq.length, 1)
  } finally {
    console.warn = originalWarn
  }
  assert.deepStrictEqual(warnings, ['Sync QQ Music liked music failed'])
  assert.doesNotMatch(JSON.stringify(warnings), /cookie|must-not-leak/)

  const skipped = createHarness()
  await skipped.action.addListMusics('love', mixed, undefined, {
    waitNeteaseSync: true,
    skipQQMusicSync: true,
  })
  assert.deepStrictEqual(skipped.calls.netease.map(music => music.id), ['wy_1'])
  assert.deepStrictEqual(skipped.calls.qq, [])
  console.log('QQ Music Love-list synchronization tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
