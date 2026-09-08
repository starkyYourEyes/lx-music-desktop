const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
const names = read('src/common/ipcNames.ts')
const handlers = read('src/main/modules/winMain/rendererEvent/kugouMusic.ts')
const handlerIndex = read('src/main/modules/winMain/rendererEvent/index.ts')
const rendererIpc = read('src/renderer/utils/ipc.ts')

const eventNames = [
  'kugou_music_get_account_status',
  'kugou_music_login_qr_create',
  'kugou_music_login_qr_check',
  'kugou_music_login_qr_cancel',
  'kugou_music_logout',
  'kugou_music_get_public_recommendation',
  'kugou_music_get_daily_recommend_songs',
  'kugou_music_get_style_recommendation',
  'kugou_music_get_private_fm',
  'kugou_music_get_rank_recommendation',
]

test('Kugou IPC names, registration, and wrappers are complete', () => {
  for (const name of eventNames) {
    assert.match(names, new RegExp(`${name}: '${name}'`))
    assert.match(handlers, new RegExp(name))
  }
  assert.match(handlerIndex, /import kugouMusic from '.\/kugouMusic'/)
  assert.strictEqual((handlerIndex.match(/kugouMusic\(\)/g) || []).length, 1)

  for (const wrapper of [
    'getKugouMusicAccountStatus', 'createKugouMusicLoginQr', 'checkKugouMusicLoginQr',
    'cancelKugouMusicLoginQr', 'logoutKugouMusic', 'getKugouPublicRecommendation',
    'getKugouDailyRecommendSongs', 'getKugouStyleRecommendation', 'getKugouPrivateFmSongs',
    'getKugouRankRecommendation',
  ]) assert.match(rendererIpc, new RegExp(`export const ${wrapper}`))
})

test('Kugou handlers map each channel to its matching main accessor', () => {
  const mappings = [
    ['kugou_music_get_account_status', 'getAccountStatus'],
    ['kugou_music_login_qr_create', 'createLoginQr'],
    ['kugou_music_login_qr_check', 'checkLoginQr'],
    ['kugou_music_login_qr_cancel', 'cancelLoginQr'],
    ['kugou_music_logout', 'logout'],
    ['kugou_music_get_public_recommendation', 'getPublicRecommendation'],
    ['kugou_music_get_daily_recommend_songs', 'getDailyRecommendSongs'],
    ['kugou_music_get_style_recommendation', 'getStyleRecommendation'],
    ['kugou_music_get_private_fm', 'getPrivateFmSongs'],
    ['kugou_music_get_rank_recommendation', 'getRankRecommendation'],
  ]
  for (const [name, accessor] of mappings) {
    const start = handlers.indexOf(name)
    assert.notEqual(start, -1)
    const end = handlers.indexOf('\n  })', start)
    assert.match(handlers.slice(start, end == -1 ? undefined : end), new RegExp(`\\b${accessor}\\(`))
  }
  assert.match(handlers, /UUID_V4_PATTERN/)
  assert.strictEqual((handlers.match(/assertRequestId\(requestId/g) || []).length, 4)
})

test('Kugou IPC boundary excludes credentials, QR keys, and raw upstream values', () => {
  assert.doesNotMatch(rendererIpc, /kugou_music_[\s\S]{0,240}\b(cookie|token|qrcode|qrkey|upstream)\b/i)
  assert.doesNotMatch(handlers, /return\s+(?:result|response|payload)\b/)
  assert.match(handlers, /sanitizeAccountStatus/)
  assert.match(handlers, /sanitizeLoginQr/)
  assert.match(handlers, /sanitizeLoginQrCheck/)
  assert.match(handlers, /sanitizeSongs/)
  assert.match(handlers, /sanitizePlaylist/)
  assert.match(handlers, /sanitizeRank/)
  assert.doesNotMatch(`${rendererIpc}\n${handlers}`, /KUGOU_API_(?:MID|GUID|DEV|WEBGL)/)
})
