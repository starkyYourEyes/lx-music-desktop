const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const userApiTypes = read('src/common/types/user_api_sync.d.ts')
assert.match(userApiTypes, /type\s+SyncMode\s*=\s*'merge'\s*\|\s*'overwrite'/)
assert.match(userApiTypes, /interface\s+Meta\s*{[\s\S]*md5:\s*string[\s\S]*updatedAt:\s*number[\s\S]*count:\s*number[\s\S]*}/)
assert.match(userApiTypes, /user_api_data_changed/)
assert.doesNotMatch(userApiTypes, /user_api_data_overwrite/)

const userApiEvent = read('src/main/modules/sync/userApiEvent.ts')
assert.match(
  userApiEvent,
  /from ['"]@main\/modules\/userApi['"]/,
)
assert.doesNotMatch(userApiEvent, /@main\/modules\/userApi\/utils/)


const syncCommonTypes = read('src/main/types/sync_common.d.ts')
assert.match(syncCommonTypes, /user_api_get_meta/)
assert.match(syncCommonTypes, /user_api_pull/)
assert.match(syncCommonTypes, /user_api_push/)
assert.doesNotMatch(syncCommonTypes, /user_api_sync_get_md5/)
assert.doesNotMatch(syncCommonTypes, /user_api_sync_set_data/)

const clientModules = read('src/main/modules/sync/client/modules/index.ts')
assert.match(clientModules, /userApi:\s*2/)

const serverModules = read('src/main/modules/sync/server/modules/index.ts')
assert.match(serverModules, /userApi:\s*2/)

const clientFeatureHandler = read('src/main/modules/sync/client/sync/handler.ts')
assert.match(clientFeatureHandler, /supportedFeatures\.userApi\s*>=\s*featureVersion\.userApi/)
assert.match(clientFeatureHandler, /skipSnapshot:\s*true/)

const clientUserApiHandler = read('src/main/modules/sync/client/modules/userApi/handler.ts')
assert.match(clientUserApiHandler, /user_api_sync_finished/)
assert.doesNotMatch(clientUserApiHandler, /user_api_sync_get_md5/)
assert.doesNotMatch(clientUserApiHandler, /registerUserApiActionEvent/)
assert.strictEqual(fs.existsSync(path.join(root, 'src/main/modules/sync/client/modules/userApi/localEvent.ts')), false)

const serverUserApiSync = read('src/main/modules/sync/server/modules/userApi/sync/sync.ts')
assert.match(serverUserApiSync, /user_api_sync_finished/)
assert.doesNotMatch(serverUserApiSync, /user_api_sync_get_md5/)
assert.doesNotMatch(serverUserApiSync, /user_api_sync_set_data/)

const settingBasic = read('src/renderer/views/Setting/components/SettingBasic.vue')
assert.match(settingBasic, /handleUserApiSync/)
assert.match(settingBasic, /user_api_pull/)
assert.match(settingBasic, /user_api_push/)
assert.match(settingBasic, /user_api_sync__pull_merge/)
assert.match(settingBasic, /user_api_sync__push_overwrite/)
assert.match(settingBasic, /message\.includes\('user_api_push_not_allowed'\)\s*\?\s*t\('user_api_sync__push_not_allowed'\)/)

assert.match(read('src/common/defaultSetting.ts'), /'sync\.server\.allowUserApiPush':\s*false/)
assert.match(read('src/common/types/app_setting.d.ts'), /'sync\.server\.allowUserApiPush':\s*boolean/)
const syncServer = read('src/renderer/views/Setting/components/SettingSync/SyncServer.vue')
assert.match(syncServer, /updateSetting\(\{ 'sync\.server\.allowUserApiPush': \$event \}\)/)
assert.match(syncServer, /setting__sync_server_allow_user_api_push_tip/)
for (const lang of ['zh-cn', 'zh-tw', 'en-us']) {
  const translations = JSON.parse(read(`src/lang/${lang}.json`))
  for (const key of ['setting__sync_server_allow_user_api_push', 'setting__sync_server_allow_user_api_push_tip', 'user_api_sync__push_not_allowed']) {
    assert.equal(typeof translations[key], 'string')
    assert.ok(translations[key].length)
  }
}

console.log('user api sync v2 wiring tests passed')
