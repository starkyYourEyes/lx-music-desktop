const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const useAppPath = path.resolve(__dirname, '../../src/renderer/core/useApp/index.ts')

const flushTasks = () => new Promise(resolve => { setImmediate(resolve) })
const asDefault = value => ({ __esModule: true, default: value })

const loadUseApp = ({ isPortableProfileCutoverStartup }) => {
  let autoUpdateCalls = 0
  const noOpInitializer = () => () => {}
  const useApp = loadTsModule(useAppPath, {
    '@renderer/utils/ipc': {
      getEnvParams: async() => ({
        cmdParams: {},
        deeplink: null,
        isPortableProfileCutoverStartup,
      }),
      getViewPrevState: async() => ({ url: '/', query: {} }),
      sendInited() {},
    },
    '@renderer/store': {
      proxy: {},
      isFullscreen: { value: false },
      themeId: { value: '' },
    },
    '@renderer/store/setting': {
      appSetting: {
        'network.proxy.enable': false,
        'network.proxy.host': '',
        'network.proxy.port': '',
        'common.startInFullscreen': false,
        'theme.id': '',
      },
    },
    './useSync': asDefault(noOpInitializer),
    './useOpenAPI': asDefault(noOpInitializer),
    './useStatusbarLyric': asDefault(noOpInitializer),
    './useDataInit': asDefault(() => async() => {}),
    './useHandleEnvParams': asDefault(noOpInitializer),
    './useEventListener': asDefault(() => {}),
    './useDeeplink': asDefault(() => async() => {}),
    './usePlayer': asDefault(noOpInitializer),
    './useParty': asDefault(noOpInitializer),
    './useSettingSync': asDefault(() => {}),
    '@common/utils/vueRouter': { useRouter: () => ({ push: async() => {} }) },
    './listAutoUpdate': asDefault(() => { autoUpdateCalls++ }),
  }).default

  return {
    run: useApp,
    getAutoUpdateCalls: () => autoUpdateCalls,
  }
}

test('portable profile cutover startup preserves restored source playlists', async() => {
  const harness = loadUseApp({ isPortableProfileCutoverStartup: true })

  harness.run()
  await flushTasks()

  assert.equal(harness.getAutoUpdateCalls(), 0)
})

test('ordinary startup retains source playlist auto update behavior', async() => {
  const harness = loadUseApp({ isPortableProfileCutoverStartup: false })

  harness.run()
  await flushTasks()

  assert.equal(harness.getAutoUpdateCalls(), 1)
})
