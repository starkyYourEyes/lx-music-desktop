const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('manual list refresh includes independent platform refreshes', () => {
  const useListUpdate = read('src/renderer/views/List/MyList/useListUpdate.ts')
  const action = read('src/renderer/store/platformPlaylists/action.ts')
  assert.match(useListUpdate, /refreshPlatformUserPlaylists\(\{ force: true \}\)/)
  assert.match(action, /group\.status = 'loading'/)
  assert.match(action, /group\.status = code == 'platform_playlist_unsupported'/)
  assert.match(action, /\? 'unsupported' : 'error'/)
})

test('source list fetch writes only after successful fetch', () => {
  const source = read('src/renderer/store/list/syncSourceList.ts')
  assert.match(source, /const list = await fetchList/)
  assert.match(source, /overwriteListMusics\(\{ listId: targetListInfo\.id, musicInfos: list \}\)/)
})
