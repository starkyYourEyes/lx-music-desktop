const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const pkg = require('../package.json')
const { PROJECT_IDENTITY } = require('../src/common/projectIdentity')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

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
