const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')
const babel = require('@babel/core')
const { parse } = require('@vue/compiler-sfc')

const loadUserApiModal = mocks => {
  const filename = path.join(__dirname, '../../src/renderer/views/Setting/components/UserApiModal.vue')
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

const createHarness = () => {
  const removed = { id: 'removed', name: 'Removed source' }
  const retainedList = [{ id: 'retained', name: 'Retained source' }]
  const userApi = { list: [removed] }
  const appSetting = {
    'common.apiSource': removed.id,
    'common.apiFallbackSources': [removed.id],
  }
  const sourceChanges = []
  const dialogs = []
  const retainedFailure = Object.assign(new Error('runtime close failed after commit'), {
    apiList: retainedList,
  })
  let removeImplementation = async() => retainedList
  const component = loadUserApiModal({
    '@renderer/utils/ipc': {
      importUserApi() {},
      removeUserApi: (...args) => removeImplementation(...args),
      replaceUserApisFromGitHub: async() => { throw retainedFailure },
      showSelectDialog() {},
      setAllowShowUserApiUpdateAlert() {},
    },
    '@renderer/utils/githubUserApi': {
      getGitHubUserApiSnapshot: async() => ({ version: 'v1', files: [{}], commitSha: '1234567890' }),
      downloadGitHubUserApiSnapshot: async() => [],
    },
    '@common/utils/nodejs': { readFile() {} },
    '@common/utils/electron': { openUrl() {} },
    '@renderer/utils/musicSdk/api-source-info': {
      __esModule: true,
      default: [{ id: 'builtin', disabled: false }],
    },
    '@renderer/store': { userApi },
    '@renderer/store/setting': {
      appSetting,
      setApiSource: id => {
        sourceChanges.push(id)
        appSetting['common.apiSource'] = id
      },
    },
    '@common/utils/vueTools': {
      computed: callback => callback,
      ref: value => ({ value }),
    },
    '@renderer/plugins/Dialog': { dialog: message => { dialogs.push(message) } },
    '@common/projectIdentity': { PROJECT_IDENTITY: { repositoryUrl: 'https://example.test' } },
    './UserApiOnlineImportModal.vue': {},
  })
  const vm = {
    modelValue: true,
    githubAction: '',
    githubStatus: '',
    githubViewGeneration: 1,
    apiList: userApi.list,
    $dialog: { confirm: async() => true },
    $t: key => key,
  }
  vm.isGitHubViewCurrent = (...args) => component.methods.isGitHubViewCurrent.call(vm, ...args)
  vm.formatGitHubError = (...args) => component.methods.formatGitHubError.call(vm, ...args)
  vm.reconcileApiList = (...args) => component.methods.reconcileApiList.call(vm, ...args)

  return {
    appSetting,
    component,
    dialogs,
    removed,
    retainedFailure,
    retainedList,
    sourceChanges,
    userApi,
    vm,
    setRemoveImplementation(value) { removeImplementation = value },
  }
}

test('retained GitHub failure publishes its committed list and replaces a removed selected source', async() => {
  const harness = createHarness()
  await harness.component.methods.handleGitHubImport.call(harness.vm)

  assert.equal(harness.userApi.list, harness.retainedList)
  assert.deepEqual(harness.sourceChanges, ['builtin'])
  assert.equal(harness.appSetting['common.apiSource'], 'builtin')
  assert.deepEqual(harness.dialogs, ['user_api__github_error_generic'])
})

test('delete modal applies the committed callback list before surfacing cleanup failure', async() => {
  const harness = createHarness()
  harness.setRemoveImplementation(async(_ids, onCommittedList) => {
    onCommittedList(harness.retainedList)
    throw harness.retainedFailure
  })

  await assert.rejects(
    () => harness.component.methods.handleRemove.call(harness.vm, harness.removed),
    error => error === harness.retainedFailure,
  )
  assert.equal(harness.userApi.list, harness.retainedList)
  assert.deepEqual(harness.sourceChanges, ['builtin'])
})
