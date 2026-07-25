const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const readSource = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

const ipcNames = readSource('src/common/ipcNames.ts')
const mainHandler = readSource('src/main/modules/winMain/rendererEvent/userApi.ts')
const rendererIpc = readSource('src/renderer/utils/ipc.ts')

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

console.log('GitHub user API IPC wiring tests passed')
