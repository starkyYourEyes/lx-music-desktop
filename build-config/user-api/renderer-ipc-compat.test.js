const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const nestedValues = new Proxy({}, {
  get: (_target, key) => new Proxy({ name: String(key), action: String(key) }, {
    get: (value, nestedKey) => nestedKey in value ? value[nestedKey] : String(nestedKey),
  }),
})

const loadRendererIpc = results => loadTsModule(path.join(__dirname, '../../src/renderer/utils/ipc.ts'), {
  '@common/rendererIpc': {
    rendererInvoke: async() => results.shift(), rendererSend() {}, rendererOn() {}, rendererOff() {},
  },
  '@common/ipcNames': {
    HOTKEY_RENDERER_EVENT_NAME: {},
    CMMON_EVENT_NAME: {},
    WIN_MAIN_RENDERER_EVENT_NAME: { request_user_api: 'request' },
  },
  '@common/utils/vueTools': { markRaw: value => value, toRaw: value => value },
  '@common/utils': { log: { error() {} } },
  '@common/hotKey': {
    HOTKEY_PLAYER: nestedValues, HOTKEY_COMMON: nestedValues, HOTKEY_DESKTOP_LYRIC: nestedValues,
  },
  '@common/constants': {
    APP_EVENT_NAMES: { winMainName: 'main', winLyricName: 'lyric' }, DATA_KEYS: {},
  },
  './storageState': { getLocalState() {}, setLocalState() {} },
})

test('renderer IPC unwraps legacy results while preserving source-aware result envelopes', async() => {
  const sourceResult = { ok: true, value: { source: 'a' } }
  const ipc = loadRendererIpc([
    { ok: true, value: { data: { url: 'https://music.test/file' } } },
    sourceResult,
  ])

  assert.deepEqual(
    await ipc.sendUserApiRequest({ requestKey: 'legacy', data: { action: 'musicUrl' } }),
    { data: { url: 'https://music.test/file' } },
  )
  assert.strictEqual(
    await ipc.sendUserApiRequest({ apiId: 'user_api/a', requestId: 'source', data: {} }),
    sourceResult,
  )
})
