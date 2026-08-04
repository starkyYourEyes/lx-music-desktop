const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')
const babel = require('@babel/core')
const { parse } = require('@vue/compiler-sfc')

const loadThemeModal = mocks => {
  const filename = path.join(__dirname, '../../src/renderer/views/Setting/components/ThemeEditModal/index.vue')
  const source = fs.readFileSync(filename, 'utf8')
  const parsed = parse(source, { filename })
  assert.deepEqual(parsed.errors, [])
  assert(parsed.descriptor.script)
  const { code } = babel.transformSync(parsed.descriptor.script.content, {
    babelrc: false,
    configFile: false,
    filename: `${filename}.js`,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
  })
  const loadedModule = new Module(filename, module)
  loadedModule.filename = filename
  loadedModule.paths = Module._nodeModulePaths(path.dirname(filename))
  const originalLoad = Module._load
  Module._load = (request, parent, isMain) => {
    if (Object.hasOwn(mocks, request)) return mocks[request]
    return originalLoad(request, parent, isMain)
  }
  try {
    loadedModule._compile(code, filename)
  } finally {
    Module._load = originalLoad
  }
  return loadedModule.exports.default
}

const createTheme = (id, name, background = 'old.img') => ({
  id,
  name,
  isDark: false,
  isDarkFont: false,
  isCustom: true,
  config: {
    themeColors: {
      '--color-primary': '#123456',
      '--color-1000': '#ffffff',
    },
    extInfo: {
      '--color-app-background': '#111111',
      '--color-main-background': '#222222',
      '--color-nav-font': '#333333',
      '--background-image': background,
      '--background-image-position': 'center',
      '--background-image-size': 'cover',
      '--color-btn-hide': '#444444',
      '--color-btn-min': '#555555',
      '--color-btn-close': '#666666',
      '--color-badge-primary': '#777777',
      '--color-badge-secondary': '#888888',
      '--color-badge-tertiary': '#999999',
    },
  },
})

