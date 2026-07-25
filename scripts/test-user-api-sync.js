const assert = require('node:assert')
const zlib = require('node:zlib')

const {
  decodeUserApiScript,
  createUserApiSyncData,
  createStableUserApiSyncData,
  createUserApiSyncMeta,
  createUserApiSyncMD5,
  assertUserApiSyncData,
  mergeUserApiSyncData,
} = require('../src/common/utils/userApiSync')

const rawScript = '/*\n * @name Test API\n */\nmodule.exports = {}'
const encodedScript = 'gz_' + zlib.deflateSync(Buffer.from(rawScript, 'utf8')).toString('base64')
const remote = {
  provider: 'github',
  repository: 'Macrohard0001/lx-ikun-music-sources',
  version: 'v260724',
  group: 'V260720-\u63a8\u8350',
  path: 'v260724/V260720-\u63a8\u8350/kg.js',
  blobSha: 'a'.repeat(40),
  commitSha: 'b'.repeat(40),
}
const remoteInput = { ...remote, unknown: 'drop me' }

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
      remote: remoteInput,
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
        remote,
        scriptEncoding: 'plain',
        script: rawScript,
      },
    ],
  })
  assert.notStrictEqual(data.apis[0].remote, remoteInput)
  remoteInput.group = 'mutated'
  assert.strictEqual(data.apis[0].remote.group, 'V260720-\u63a8\u8350')
  remoteInput.group = 'V260720-\u63a8\u8350'

  const stableRemoteInput = { ...data.apis[0].remote, unknown: 'drop me' }
  const stableData = createStableUserApiSyncData({
    ...data,
    apis: [{
      ...data.apis[0],
      remote: stableRemoteInput,
    }],
  })
  assert.deepStrictEqual(stableData.apis[0].remote, data.apis[0].remote)
  assert.notStrictEqual(stableData.apis[0].remote, data.apis[0].remote)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(stableData.apis[0].remote, 'unknown'), false)
  stableRemoteInput.group = 'mutated'
  assert.strictEqual(stableData.apis[0].remote.group, 'V260720-\u63a8\u8350')

  const localStableData = createStableUserApiSyncData({
    ...data,
    apis: [{ ...data.apis[0], remote: undefined }],
  })
  assert.strictEqual(Object.prototype.hasOwnProperty.call(localStableData.apis[0], 'remote'), false)

  assert.strictEqual(
    createUserApiSyncMD5({ ...data, updatedAt: 100 }),
    createUserApiSyncMD5({ ...data, updatedAt: 200 }),
  )
  assert.notStrictEqual(
    createUserApiSyncMD5(data),
    createUserApiSyncMD5({
      ...data,
      apis: [{
        ...data.apis[0],
        remote: {
          ...data.apis[0].remote,
          group: 'V260720-\u5176\u4ed6',
          path: 'v260724/V260720-\u5176\u4ed6/kg.js',
        },
      }],
    }),
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

  const assertInvalidRemote = changes => {
    assert.throws(() => assertUserApiSyncData({
      ...data,
      apis: [{
        ...data.apis[0],
        remote: { ...data.apis[0].remote, ...changes },
      }],
    }), /remote/)
  }
  assertInvalidRemote({ provider: 'gitlab' })
  assertInvalidRemote({ repository: 'other/repository' })
  assertInvalidRemote({ provider: ['github'] })
  assertInvalidRemote({ provider: Object('github') })
  assertInvalidRemote({ provider: { [Symbol.toPrimitive]: () => 'github' } })
  assertInvalidRemote({ repository: ['Macrohard0001/lx-ikun-music-sources'] })
  assertInvalidRemote({ repository: Object('Macrohard0001/lx-ikun-music-sources') })
  assertInvalidRemote({ repository: { [Symbol.toPrimitive]: () => 'Macrohard0001/lx-ikun-music-sources' } })
  assertInvalidRemote({ version: '260724' })
  assertInvalidRemote({ group: '' })
  assertInvalidRemote({ group: 'V260720-\u5176\u4ed6' })
  assertInvalidRemote({ path: 'v260723/V260720-\u63a8\u8350/kg.js' })
  assertInvalidRemote({ path: 'v260724/V260720-\u63a8\u8350/kg.json' })
  assertInvalidRemote({ path: 'v260724/V260720-\u63a8\u8350/.js' })
  assertInvalidRemote({ blobSha: 'a'.repeat(39) })
  assertInvalidRemote({ commitSha: 'not-a-sha' })
  const assertInvalidRemoteValue = remoteValue => {
    assert.throws(() => assertUserApiSyncData({
      ...data,
      apis: [{ ...data.apis[0], remote: remoteValue }],
    }), /remote/)
  }
  assertInvalidRemoteValue('github')

  let accessorReads = 0
  const accessorRemote = { ...remote }
  Object.defineProperty(accessorRemote, 'group', {
    enumerable: true,
    get() {
      accessorReads++
      return remote.group
    },
  })
  assertInvalidRemoteValue(accessorRemote)
  assert.strictEqual(accessorReads, 0)

  let proxyReads = 0
  const proxyRemote = new Proxy({ ...remote }, {
    get(target, property, receiver) {
      proxyReads++
      if (property == 'group' && proxyReads % 2 == 0) return 'V260720-\u5176\u4ed6'
      return Reflect.get(target, property, receiver)
    },
  })
  assertInvalidRemoteValue(proxyRemote)
  assert.strictEqual(proxyReads, 0)

  const localApi = { ...data.apis[0] }
  delete localApi.remote
  const localData = { ...data, apis: [localApi] }
  assert.strictEqual(assertUserApiSyncData(localData), localData)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(
    createStableUserApiSyncData(localData).apis[0],
    'remote',
  ), false)

  const nullRemoteData = {
    ...data,
    apis: [{ ...data.apis[0], remote: null }],
  }
  assert.strictEqual(assertUserApiSyncData(nullRemoteData), nullRemoteData)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(
    createStableUserApiSyncData(nullRemoteData).apis[0],
    'remote',
  ), false)
  assert.strictEqual(Object.isFrozen(data), true)
  assert.strictEqual(Object.isFrozen(data.apis), true)
  assert.strictEqual(Object.isFrozen(data.apis[0]), true)
  assert.strictEqual(Object.isFrozen(data.apis[0].remote), true)
  const assertedMD5 = createUserApiSyncMD5(data)
  assert.strictEqual(Reflect.set(data.apis[0], 'name', 'mutated'), false)
  assert.strictEqual(Reflect.set(data.apis[0].remote, 'group', 'mutated'), false)
  assert.strictEqual(createUserApiSyncMD5(data), assertedMD5)

  assert.doesNotThrow(() => assertUserApiSyncData({
    ...data,
    apis: [{
      ...data.apis[0],
      remote: {
        ...data.apis[0].remote,
        group: 'v260724',
        path: 'v260724/source.JS',
      },
    }],
  }))

  const baseRemote = {
    ...remote,
    version: 'v260723',
    group: 'base',
    path: 'v260723/base/source.js',
    blobSha: 'c'.repeat(40),
    commitSha: 'd'.repeat(40),
  }
  const incomingRemote = {
    ...remote,
    version: 'V260725',
    group: 'incoming',
    path: 'V260725/incoming/source.JS',
    blobSha: 'e'.repeat(40),
    commitSha: 'f'.repeat(40),
  }
  for (const remoteInfo of [baseRemote, incomingRemote]) {
    assert.doesNotThrow(() => assertUserApiSyncData({
      ...data,
      apis: [{
        ...data.apis[0],
        id: 'valid_' + remoteInfo.version,
        remote: { ...remoteInfo },
      }],
    }))
  }
  const baseApi = {
    ...data.apis[0],
    id: 'same',
    name: 'base',
    remote: baseRemote,
  }
  const incomingApi = {
    ...data.apis[0],
    id: 'same',
    name: 'incoming',
    remote: incomingRemote,
  }

  const merged = mergeUserApiSyncData({
    source: 'desktop',
    updatedAt: 1,
    apis: [
      baseApi,
      { ...data.apis[0], id: '', name: 'invalid base' },
    ],
  }, {
    source: 'desktop',
    updatedAt: 2,
    apis: [
      incomingApi,
      { ...data.apis[0], id: 'new', name: 'new' },
      { ...data.apis[0], id: '', name: 'invalid incoming' },
    ],
  }, { updatedAt: 300 })
  assert.deepStrictEqual(merged.apis.map(api => [api.id, api.name]), [
    ['same', 'incoming'],
    ['new', 'new'],
  ])
  assert.strictEqual(merged.updatedAt, 300)
  assert.deepStrictEqual(merged.apis[0].remote, incomingRemote)
  assert.notStrictEqual(merged.apis[0].remote, baseRemote)
  assert.notStrictEqual(merged.apis[0].remote, incomingRemote)

  const stableMerged = createStableUserApiSyncData(merged)
  const stableMergedMD5 = createUserApiSyncMD5(merged)
  incomingApi.name = 'mutated incoming'
  incomingApi.script = 'mutated script'
  incomingRemote.group = 'mutated'
  incomingRemote.path = 'V260725/mutated/source.JS'

  assert.strictEqual(merged.apis[0].name, 'incoming')
  assert.strictEqual(merged.apis[0].script, rawScript)
  assert.deepStrictEqual(merged.apis[0].remote, stableMerged.apis[0].remote)
  assert.deepStrictEqual(createStableUserApiSyncData(merged), stableMerged)
  assert.strictEqual(createUserApiSyncMD5(merged), stableMergedMD5)

  console.log('user api sync helper tests passed')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
