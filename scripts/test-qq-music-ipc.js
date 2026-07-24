const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

const types = read('src/common/types/qq_music.d.ts')
const names = read('src/common/ipcNames.ts')
const handlers = read('src/main/modules/winMain/rendererEvent/qqMusic.ts')
const handlerIndex = read('src/main/modules/winMain/rendererEvent/index.ts')
const rendererIpc = read('src/renderer/utils/ipc.ts')
const mainTypes = read('src/main/types/common.d.ts')
const rendererTypes = read('src/renderer/types/common.d.ts')

for (const name of [
  'qq_music_get_account_status',
  'qq_music_login_qr_create',
  'qq_music_login_qr_check',
  'qq_music_logout',
  'qq_music_get_guess_like_songs',
]) {
  assert.match(names, new RegExp(`${name}: '${name}'`))
  assert.match(handlers, new RegExp(name))
}
assert.match(handlerIndex, /import qqMusic from '.\/qqMusic'/)
assert.match(handlerIndex, /qqMusic\(\)/)
assert.match(mainTypes, /@common\/types\/qq_music/)
assert.match(rendererTypes, /@common\/types\/qq_music/)
assert.match(rendererIpc, /getQQMusicAccountStatus/)
assert.match(rendererIpc, /createQQMusicLoginQr/)
assert.match(rendererIpc, /checkQQMusicLoginQr/)
assert.match(rendererIpc, /logoutQQMusic/)
assert.match(rendererIpc, /getQQMusicGuessLikeSongs/)
assert.match(types, /interface GuessLikeRequest\s*\{[\s\S]*?continuation\?: boolean/)
assert.match(handlers, /getGuessLikeSongs\(params\)/)
assert.match(rendererIpc, /getQQMusicGuessLikeSongs = async\(continuation = false\)/)
assert.match(rendererIpc, /\{ continuation \}/)
assert.doesNotMatch(types, /HomeRecommendResponse/)
assert.doesNotMatch(handlers, /HomeRecommend|getHomeRecommend/)
assert.doesNotMatch(rendererIpc, /QQMusicHomeRecommend|QQMusic\.HomeRecommendResponse/)

const publicTypeBodies = [...types.matchAll(/interface (?:Profile|AccountStatus|LoginQr|LoginQrCheck)\s*\{([\s\S]*?)\n\s*\}/g)]
  .map(match => match[1]).join('\n')
assert.doesNotMatch(publicTypeBodies, /\b(cookie|qrsig|ptqrtoken|code)\s*:/i)
assert.doesNotMatch(rendererIpc, /\b(cookie|qrsig|ptqrtoken)\b/i)

console.log('QQ Music IPC security tests passed')
