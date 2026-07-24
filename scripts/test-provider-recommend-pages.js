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

const qqPage = read('src/renderer/views/QQRecommend/index.vue')
const qqCard = read('src/renderer/views/QQRecommend/useQQGuessLikeCard.ts')
assert.match(qqPage, /useQQGuessLikeData/,
  'QQ page should own Guess You Like data')
assert.match(qqPage, /useQQMusicLoginQr/,
  'QQ page should own QQ QR login')
assert.doesNotMatch(qqPage, /HomeRecommend|homeRecommend/,
  'QQ page should not contain home recommendation diagnostics')
assert.match(qqPage, /await loadQQGuessLikeSongs\(\)/,
  'QQ page should automatically load recommendations for a signed-in account')
assert.match(qqPage, /const cards = computed\(\(\) => \[card\.value\]\)/,
  'QQ page should expose one Guess You Like card')
const unmountBody = qqPage.match(/onBeforeUnmount\(\(\) => \{([\s\S]*?)\n\}\)/)?.[1] ?? ''
assert.match(unmountBody, /window\.removeEventListener\('show-qq-music-login'/,
  'QQ page should remove its login event listener on unmount')
assert.doesNotMatch(unmountBody, /reset|clear/,
  'leaving the QQ page should preserve playback and queue state')
assert.match(qqCard, /登录 QQ 音乐后获取猜你喜欢/,
  'signed-out QQ page should show a stable login entry')
assert.match(qqCard, /img:\s*song\?\.meta\.picUrl/,
  'Guess You Like should use the first song artwork')
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

assert.doesNotMatch(router, /path:\s*'\/local-music'/,
  'provider navigation should not add a local music route')
assert.doesNotMatch(navBar, /to:\s*'\/local-music'/,
  'provider navigation should not add a local music menu item')

console.log('provider recommendation page wiring tests passed')
