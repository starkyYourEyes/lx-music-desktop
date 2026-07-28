const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const deletedFiles = [
  'src/main/modules/winMain/autoUpdate.ts',
  'src/renderer/core/useApp/useUpdate.ts',
  'src/renderer/components/layout/UpdateModal.vue',
  'src/renderer/components/layout/ChangeLogModal.vue',
  'src/renderer/utils/update.js',
]
const inspectedFiles = [
  'src/main/modules/winMain/index.ts',
  'src/renderer/core/useApp/index.ts',
  'src/renderer/App.vue',
  'src/renderer/components/layout/PactModal.vue',
  'src/renderer/utils/ipc.ts',
  'src/common/ipcNames.ts',
  'src/renderer/store/index.ts',
  'src/common/defaultSetting.ts',
  'src/common/types/app_setting.d.ts',
  'src/common/types/common.d.ts',
  'src/common/constants.ts',
]

test('application updater files and wiring are absent', () => {
  for (const file of deletedFiles) assert.equal(fs.existsSync(path.join(root, file)), false, file)
  const source = inspectedFiles.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n')
  for (const pattern of [
    /electron-updater/,
    /initUpdate/,
    /useUpdate/,
    /checkUpdate/,
    /UpdateModal/,
    /ChangeLogModal/,
    /versionInfo/,
    /isShowChangeLog/,
    /tryAutoUpdate/,
    /showChangeLog/,
    /ignoreVersion/,
    /lastStartInfo/,
    /update_(?:check|available|error|progress|downloaded|not_available)/,
  ]) assert.doesNotMatch(source, pattern)
})

test('application update translations and dependency are absent', () => {
  const pkg = require('../package.json')
  assert.equal(Object.hasOwn(pkg.devDependencies, 'electron-updater'), false)
  for (const locale of ['en-us', 'zh-cn', 'zh-tw']) {
    const messages = JSON.parse(fs.readFileSync(path.join(root, `src/lang/${locale}.json`), 'utf8'))
    const staleKeys = Object.keys(messages).filter(key => key.startsWith('update__') || key.startsWith('setting__update_'))
    assert.deepEqual(staleKeys, [], locale)
  }
})
