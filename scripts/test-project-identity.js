const assert = require('node:assert/strict')
const { generateKeyPairSync } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('./test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const pkg = require('../package.json')
const { PROJECT_IDENTITY } = require('../src/common/projectIdentity')
const {
  CURRENT_SYNC_PROTOCOL,
  LEGACY_SYNC_PROTOCOL,
  SYNC_PROTOCOLS,
  getSyncProtocol,
  getSyncProtocolCandidates,
} = require('../src/common/syncProtocol')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')
const runtimeIdentityPath = path.join(root, 'src/common/runtimeIdentity.js')
const runtimeIdentity = fs.existsSync(runtimeIdentityPath) ? require(runtimeIdentityPath) : {}

let runtimeEntries
const getRuntimeEntries = () => {
  if (runtimeEntries) return runtimeEntries
  const constants = loadTsModule(path.join(root, 'src/common/constants.ts'), {
    './projectIdentity': { PROJECT_IDENTITY },
    './runtimeIdentity': runtimeIdentity,
  })
  const syncConstants = loadTsModule(path.join(root, 'src/common/constants_sync.ts'), {
    './projectIdentity': { PROJECT_IDENTITY },
  })
  const parseEnvParams = loadTsModule(path.join(root, 'src/main/utils/index.ts'), {
    electron: {
      nativeTheme: { shouldUseDarkColors: false },
      powerSaveBlocker: {
        isStarted: () => false,
        start: () => 1,
        stop() {},
      },
    },
    '@common/constants': constants,
    '@common/defaultHotKey': { global: {}, local: {} },
    '@common/defaultSetting': { version: 1 },
    '@common/theme/index.json': [],
    '@common/utils': {
      encodePath: value => value,
      isUrl: () => false,
      throttle: callback => callback,
    },
    '@common/utils/migrateSetting': value => value,
    '@common/utils/nodejs': { joinPath: path.join },
    '@main/utils/store': () => ({}),
    './migrate': {
      migrateDataJson: async() => {},
      migrateHotKey: async() => null,
      migrateUserApi: async() => {},
      parseDataFile: async() => null,
    },
  }).parseEnvParams
  const syncTools = loadTsModule(path.join(root, 'src/main/modules/sync/server/utils/tools.ts'))
  const syncUtils = loadTsModule(path.join(root, 'src/main/modules/sync/server/utils/index.ts'))
  const userData = loadTsModule(path.join(root, 'src/main/modules/sync/server/user/data.ts'), {
    '@common/constants_sync': syncConstants,
    '@common/utils/common': { throttle: callback => callback },
    '../../utils': { exists: async() => false },
    '../utils': syncUtils,
  })
  const clients = new Map()
  const userSpace = {
    dataManage: {
      getClientKeyInfo: clientId => clients.get(clientId) ?? null,
      saveClientKeyInfo: keyInfo => clients.set(keyInfo.clientId, keyInfo),
    },
  }
  const syncAuth = loadTsModule(path.join(root, 'src/main/modules/sync/server/server/auth.ts'), {
    '@common/constants_sync': syncConstants,
    '@common/projectIdentity': { PROJECT_IDENTITY },
    '@common/runtimeIdentity': runtimeIdentity,
    '../../utils': { getComputerName: () => 'Test Server' },
    '../user': {
      createClientKeyInfo: userData.createClientKeyInfo,
      getUserSpace: () => userSpace,
    },
    '../utils': syncUtils,
    '../utils/tools': syncTools,
  })
  return runtimeEntries = {
    ...syncAuth,
    parseEnvParams,
    syncConstants,
    syncTools,
    syncUtils,
  }
}

const createCodeAuthRequest = (clientType, remoteAddress) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const publicKeyBody = publicKey
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s/g, '')
  const password = 'identity-test-password'
  const { syncConstants, syncTools, syncUtils } = getRuntimeEntries()
  const key = Buffer.from(syncUtils.toMD5(password).substring(0, 16)).toString('base64')
  const plaintext = [
    syncConstants.SYNC_CODE.authMsg,
    publicKeyBody,
    'Test Client',
    clientType,
  ].join('\n')
  return {
    password,
    privateKey,
    request: {
      headers: { m: syncTools.aesEncrypt(plaintext, key) },
      socket: { remoteAddress },
    },
  }
}

