const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

const settingKeys = [
  'list.platformPlaylists.netease.created',
  'list.platformPlaylists.netease.collected',
  'list.platformPlaylists.qq_music.created',
  'list.platformPlaylists.qq_music.collected',
  'list.platformPlaylists.kugou.created',
  'list.platformPlaylists.kugou.collected',
]

test('platform playlist settings are declared as booleans and default to enabled', () => {
  const types = read('src/common/types/app_setting.d.ts')
  const defaults = read('src/common/defaultSetting.ts')

  for (const key of settingKeys) {
    assert.match(types, new RegExp(`'${key.replaceAll('.', '\\.')}'\\s*:\\s*boolean`))
    assert.match(defaults, new RegExp(`'${key.replaceAll('.', '\\.')}'\\s*:\\s*true`))
  }
})

test('all locales provide platform and playlist kind labels', () => {
  for (const locale of ['zh-cn', 'zh-tw', 'en-us']) {
    const messages = JSON.parse(read(`src/lang/${locale}.json`))
    for (const key of [
      'platform_playlist__provider_netease',
      'platform_playlist__provider_qq_music',
      'platform_playlist__provider_kugou',
      'platform_playlist__kind_created',
      'platform_playlist__kind_collected',
    ]) {
      assert.equal(typeof messages[key], 'string', `${locale} is missing ${key}`)
      assert.notEqual(messages[key], '')
    }
  }
})
