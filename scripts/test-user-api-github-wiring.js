const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const readSource = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

const ipcNames = readSource('src/common/ipcNames.ts')
const mainHandler = readSource('src/main/modules/winMain/rendererEvent/userApi.ts')
const rendererIpc = readSource('src/renderer/utils/ipc.ts')
const userApiModal = readSource('src/renderer/views/Setting/components/UserApiModal.vue')
const locales = ['zh-cn', 'zh-tw', 'en-us'].map(locale => ({
  locale,
  messages: JSON.parse(readSource(`src/lang/${locale}.json`)),
}))

assert.match(
  ipcNames,
  /replace_user_api_from_github:\s*'replace_user_api_from_github'/,
)
assert.match(
  mainHandler,
  /mainHandle<LX\.UserApi\.GitHubImportItem\[\],\s*LX\.UserApi\.UserApiInfo\[\]>/,
)
assert.match(mainHandler, /replaceApisFromGitHub\(items\)/)
assert.match(rendererIpc, /export const replaceUserApisFromGitHub/)
assert.match(
  rendererIpc,
  /rendererInvoke<LX\.UserApi\.GitHubImportItem\[\],\s*LX\.UserApi\.UserApiInfo\[\]>/,
)
assert.match(
  rendererIpc,
  /WIN_MAIN_RENDERER_EVENT_NAME\.replace_user_api_from_github/,
)

assert.match(
  userApiModal,
  /import\s*{[^}]*getGitHubUserApiSnapshot[^}]*downloadGitHubUserApiSnapshot[^}]*}\s*from\s*['"]@renderer\/utils\/githubUserApi['"]/s,
)
assert.match(
  userApiModal,
  /import\s*{[^}]*replaceUserApisFromGitHub[^}]*}\s*from\s*['"]@renderer\/utils\/ipc['"]/s,
)
assert.match(userApiModal, /getGitHubUserApiSnapshot\(\)/)
assert.match(userApiModal, /downloadGitHubUserApiSnapshot\(snapshot\)/)
assert.match(userApiModal, /replaceUserApisFromGitHub\(items\)/)
assert.match(userApiModal, /this\.\$dialog\.confirm/)
assert.match(userApiModal, /user_api__github_test/)
assert.match(userApiModal, /user_api__github_import/)
assert.match(userApiModal, /aria-expanded/)
assert.match(userApiModal, /#icon-down/)
assert.match(userApiModal, /api\.remote\?\.group/)
assert.doesNotMatch(userApiModal, /this\.userApi\.list\.length\s*>\s*20/)
assert.match(
  userApiModal,
  /@media \(max-width: 420px\)[\s\S]*<\/style>\s*$/,
)

const translationKeys = [
  'user_api__github_test',
  'user_api__github_testing',
  'user_api__github_import',
  'user_api__github_importing',
  'user_api__github_local_group',
  'user_api__github_test_success',
  'user_api__github_import_confirm',
  'user_api__github_import_success',
  'user_api__github_error_rate_limit',
  'user_api__github_error_http',
  'user_api__github_error_tree',
  'user_api__github_error_version',
  'user_api__github_error_scripts',
  'user_api__github_error_limit',
  'user_api__github_error_invalid_script',
  'user_api__github_error_generic',
]

for (const { locale, messages } of locales) {
  for (const key of translationKeys) {
    assert.equal(
      typeof messages[key],
      'string',
      `${locale} is missing ${key}`,
    )
    assert.ok(messages[key].trim(), `${locale} has an empty ${key}`)
    if (locale != 'en-us') {
      assert.match(messages[key], /[^\u0000-\u007f]/, `${locale} has corrupted ${key}`)
    }
  }
}

console.log('GitHub user API IPC wiring tests passed')