const deferred = () => {
  let resolveDeferred
  let rejectDeferred
  const promise = new Promise((resolve, reject) => {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return { promise, resolve: resolveDeferred, reject: rejectDeferred }
}

const colorHook = () => ({
  primary_color_ref: {},
  font_color_ref: {},
  app_bg_color_ref: {},
  main_bg_color_ref: {},
  aside_font_color_ref: {},
  badge_primary_color_ref: {},
  badge_secondary_color_ref: {},
  badge_tertiary_color_ref: {},
  close_btn_color_ref: {},
  min_btn_color_ref: {},
  hide_btn_color_ref: {},
  initMainColor() {},
  initFontColor() {},
  initAppBgColor() {},
  initMainBgColor() {},
  initAsideFontColor() {},
  initBadgePrimaryColor() {},
  initBadgeSecondaryColor() {},
  initBadgeTertiaryColor() {},
  initCloseBtnColor() {},
  initMinBtnColor() {},
  initHideBtnColor() {},
  destroyMainColor() {},
  destroyFontColor() {},
  destroyAppBgColor() {},
  destroyMainBgColor() {},
  destroyAsideFontColor() {},
  destroyBadgePrimaryColor() {},
  destroyBadgeSecondaryColor() {},
  destroyBadgeTertiaryColor() {},
  destroyCloseBtnColor() {},
  destroyMinBtnColor() {},
  destroyHideBtnColor() {},
  setAppBgColor() {},
  setMainBgColor() {},
  setAsideFontColor() {},
  setBadgePrimaryColor() {},
  setBadgeSecondaryColor() {},
  setBadgeTertiaryColor() {},
  setCloseBtnColor() {},
  setMinBtnColor() {},
  setHideBtnColor() {},
})

const createHarness = () => {
  const originalTheme = createTheme('existing', 'Existing')
  const builtIn = createTheme('green', 'Green', 'none')
  const themeInfo = { themes: [builtIn], userThemes: [originalTheme], dataPath: 'C:\\profile\\assets\\theme-images' }
  const emissions = []
  const applyCalls = []
  const discarded = []
  const saveCalls = []
  const saveDeferred = deferred()
  let saveEnteredResolve
  const saveEntered = new Promise(resolve => { saveEnteredResolve = resolve })
  const ipc = {
    discardThemeImage: async stagingId => { discarded.push(stagingId) },
    promoteThemeImage: async() => ({ fileName: 'promoted.img', previewPath: 'C:\\profile\\promoted.img' }),
    removeTheme: async() => {},
    saveTheme: (...args) => {
      saveCalls.push(args)
      saveEnteredResolve()
      return saveDeferred.promise
    },
    showSelectDialog: async() => ({ canceled: false, filePaths: ['C:\\external\\selected.png'] }),
    stageThemeImage: async() => ({ stagingId: 'stage-1', previewPath: 'C:\\run\\theme-editor\\stage-1' }),
  }
  const mocks = {
    '@common/utils/nodejs': { joinPath: path.join },
    '@common/utils/vueTools': {
      nextTick: callback => callback(),
      ref: value => ({ value }),
      watch: (read, callback) => callback(read()),
    },
    '@renderer/store/utils': {
      applyTheme: (...args) => { applyCalls.push(args) },
      buildThemeColors: () => ({}),
      copyTheme: value => structuredClone(value),
      getThemes: callback => callback(themeInfo),
    },
    '@common/utils/common': { isUrl: () => false, encodePath: value => value },
    '@common/theme/utils': { createThemeColors: () => ({}) },
    '@renderer/store/setting': { appSetting: { 'theme.id': 'green', 'theme.lightId': 'green', 'theme.darkId': 'black' }, updateSetting() {} },
    '@renderer/utils/ipc': ipc,
    '@renderer/plugins/Dialog': { dialog: { confirm: async() => true } },
    '@renderer/store': { themeInfo },
  }
  for (const name of [
    './useMainColor', './useFontColor', './useAppBgColor', './useMainBgColor', './useAsideFontColor',
    './useBadgePrimaryColor', './useBadgeSecondaryColor', './useBadgeTertiaryColor', './useCloseBtnColor',
    './useMinBtnColor', './useHideBtnColor',
  ]) mocks[name] = colorHook
  const component = loadThemeModal(mocks)
  global.window = { i18n: { t: key => key }, setTheme() {} }
  const vm = component.setup(
    { modelValue: true, themeId: 'existing' },
    { emit: (...args) => { emissions.push(args) } },
  )
  return { applyCalls, discarded, emissions, ipc, originalTheme, saveCalls, saveDeferred, saveEntered, themeInfo, vm }
}

for (const scenario of [
  { label: 'Save', action: 'handleSubmit' },
  { label: 'Save As', action: 'handleSaveNew' },
]) {
  test(`${scenario.label} leaves renderer themes and staging published state unchanged when persistence rejects`, async() => {
    // Catches submit paths that promote, consume staging, mutate the reactive array, or close before durable save succeeds.
    const harness = createHarness()
    await harness.vm.selectBgImg()
    const beforeThemes = structuredClone(harness.themeInfo.userThemes)
    const savePromise = harness.vm[scenario.action]()
    await harness.saveEntered

    assert.deepEqual(harness.themeInfo.userThemes, beforeThemes)
    assert.deepEqual(harness.emissions, [])
    assert.deepEqual(harness.applyCalls, [])
    assert.equal(harness.saveCalls[0][1], 'stage-1')

    const failure = new Error('durable theme save failed')
    harness.saveDeferred.reject(failure)
    await assert.rejects(savePromise, error => error === failure)

    assert.deepEqual(harness.themeInfo.userThemes, beforeThemes)
    assert.deepEqual(harness.emissions, [])
    assert.deepEqual(harness.discarded, [])
  })
}

test('Save publishes the canonical committed array only after durable save resolves', async() => {
  // Catches renderer reconciliation that publishes its speculative local theme instead of the main commit result.
  const harness = createHarness()
  await harness.vm.selectBgImg()
  const beforeThemes = structuredClone(harness.themeInfo.userThemes)
  const savePromise = harness.vm.handleSubmit()
  await harness.saveEntered
  const committedTheme = createTheme('existing', 'Committed', 'opaque.img')
  const committedThemes = [committedTheme, createTheme('other', 'Other', 'none')]

  assert.deepEqual(harness.themeInfo.userThemes, beforeThemes)
  harness.saveDeferred.resolve({ theme: committedTheme, userThemes: committedThemes })
  await savePromise

  assert.deepEqual(harness.themeInfo.userThemes, committedThemes)
  assert.deepEqual(harness.emissions, [['submit'], ['update:modelValue', false]])
  assert.equal(harness.applyCalls.length, 1)
})
