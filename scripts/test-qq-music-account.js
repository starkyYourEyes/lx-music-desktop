const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const data = new Map([['neteaseAccount', { cookie: 'keep-netease' }]])
const store = {
  get: key => data.get(key),
  set: (key, value) => data.set(key, value),
}
let loginResult = {
  state: 'success',
  message: '登录成功',
  cookie: 'uin=o123; qqmusic_key=secret',
}
let songError = null
class QQMusicAuthError extends Error {}
const loginService = {
  createLoginQr: async() => ({ key: 'opaque', qrimg: 'data:image/png;base64,AA==' }),
  checkLoginQr: async() => loginResult,
}
const songService = {
  getGuessLikeSongs: async() => {
    if (songError) throw songError
    return [{ id: 'tx_mid' }]
  },
}

const { createQQMusicAccountService } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/index.ts'),
  {
    '@common/constants': {
      DATA_KEYS: { qqMusicAccount: 'qqMusicAccount' },
      STORE_NAMES: { DATA: 'data' },
    },
    '@main/utils/store': () => store,
    './login': {
      createQQMusicLoginService: () => loginService,
    },
    './song': {
      createQQMusicSongService: () => songService,
      isQQMusicAuthError: error => error instanceof QQMusicAuthError,
    },
  },
)

const createFacade = () => createQQMusicAccountService({
  store,
  loginService,
  songService,
  now: () => 123456,
})

const main = async() => {
  const service = createFacade()
  assert.deepStrictEqual(service.getAccountStatus(), {
    isLoggedIn: false,
    profile: null,
  })
  assert.deepStrictEqual(await service.createLoginQr(), {
    key: 'opaque',
    qrimg: 'data:image/png;base64,AA==',
  })

  const result = await service.checkLoginQr('opaque')
  assert.deepStrictEqual(result, {
    state: 'success',
    message: '登录成功',
    isLoggedIn: true,
    profile: { uin: 'o123', nickname: 'QQ 音乐账号' },
  })
  assert.strictEqual(Object.hasOwn(result, 'cookie'), false)
  assert.deepStrictEqual(data.get('qqMusicAccount'), {
    cookie: 'uin=o123; qqmusic_key=secret',
    profile: { uin: 'o123', nickname: 'QQ 音乐账号' },
    updatedAt: 123456,
  })

  const restarted = createFacade()
  assert.deepStrictEqual(restarted.getAccountStatus(), {
    isLoggedIn: true,
    profile: { uin: 'o123', nickname: 'QQ 音乐账号' },
  })
  assert.deepStrictEqual(await restarted.getGuessLikeSongs(), [{ id: 'tx_mid' }])

  songError = new Error('network unavailable')
  await assert.rejects(restarted.getGuessLikeSongs(), /network unavailable/)
  assert.strictEqual(restarted.getAccountStatus().isLoggedIn, true)
  assert.deepStrictEqual(data.get('neteaseAccount'), { cookie: 'keep-netease' })

  songError = new QQMusicAuthError('expired')
  await assert.rejects(restarted.getGuessLikeSongs(), QQMusicAuthError)
  assert.deepStrictEqual(restarted.getAccountStatus(), {
    isLoggedIn: false,
    profile: null,
  })
  assert.deepStrictEqual(data.get('neteaseAccount'), { cookie: 'keep-netease' })

  songError = null
  loginResult = {
    state: 'success',
    message: '登录成功',
    cookie: 'qqmusic_uin=456; qqmusic_key=new-secret',
  }
  await restarted.checkLoginQr('new-opaque')
  assert.strictEqual(restarted.getAccountStatus().isLoggedIn, true)
  await restarted.logout()
  assert.deepStrictEqual(restarted.getAccountStatus(), {
    isLoggedIn: false,
    profile: null,
  })
  assert.deepStrictEqual(data.get('neteaseAccount'), { cookie: 'keep-netease' })
}

main().then(() => {
  console.log('QQ Music account tests passed')
}).catch(err => {
  console.error(err)
  process.exitCode = 1
})
