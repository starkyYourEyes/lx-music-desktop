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
const qqMusicMain = read('src/main/modules/qqMusic/index.ts')

for (const name of [
  'qq_music_get_account_status',
  'qq_music_login_qr_create',
  'qq_music_login_qr_check',
  'qq_music_login_qr_cancel',
  'qq_music_logout',
  'qq_music_get_guess_like_songs',
  'qq_music_get_daily_recommend_songs',
  'qq_music_get_home_recommendation',
  'qq_music_get_playlist_detail',
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
assert.match(types, /type GuessLikeApiVersion\s*=\s*'new'\s*\|\s*'legacy'/)
assert.match(types, /interface GuessLikeRequest\s*\{[\s\S]*?apiVersion\?:\s*GuessLikeApiVersion/)
assert.match(rendererIpc, /getQQMusicGuessLikeSongs\s*=\s*async\(\s*continuation = false,\s*apiVersion/)
assert.match(rendererIpc, /\{ continuation, apiVersion \}/)
assert.match(rendererIpc, /getQQMusicDailyRecommendSongs/)
assert.match(rendererIpc, /getQQMusicHomeRecommendation/)
assert.match(rendererIpc, /getQQMusicPlaylistDetail/)
assert.match(handlers, /getDailyRecommendSongs\(\)/)
assert.match(handlers, /getHomeRecommendation\(\)/)
assert.match(handlers, /getPlaylistDetail\(params\.id, params\.page\)/)
assert.match(rendererIpc, /rendererInvoke<LX\.QQMusic\.HomeRecommendation>/)
assert.match(types, /interface HomeRecommendation/)
assert.match(types, /interface PlaylistDetailParams/)
assert.match(types, /interface PlaylistDetailInfo/)
assert(!fs.existsSync(path.join(root, 'src/main/modules/qqMusic/recommend.ts')),
  'the obsolete generic portal request service should remain removed')
assert(fs.existsSync(path.join(root, 'src/main/modules/qqMusic/homeRecommend.ts')),
  'the normalized personalized home service should exist')
assert.doesNotMatch(qqMusicMain, /createQQMusicRecommendService/,
  'the obsolete generic portal request service should not return')
assert.match(qqMusicMain, /createQQMusicHomeRecommendService/)
assert.match(qqMusicMain, /getHomeRecommendation/)
assert.match(qqMusicMain, /createQQMusicPlaylistDetailService/)
assert.match(qqMusicMain, /getPlaylistDetail/)

const publicTypeBodies = [...types.matchAll(/interface (?:Profile|AccountStatus|LoginQr|LoginQrCheck)\s*\{([\s\S]*?)\n\s*\}/g)]
  .map(match => match[1]).join('\n')
assert.doesNotMatch(publicTypeBodies, /\b(cookie|qrsig|ptqrtoken|code)\s*:/i)
assert.doesNotMatch(rendererIpc, /\b(cookie|qrsig|ptqrtoken)\b/i)
assert.match(
  handlers,
  /mainHandle<string,\s*LX\.QQMusic\.LoginQr>\([\s\S]*?qq_music_login_qr_create[\s\S]*?Date\.now\(\)/,
)
assert.match(
  handlers,
  /mainHandle<string,\s*void>\([\s\S]*?qq_music_login_qr_cancel[\s\S]*?cancelLoginQr\(requestId\)/,
)
assert.strictEqual(
  (handlers.match(/isQQMusicLoginRequestId\(requestId\)/g) || []).length,
  2,
)
assert.match(
  handlers,
  /event_app\.on\('main_window_close'[\s\S]*?disposeLoginQr/,
)
assert.match(
  rendererIpc,
  /createQQMusicLoginQr\s*=\s*async\(requestId:\s*string\)/,
)
assert.match(
  rendererIpc,
  /cancelQQMusicLoginQr\s*=\s*async\(requestId:\s*string\)/,
)
assert.match(
  rendererIpc,
  /rendererInvoke<string,\s*void>\([\s\S]*?qq_music_login_qr_cancel/,
)
assert.doesNotMatch(
  rendererIpc,
  /qq_music_login_qr_(?:create|cancel)[\s\S]{0,180}\b(cookie|qrsig|ptqrtoken|code)\b/i,
)

console.log('QQ Music IPC security tests passed')