const performCodeAuth = async(clientType, remoteAddress) => {
  const { authCode, syncTools } = getRuntimeEntries()
  const { password, privateKey, request } = createCodeAuthRequest(clientType, remoteAddress)
  let status
  let body
  await authCode(request, {
    writeHead(value) {
      status = value
    },
    end(value) {
      body = value
    },
  }, password)
  return {
    status,
    body,
    payload: status == 200
      ? JSON.parse(syncTools.rsaDecrypt(Buffer.from(body, 'base64'), privateKey).toString())
      : null,
  }
}

test('project identity contains the approved values', () => {
  assert.deepEqual(PROJECT_IDENTITY, {
    packageName: 'starky-lx-music-desktop',
    displayName: 'LX Music',
    appId: 'com.starkyyoureyes.lxmusic.desktop',
    productName: 'starky-lx-music-desktop',
    userDataDirName: 'starky-lx-music-desktop',
    protocolScheme: 'starkylx',
    protocolPrefix: 'starkylx://',
    protocolName: 'starky-lx-music-protocol',
    syncDesktopId: 'starky_lx_music_desktop',
    syncMobileId: 'starky_lx_music_mobile',
    syncAuthPrefix: 'starky-lx-music auth::',
    syncConnectMessage: 'starky-lx-music connect',
    requestUserAgent: 'starky-lx-music request',
    userApiPartition: 'starky-lx-user-api',
    tempDirectoryName: 'starky_lx_music_temp',
    defaultWebdavUrl: 'https://dav.jianguoyun.com/dav/starky-lx-music',
    backupExtension: 'slxmc',
    allDataBackupName: 'starky_datas_v2.slxmc',
    settingBackupName: 'starky_setting_v2.slxmc',
    playlistBackupName: 'starky_list.slxmc',
    authorName: 'starkyYourEyes',
    repositoryUrl: 'https://github.com/starkyYourEyes/lx-music-desktop',
    repositoryOwner: 'starkyYourEyes',
    repositoryName: 'lx-music-desktop',
    issuesUrl: 'https://github.com/starkyYourEyes/lx-music-desktop/issues',
    releasesUrl: 'https://github.com/starkyYourEyes/lx-music-desktop/releases',
  })
})

test('sync compatibility profiles contain only the two approved protocols', () => {
  assert.deepEqual(CURRENT_SYNC_PROTOCOL, {
    id: 'current',
    syncDesktopId: PROJECT_IDENTITY.syncDesktopId,
    syncMobileId: PROJECT_IDENTITY.syncMobileId,
    syncAuthPrefix: PROJECT_IDENTITY.syncAuthPrefix,
    syncConnectMessage: PROJECT_IDENTITY.syncConnectMessage,
  })
  assert.deepEqual(LEGACY_SYNC_PROTOCOL, {
    id: 'legacy',
    syncDesktopId: 'lx_music_desktop',
    syncMobileId: 'lx_music_mobile',
    syncAuthPrefix: 'lx-music auth::',
    syncConnectMessage: 'lx-music connect',
  })
  assert.deepEqual(SYNC_PROTOCOLS, [CURRENT_SYNC_PROTOCOL, LEGACY_SYNC_PROTOCOL])
})

test('sync protocol candidates prefer current and honor a stored marker', () => {
  assert.deepEqual(getSyncProtocolCandidates().map(({ id }) => id), ['current', 'legacy'])
  assert.deepEqual(getSyncProtocolCandidates('legacy').map(({ id }) => id), ['legacy'])
  assert.equal(getSyncProtocol('legacy'), LEGACY_SYNC_PROTOCOL)
  assert.equal(getSyncProtocol(undefined), CURRENT_SYNC_PROTOCOL)
  assert.equal(getSyncProtocol('unexpected'), CURRENT_SYNC_PROTOCOL)
})

