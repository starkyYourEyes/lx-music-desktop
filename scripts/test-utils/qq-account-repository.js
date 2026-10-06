const assert = require('node:assert/strict')
// In-memory account-repository contract over the legacy test's inspection Map.
// No disk store, credential vault or real provider is touched.
const accountRepository = data => ({
  getStatus(provider) {
    assert.equal(provider, 'qq_music')
    const current = data.get('qqMusicAccount')
    return { loggedIn: !!current?.cookie, profile: current?.profile ?? null, updatedAtMs: current?.updatedAt ?? null }
  },
  getCookie(provider) {
    assert.equal(provider, 'qq_music')
    return data.get('qqMusicAccount')?.cookie ?? null
  },
  async save(provider, value) {
    assert.equal(provider, 'qq_music')
    data.set('qqMusicAccount', { cookie: value.cookie, profile: value.profile, updatedAt: value.updatedAtMs })
    return { persistence: 'memory-only' }
  },
  async clear(provider) { assert.equal(provider, 'qq_music'); data.set('qqMusicAccount', { cookie: '', profile: null, updatedAt: 0 }) },
})
const musicUrlAuthorization = { transition: async(source, commit) => { assert.equal(source, 'tx'); return (await commit()).value } }
module.exports = { accountRepository, musicUrlAuthorization }
