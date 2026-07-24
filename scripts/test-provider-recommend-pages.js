const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const exists = file => fs.existsSync(path.join(root, file))

const router = read('src/renderer/router.ts')
const navBar = read('src/renderer/components/layout/Aside/NavBar.vue')
const aside = read('src/renderer/components/layout/Aside/index.vue')
const neteasePage = read('src/renderer/views/Recommend/index.vue')
const defaultSetting = read('src/common/defaultSetting.ts')
const settingTypes = read('src/common/types/app_setting.d.ts')
const settingPage = read('src/renderer/views/Setting/components/SettingRecommend.vue')
const zhCN = read('src/lang/zh-cn.json')
const zhTW = read('src/lang/zh-tw.json')
const enUS = read('src/lang/en-us.json')

assert.match(router, /path:\s*'\/qq-recommend'[\s\S]*?views\/QQRecommend\/index\.vue/,
  'router should expose a dedicated QQ recommendation page')

assert(exists('src/renderer/assets/images/providers/netease-music.svg'),
  'NetEase Music logo should be bundled locally')
assert(exists('src/renderer/assets/images/providers/qq-music.svg'),
  'QQ Music logo should be bundled locally')

const neteaseMenuIndex = navBar.indexOf("to: '/recommend'")
const qqMenuIndex = navBar.indexOf("to: '/qq-recommend'")
const listMenuIndex = navBar.indexOf("to: '/list'")
assert(neteaseMenuIndex >= 0 && qqMenuIndex > neteaseMenuIndex && listMenuIndex > qqMenuIndex,
  'sidebar should order NetEase, QQ Music, then the library')
assert.match(navBar, /<img[^>]*item\.logo/,
  'provider entries should render their local logo images')
assert.match(navBar, /separator[\s\S]*index == 2/,
  'the navigation separator should follow both provider entries')

assert.match(aside, /handleQQMusicAction[\s\S]*?path:\s*'\/qq-recommend'/,
  'QQ account login should navigate to the QQ recommendation page')

assert(!/QQ|qq/.test(neteasePage),
  'the NetEase recommendation page should not own QQ login, data, or playback')

assert(exists('src/renderer/views/QQRecommend/index.vue'),
  'QQ recommendation page component should exist')
assert(exists('src/renderer/views/QQRecommend/useQQGuessLikeCard.ts'),
  'QQ Guess You Like card builder should exist')
assert(exists('src/renderer/views/QQRecommend/useQQDailyRecommendData.ts'),
  'QQ Daily 30 data facade should exist')
assert(exists('src/renderer/views/QQRecommend/useQQDailyRecommendCard.ts'),
  'QQ Daily 30 card builder should exist')
assert(exists('src/renderer/views/QQRecommend/useQQDailyRecommendPlayback.ts'),
  'QQ Daily 30 playback controller should exist')
assert(!exists('src/renderer/views/QQRecommend/useQQHomeRecommendDiagnostic.ts'),
  'QQ home recommendation diagnostic should be removed')

const qqPage = read('src/renderer/views/QQRecommend/index.vue')
const qqCard = read('src/renderer/views/QQRecommend/useQQGuessLikeCard.ts')
const qqDailyCard = read('src/renderer/views/QQRecommend/useQQDailyRecommendCard.ts')
const qqDailyPlayback = read('src/renderer/views/QQRecommend/useQQDailyRecommendPlayback.ts')
const songListAction = read('src/renderer/store/songList/action.ts')
const specialCards = read('src/renderer/views/Recommend/components/SpecialCards.vue')
assert.match(qqPage, /useQQGuessLikeData/,
  'QQ page should own Guess You Like data')
assert.match(qqPage, /useQQMusicLoginQr/,
  'QQ page should own QQ QR login')
assert.doesNotMatch(qqPage, /useQQHomeRecommendDiagnostic|inspectHomeRecommend|resetHomeRecommendDiagnostic/,
  'QQ page should not request or log QQ home recommendations')
