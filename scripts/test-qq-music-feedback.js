const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

class QQMusicAuthError extends Error {
  constructor(message = 'QQ Music login expired') {
    super(message)
    this.name = 'QQMusicAuthError'
  }
}

const timers = []
const calls = []
let payloads = []
const fetchImpl = async(url, options) => {
  calls.push({ url: String(url), options })
  return {
    ok: true,
    status: 200,
    json: async() => payloads.shift(),
  }
}
const { createQQMusicFeedbackService } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/feedback.ts'),
  {
    './auth': {
      getCookieValue: (cookie, name) => cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] ?? '',
      getGtk: () => 5381,
    },
    './request': {
      createQQMusicFallbackGuid: uin => `guid-${uin}`,
      createQQMusicFallbackUid: uin => `uid-${uin}`,
      createQQMusicRequestSign: () => 'synthetic-sign',
    },
    './song': { QQMusicAuthError },
  },
)

const cookie = 'uin=o10001; qqmusic_key=synthetic-key; tmeLoginType=2'
const song = (meta = { id: 12345, songType: 7 }) => ({
  id: 'tx_mid',
  source: 'tx',
  name: 'Synthetic song',
  singer: 'Synthetic singer',
  interval: null,
  meta,
})
const createService = (getCookie = () => cookie) => createQQMusicFeedbackService({
  fetchImpl,
  getCookie,
  setTimeoutImpl: (callback, delay) => {
    const timer = { callback, delay }
    timers.push(timer)
    return timer
  },
  clearTimeoutImpl: () => {},
})

const parseLastBody = () => JSON.parse(calls.at(-1).options.body)

const main = async() => {
  const service = createService()
  payloads.push({ code: 0, req_1: { code: 0, data: { retCode: 0 } } })
  await service.likeMusic(song())
  assert.deepStrictEqual(parseLastBody().req_1, {
    module: 'music.musicasset.PlaylistDetailWrite',
    method: 'AddSonglist',
    param: {
      dirId: 201,
      tid: 0,
      bFmtUtf8: true,
      v_songInfo: [{ songId: 12345, songType: 7 }],
    },
  })
  assert.strictEqual(calls.at(-1).options.headers.Cookie, cookie)
  const likeCall = calls.at(-1)
  const likeUrl = new URL(likeCall.url)
  const likeBody = JSON.parse(likeCall.options.body)
  assert.strictEqual(likeUrl.origin, 'https://u.y.qq.com')
  assert.strictEqual(likeUrl.pathname, '/cgi-bin/musicu.fcg')
  assert.strictEqual(likeUrl.search, '')
  assert.deepStrictEqual({
    uid: likeBody.comm.uid,
    qq: likeBody.comm.qq,
    authst: likeBody.comm.authst,
    loginUin: likeBody.comm.loginUin,
    tmeLoginType: likeBody.comm.tmeLoginType,
    tmeAppID: likeBody.comm.tmeAppID,
  }, {
    uid: '10001',
    qq: '10001',
    authst: 'synthetic-key',
    loginUin: '10001',
    tmeLoginType: 2,
    tmeAppID: 'qqmusic',
  })

  payloads.push({ code: 0, req_1: { code: 0, data: { retCode: 0 } } })
  const wxService = createService(
    () => 'uin=o10001; qqmusic_key=W_X_synthetic-key',
  )
  await wxService.likeMusic(song())
  assert.strictEqual(parseLastBody().comm.tmeLoginType, 1)

  payloads.push({ code: 0, req_1: { code: 0, data: { Retcode: 0 } } })
  await service.dislikeMusic(song())
  assert.deepStrictEqual(parseLastBody().req_1, {
    module: 'music.feedback.FeedbackBlack',
    method: 'AddDislike',
    param: { Songs: [{ ID: '12345' }] },
  })
  const dislikeUrl = new URL(calls.at(-1).url)
  assert.strictEqual(dislikeUrl.origin, 'https://u6.y.qq.com')
  assert.strictEqual(dislikeUrl.pathname, '/cgi-bin/musics.fcg')
  assert.strictEqual(dislikeUrl.searchParams.get('sign'), 'synthetic-sign')

  payloads.push({ code: 0, req_1: { code: 0, data: { retCode: 0 } } })
  await service.likeMusic(song({ songId: 67890 }))
  assert.deepStrictEqual(parseLastBody().req_1.param.v_songInfo, [
    { songId: 67890, songType: 0 },
  ])

  const fetchCount = calls.length
  await assert.rejects(createService(() => '').likeMusic(song()), error => error.name == 'QQMusicAuthError')
  await assert.rejects(service.likeMusic(song({ id: 'not-numeric' })), /QQ Music feedback request failed/)
  assert.strictEqual(calls.length, fetchCount)

  for (const failedPayload of [
    { code: 1, req_1: { code: 0, data: { retCode: 0 } } },
    { code: 0, req_1: { code: 1, data: { retCode: 0 } } },
    { code: 0, req_1: { code: 0, data: { retCode: 1 } } },
    { code: 0, req_1: { code: 0, data: { Retcode: 1 } } },
  ]) {
    payloads.push(failedPayload)
    await assert.rejects(
      failedPayload.req_1.data.Retcode == null
        ? service.likeMusic(song())
        : service.dislikeMusic(song()),
      error => error.message == 'QQ Music feedback request failed',
    )
  }

  payloads.push({ code: 1000, req_1: { code: 0, data: { retCode: 0 } } })
  await assert.rejects(service.likeMusic(song()), error => error.name == 'QQMusicAuthError')
  assert.strictEqual(timers.at(-1).delay, 10_000)

  const assertSanitizedFeedbackError = error => {
    assert.strictEqual(error.message, 'QQ Music feedback request failed')
    assert.doesNotMatch(error.message, /synthetic-key|10001|Cookie|https:/)
    return true
  }

  const httpFailureService = createQQMusicFeedbackService({
    fetchImpl: async() => ({ ok: false, status: 503 }),
    getCookie: () => cookie,
    setTimeoutImpl: () => ({}),
    clearTimeoutImpl: () => {},
  })
  await assert.rejects(httpFailureService.likeMusic(song()), assertSanitizedFeedbackError)

  let abortRequest
  const timeoutService = createQQMusicFeedbackService({
    fetchImpl: async(_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(new Error('https://secret.invalid Cookie=synthetic-key'))
      })
    }),
    getCookie: () => cookie,
    setTimeoutImpl: callback => {
      abortRequest = callback
      return {}
    },
    clearTimeoutImpl: () => {},
  })
  const timedOut = timeoutService.likeMusic(song())
  abortRequest()
  await assert.rejects(timedOut, assertSanitizedFeedbackError)
  console.log('QQ Music feedback service tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
