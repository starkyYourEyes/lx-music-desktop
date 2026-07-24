const assert = require('node:assert')
const zlib = require('node:zlib')

const {
  decodeUserApiScript,
  createUserApiSyncData,
  createUserApiSyncMeta,
  createUserApiSyncMD5,
  assertUserApiSyncData,
  mergeUserApiSyncData,
} = require('../src/common/utils/userApiSync')

const rawScript = '/*\n * @name Test API\n */\nmodule.exports = {}'
const encodedScript = 'gz_' + zlib.deflateSync(Buffer.from(rawScript, 'utf8')).toString('base64')

assert.strictEqual(decodeUserApiScript(encodedScript), rawScript)
assert.strictEqual(decodeUserApiScript(rawScript), rawScript)

;(async() => {
  const skipped = []
  const data = await createUserApiSyncData([
    {
      id: 'user_api_ok',
      name: 'OK',
      description: 'ok source',
      author: 'tester',
      homepage: '',
      version: '1.0.0',
      allowShowUpdateAlert: true,
      sources: {
        kw: {
          name: 'kw',
          type: 'music',
          actions: ['musicUrl'],
          qualitys: ['128k'],
        },
      },
    },
    {
      id: 'user_api_bad',
      name: 'Bad',
      description: 'bad source',
      author: '',
      homepage: '',
      version: '1.0.0',
      allowShowUpdateAlert: false,
    },
  ], async id => {
    if (id == 'user_api_bad') throw new Error('broken script')
    return encodedScript
  }, {
    updatedAt: 100,
    onScriptError: (err, api) => skipped.push([err.message, api.id]),
  })

  assert.deepStrictEqual(skipped, [['broken script', 'user_api_bad']])
  assert.deepStrictEqual(data, {
    source: 'desktop',
    updatedAt: 100,
    apis: [
      {
        id: 'user_api_ok',
        name: 'OK',
        description: 'ok source',
        author: 'tester',
        homepage: '',
        version: '1.0.0',
        allowShowUpdateAlert: true,
        scriptEncoding: 'plain',
        script: rawScript,
      },
    ],
  })

  assert.strictEqual(
    createUserApiSyncMD5({ ...data, updatedAt: 100 }),
    createUserApiSyncMD5({ ...data, updatedAt: 200 }),
  )

  assert.deepStrictEqual(createUserApiSyncMeta(data), {
    md5: createUserApiSyncMD5(data),
    updatedAt: 100,
    count: 1,
  })

  assert.strictEqual(data.apis.some(api => Object.prototype.hasOwnProperty.call(api, 'sources')), false)
  assert.strictEqual(assertUserApiSyncData(data), data)
  assert.throws(() => assertUserApiSyncData({ ...data, apis: [...data.apis, data.apis[0]] }), /duplicate/)
  assert.throws(() => assertUserApiSyncData({ ...data, apis: [{ ...data.apis[0], scriptEncoding: 'gzip' }] }), /script/)

  const merged = mergeUserApiSyncData({
    source: 'desktop',
    updatedAt: 1,
    apis: [
      { ...data.apis[0], id: 'same', name: 'base' },
      { ...data.apis[0], id: '', name: 'invalid base' },
    ],
  }, {
    source: 'desktop',
    updatedAt: 2,
    apis: [
      { ...data.apis[0], id: 'same', name: 'incoming' },
      { ...data.apis[0], id: 'new', name: 'new' },
      { ...data.apis[0], id: '', name: 'invalid incoming' },
    ],
  }, { updatedAt: 300 })
  assert.deepStrictEqual(merged.apis.map(api => [api.id, api.name]), [
    ['same', 'incoming'],
    ['new', 'new'],
  ])
  assert.strictEqual(merged.updatedAt, 300)

  console.log('user api sync helper tests passed')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