assert.match(qqPage, /Promise\.allSettled\(\[loadQQGuessLikeSongs\(\), loadQQDailyRecommendSongs\(\)\]\)/,
  'QQ page should independently load both recommendations for a signed-in account')
assert.match(qqCard, /登录 QQ 音乐后获取猜你喜欢/,
  'signed-out QQ page should show a stable login entry')
assert.match(qqCard, /img:\s*song\?\.meta\.picUrl/,
  'Guess You Like should use the first song artwork')
assert.match(qqDailyCard, /QQ_DAILY_RECOMMEND_LIST_ID/,
  'Daily 30 card should use the shared Daily recommendation id')
assert.match(qqDailyCard, /source:\s*'tx'/,
  'Daily 30 card should resolve through the QQ provider')
assert.match(qqDailyCard, /name:\s*'\u6bcf\u65e530\u9996'/,
  'Daily 30 card should use its product title')
assert.match(qqDailyCard, /isQQDailyRecommend:\s*true/,
  'Daily 30 card should have a dedicated marker')
assert.match(qqDailyCard, /img:\s*song\?\.meta\.picUrl/,
  'Daily 30 card should use the first song artwork')
assert.match(qqDailyCard, /getKicker:\s*\(\)\s*=>\s*'Daily 30'/,
  'Daily 30 card should expose its kicker')
assert.match(qqPage, /const cards = computed\(\(\) => \[guessLikeCard\.value, dailyRecommendCard\.value\]\)/,
  'QQ page should show Guess You Like before Daily 30')
assert.match(qqPage, /@open="handleCardOpen"/,
  'card body opens should use a dedicated handler')
assert.match(qqPage, /@toggle-card-play="handleCardPlay"/,
  'card cover play controls should use a dedicated handler')
assert.match(qqPage, /Promise\.allSettled\(/,
  'Guess You Like and Daily 30 should load independently')
assert.match(qqDailyPlayback, /isQQDailyRecommendListActive/,
  'Daily 30 playback should track its shared temporary list')
assert.match(qqDailyPlayback, /playQQDailyRecommend/,
  'Daily 30 playback should activate the shared temporary list')
assert.match(qqDailyPlayback, /path:\s*'\/songList\/detail'/,
  'Daily 30 card body should navigate to its detail page')
assert.match(songListAction, /isQQDailyRecommendPlaylist/,
  'song list loader should recognize the QQ Daily 30 id')
assert.match(songListAction, /getQQDailyRecommendPlaylistDetail\(isRefresh, getQQMusicAccountKey\(\)\)/,
  'song list loader should use the local QQ Daily 30 metadata loader')
assert.match(specialCards, /@keydown\.enter\.self="\$emit\('open', playlist\)"/,
  'card Enter handling should ignore nested cover-play button events')
assert.match(specialCards, /@keydown\.space\.self\.prevent="\$emit\('open', playlist\)"/,
  'card Space handling should ignore nested cover-play button events')
assert.match(specialCards, /@click="\$emit\('open', playlist\)"/,
  'card mouse click handling should remain available outside the cover-play button')
assert.match(qqCard, /`\$\{song\.name\} · \$\{song\.singer\}`/,
  'Guess You Like subtitle should combine first song name and singer')

for (const [name, source] of [
  ['default settings', defaultSetting],
  ['setting types', settingTypes],
  ['setting component', settingPage],
]) {
  assert(!source.includes('recommend.qqGuessLikeLoggedOutVisible'),
    `${name} should not retain the obsolete logged-out QQ setting`)
}

for (const [name, source] of [
  ['Simplified Chinese', zhCN],
  ['Traditional Chinese', zhTW],
  ['English', enUS],
]) {
  assert(source.includes('netease_recommend') && source.includes('qq_recommend'),
    `${name} should include provider-specific navigation labels`)
  assert(!source.includes('setting__recommend_qq_guess_like_logged_out_visible'),
    `${name} should remove the obsolete QQ setting label`)
}

console.log('provider recommendation page wiring tests passed')