test('package metadata is the identity source for package author and repository', () => {
  assert.equal(pkg.name, PROJECT_IDENTITY.packageName)
  assert.equal(pkg.author.name, PROJECT_IDENTITY.authorName)
  assert.equal(pkg.repository.url, `${PROJECT_IDENTITY.repositoryUrl}.git`)
  assert.equal(pkg.bugs.url, PROJECT_IDENTITY.issuesUrl)
  assert.equal(pkg.homepage, `${PROJECT_IDENTITY.repositoryUrl}#readme`)
})

test('electron builder consumes the shared identity', () => {
  const source = read('build-config/build-pack.js')
  assert.match(source, /require\('\.\.\/src\/common\/projectIdentity'\)/)
  assert.match(source, /^[ \t]*appId: PROJECT_IDENTITY\.appId,$/m)
  assert.match(source, /^[ \t]*productName: PROJECT_IDENTITY\.productName,$/m)
  assert.match(source, /^[ \t]*name: PROJECT_IDENTITY\.protocolName,$/m)
  assert.match(source, /^[ \t]*schemes: \[\r?\n[ \t]*PROJECT_IDENTITY\.protocolScheme,\r?\n[ \t]*\],$/m)
  assert.match(source, /^[ \t]*owner: PROJECT_IDENTITY\.repositoryOwner,$/m)
  assert.match(source, /^[ \t]*repo: PROJECT_IDENTITY\.repositoryName,$/m)
  assert.match(source, /^[ \t]*legalTrademarks: PROJECT_IDENTITY\.authorName,$/m)
  assert.match(source, /^[ \t]*maintainer: PROJECT_IDENTITY\.authorName,$/m)
  assert.match(source, /^[ \t]*Name: PROJECT_IDENTITY\.displayName,$/m)
  assert.match(source, /^[ \t]*'Name\[zh_CN\]': PROJECT_IDENTITY\.displayName,$/m)
  assert.match(source, /^[ \t]*'Name\[zh_TW\]': PROJECT_IDENTITY\.displayName,$/m)
  assert.match(source, /^[ \t]*MimeType: `x-scheme-handler\/\$\{PROJECT_IDENTITY\.protocolScheme\}`,$/m)
  for (const oldValue of [
    'cn.toside.music.desktop',
    "productName: 'lx-music-desktop'",
    "name: 'lx-music-protocol'",
    "'lxmusic'",
    "owner: 'lyswhut'",
  ]) assert.doesNotMatch(source, new RegExp(oldValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('runtime identifiers are consumed from the shared identity', () => {
  const expectedImports = [
    'src/common/constants.ts',
    'src/common/constants_sync.ts',
    'src/main/app.ts',
    'src/main/modules/sync/client/auth.ts',
    'src/main/modules/sync/server/server/auth.ts',
    'src/main/modules/userApi/main.ts',
    'src/renderer/core/useApp/useDeeplink/index.ts',
    'src/renderer/utils/musicSdk/options.js',
    'src/renderer/worker/main/music.ts',
  ]
  for (const relativePath of expectedImports) {
    assert.match(read(relativePath), /projectIdentity/, relativePath)
  }

  const productionSources = expectedImports.map(read).join('\n')
  for (const oldPattern of [
    /\blxmusic:\/\//,
    /(?<!starky_)\blx_music_desktop\b/,
    /(?<!starky_)\blx_music_mobile\b/,
    /(?<!starky-)\blx-music auth::/,
    /(?<!starky-)\blx-music connect\b/,
    /(?<!starky-)\blx-user-api\b/,
    /(?<!starky-)\blx-music request\b/,
    /\blxmusic_temp\b/,
  ]) assert.doesNotMatch(productionSources, oldPattern)
})

test('project protocol recognition requires the exact anchored scheme and separators', () => {
  assert.equal(typeof runtimeIdentity.createUrlSchemeRxp, 'function')
  const protocolRxp = runtimeIdentity.createUrlSchemeRxp(PROJECT_IDENTITY.protocolScheme)

  for (const value of [
    'starkylx://music/play',
    'starkylx://',
  ]) assert.equal(protocolRxp.test(value), true, value)

  for (const value of [
    'lxmusic://music/play',
    'prefix-starkylx://music/play',
    'starkylx-extra://music/play',
    'starkylx:/music/play',
    'starkylx//music/play',
    'starkylx:music/play',
    'https://example.com',
    '',
  ]) assert.equal(protocolRxp.test(value), false, value)
})

test('project protocol recognition escapes regular expression characters in schemes', () => {
  assert.equal(typeof runtimeIdentity.createUrlSchemeRxp, 'function')
  const protocolRxp = runtimeIdentity.createUrlSchemeRxp('starky.lx')
  assert.equal(protocolRxp.test('starky.lx://music/play'), true)
  assert.equal(protocolRxp.test('starkyXlx://music/play'), false)
})

test('sync client classification accepts only the approved desktop and mobile identities', () => {
  assert.equal(typeof runtimeIdentity.classifySyncClient, 'function')
  assert.deepEqual(runtimeIdentity.classifySyncClient(PROJECT_IDENTITY.syncDesktopId, PROJECT_IDENTITY), {
    kind: 'desktop',
    isMobile: false,
  })
  assert.deepEqual(runtimeIdentity.classifySyncClient(PROJECT_IDENTITY.syncMobileId, PROJECT_IDENTITY), {
    kind: 'mobile',
    isMobile: true,
  })

  for (const value of [
    'lx_music_desktop',
    'lx_music_mobile',
    'unknown',
    '',
    undefined,
    null,
    1,
    true,
    {},
    [],
    `${PROJECT_IDENTITY.syncDesktopId} `,
    PROJECT_IDENTITY.syncMobileId.toUpperCase(),
  ]) assert.equal(runtimeIdentity.classifySyncClient(value, PROJECT_IDENTITY), null, String(value))
})

test('parseEnvParams accepts only the current deep-link protocol', () => {
  const { parseEnvParams } = getRuntimeEntries()

  assert.deepEqual(
    parseEnvParams(['electron', 'app.js', '-hidden', 'starkylx://music/play']),
    {
      cmdParams: { hidden: true },
      deeplink: 'starkylx://music/play',
    },
  )
  assert.deepEqual(
    parseEnvParams(['electron', 'app.js', '-hidden', 'lxmusic://music/play']),
    {
      cmdParams: { hidden: true },
      deeplink: null,
    },
  )
})

test('authCode accepts current desktop and mobile identities', async() => {
  const desktop = await performCodeAuth(PROJECT_IDENTITY.syncDesktopId, '127.0.0.11')
  const mobile = await performCodeAuth(PROJECT_IDENTITY.syncMobileId, '127.0.0.12')

  for (const result of [desktop, mobile]) {
    assert.equal(result.status, 200)
    assert.equal(typeof result.payload.clientId, 'string')
    assert.equal(typeof result.payload.key, 'string')
    assert.equal(result.payload.serverName, 'Test Server')
  }
})

test('authCode rejects legacy desktop and mobile identities', async() => {
  const { syncConstants } = getRuntimeEntries()
  for (const [index, clientType] of ['lx_music_desktop', 'lx_music_mobile'].entries()) {
    const result = await performCodeAuth(clientType, `127.0.0.${20 + index}`)
    assert.equal(result.status, 401)
    assert.equal(result.body, syncConstants.SYNC_CODE.msgAuthFailed)
    assert.equal(result.payload, null)
  }
})

test('authConnect accepts only the current connection message', async() => {
  const { authConnect, syncTools } = getRuntimeEntries()
  const authorized = await performCodeAuth(PROJECT_IDENTITY.syncDesktopId, '127.0.0.31')
  const createRequest = (message, remoteAddress) => ({
    socket: { remoteAddress },
    url: `/socket?i=${encodeURIComponent(authorized.payload.clientId)}&t=${encodeURIComponent(syncTools.aesEncrypt(message, authorized.payload.key))}`,
  })

  await assert.doesNotReject(
    authConnect(createRequest(PROJECT_IDENTITY.syncConnectMessage, '127.0.0.32')),
  )
  await assert.rejects(
    authConnect(createRequest('lx-music connect', '127.0.0.33')),
    /failed/,
  )
})
