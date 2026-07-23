const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const {
  hash33,
  getGtk,
  getSetCookieValues,
  mergeCookieValues,
  getCookieValue,
  getQQMusicAccountUin,
  redactQQMusicSecret,
  createQrSessionStore,
} = loadTsModule(path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'))

assert.strictEqual(hash33('test-qrsig'), 1041100915)
assert.strictEqual(getGtk('test-p_skey'), 1737020733)

const structuredHeaders = {
  getSetCookie: () => [
    'uin=o123; Path=/; HttpOnly',
    'qqmusic_key=value=with=equals; Path=/',
    'uin=o456; Path=/',
  ],
  get: () => null,
}
assert.deepStrictEqual(getSetCookieValues(structuredHeaders), [
  'uin=o123; Path=/; HttpOnly',
  'qqmusic_key=value=with=equals; Path=/',
  'uin=o456; Path=/',
])
assert.strictEqual(
  mergeCookieValues(getSetCookieValues(structuredHeaders)),
  'uin=o456; qqmusic_key=value=with=equals',
)

const fallbackHeaders = {
  get: () => 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2; Path=/',
}
assert.strictEqual(mergeCookieValues(getSetCookieValues(fallbackHeaders)), 'a=1; b=2')
assert.strictEqual(getCookieValue('uin=old; uin=new', 'uin'), 'new')
assert.strictEqual(getQQMusicAccountUin('uin=o123; qqmusic_key=secret'), 'o123')
assert.strictEqual(getQQMusicAccountUin('qqmusic_uin=456; qm_keyst=alternate'), '456')
assert.strictEqual(getQQMusicAccountUin('qqmusic_key=secret'), '')
assert.strictEqual(getQQMusicAccountUin('uin=o123'), '')
assert.strictEqual(
  redactQQMusicSecret('Cookie: uin=o123; qqmusic_key=secret qrsig=qr-value code=oauth-code'),
  'Cookie: [REDACTED] qrsig=[REDACTED] code=[REDACTED]',
)
assert.strictEqual(
  redactQQMusicSecret('Cookie: uin=o123; qqmusic_key=secret\n    at fetch...'),
  'Cookie: [REDACTED]\n    at fetch...',
)
assert.strictEqual(
  redactQQMusicSecret('{"Cookie":"uin=o123; qqmusic_key=secret","other":"x"}'),
  '{"Cookie":"[REDACTED]","other":"x"}',
)
assert.strictEqual(
  redactQQMusicSecret('{"Cookie":"foo=\\"quoted\\"; qqmusic_key=music-secret","other":"x"}'),
  '{"Cookie":"[REDACTED]","other":"x"}',
)
assert.strictEqual(
  redactQQMusicSecret('Cookie: uin=o123; qrsig=qr-secret; qqmusic_key=music-secret\n    at fetch...'),
  'Cookie: [REDACTED]\n    at fetch...',
)

let now = 1000
let nextId = 0
const sessions = createQrSessionStore({
  now: () => now,
  idFactory: () => `session-${++nextId}`,
  ttlMs: 5000,
})
const key = sessions.create({ qrsig: 'qr', ptqrtoken: 7 })
assert.strictEqual(key, 'session-1')
assert.deepStrictEqual(sessions.get(key), { qrsig: 'qr', ptqrtoken: 7 })
now = 6001
assert.strictEqual(sessions.get(key), null)
assert.strictEqual(sessions.size(), 0)

console.log('QQ Music auth tests passed')
