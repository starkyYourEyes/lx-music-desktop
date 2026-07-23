const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const aside = fs.readFileSync(path.join(root, 'src/renderer/components/layout/Aside/index.vue'), 'utf8')

assert.match(
  aside,
  /import\s*{[^}]*initQQMusicAccount[^}]*isLoggedIn\s+as\s+qqIsLoggedIn[^}]*logoutQQMusicAccount[^}]*profile\s+as\s+qqProfile[^}]*}\s*from\s*'@renderer\/store\/qqMusic'/s,
  'Aside should import the QQ Music account store with explicit QQ aliases',
)

assert.match(
  aside,
  /import\s*{[^}]*initNeteaseAccount[^}]*isLoggedIn\s+as\s+neteaseIsLoggedIn[^}]*logoutNeteaseAccount[^}]*profile\s+as\s+neteaseProfile[^}]*}\s*from\s*'@renderer\/store\/netease'/s,
  'Aside should import the NetEase account store with explicit NetEase aliases',
)

assert.strictEqual(
  (aside.match(/:class="\$style\.providerRow"/g) || []).length,
  2,
  'Aside should render exactly two stable provider rows',
)
assert.match(aside, />QQ 音乐</)
assert.match(aside, />网易云音乐</)

assert.match(
  aside,
  /const\s+logoProfile\s*=\s*computed\(\(\)\s*=>[\s\S]*?neteaseProfile\.value\)/,
  'The top-level avatar should remain based on the NetEase profile',
)
assert.doesNotMatch(
  aside,
  /const\s+logoProfile[^\n]*qqProfile/,
  'QQ Music login should not replace the top-level avatar',
)

const qqAction = aside.match(/const\s+handleQQMusicAction[\s\S]*?(?=const\s+handleNeteaseAction)/)?.[0] || ''
const neteaseAction = aside.match(/const\s+handleNeteaseAction[\s\S]*?(?=onMounted\()/)?.[0] || ''
assert.match(qqAction, /logoutQQMusicAccount\(\)/)
assert.doesNotMatch(qqAction, /logoutNeteaseAccount\(\)/)
assert.match(neteaseAction, /logoutNeteaseAccount\(\)/)
assert.doesNotMatch(neteaseAction, /logoutQQMusicAccount\(\)/)

assert.match(
  qqAction,
  /if\s*\(route\.path\s*==\s*'\/recommend'\)\s*window\.dispatchEvent\(new Event\('show-qq-music-login'\)\)/,
  'QQ Music login should dispatch its event only while already on the recommend page',
)
assert.match(
  neteaseAction,
  /if\s*\(route\.path\s*==\s*'\/recommend'\)\s*window\.dispatchEvent\(new Event\('show-netease-login'\)\)/,
  'NetEase login should dispatch its event only while already on the recommend page',
)
assert.match(qqAction, /router\.push\([\s\S]*?login:\s*'qq'/)
assert.match(neteaseAction, /router\.push\([\s\S]*?login:\s*'netease'/)
assert.doesNotMatch(aside, /login:\s*'1'/)

assert.match(
  aside,
  /Promise\.all\(\[\s*initQQMusicAccount\(\)\.catch\(\(\)\s*=>\s*null\),\s*initNeteaseAccount\(\)\.catch\(\(\)\s*=>\s*null\),?\s*]\)/s,
  'QQ Music and NetEase account initialization should run independently in parallel',
)

console.log('QQ Music account menu wiring tests passed')
