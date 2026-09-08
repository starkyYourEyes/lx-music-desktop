const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('settings page exposes all grouped platform playlist switches', () => {
  const source = read('src/renderer/views/Setting/components/SettingList.vue')
  assert.match(source, /\['netease', 'qq_music', 'kugou'\]/)
  assert.match(source, /platform_playlist__provider_\$\{provider\}/)
  assert.match(source, /list\.platformPlaylists\.\$\{provider\}\.\$\{kind\}/)
  assert.match(source, /platform_playlist__kind_created/)
  assert.match(source, /platform_playlist__kind_collected/)
})

test('setting migration fills missing platform playlist switches', () => {
  const source = read('src/common/utils/migrateSetting.ts')
  assert.match(source, /platformPlaylists/)
  assert.match(source, /setting\[key\] = true/)
})
