const packageJson = require('../../package.json')

const normalizeRepositoryUrl = repository => {
  const rawUrl = typeof repository == 'string' ? repository : repository.url
  return rawUrl.replace(/^git\+/, '').replace(/\.git$/, '')
}

const repositoryUrl = normalizeRepositoryUrl(packageJson.repository)
const repositoryPath = new URL(repositoryUrl).pathname.replace(/^\//, '').split('/')
const authorName = typeof packageJson.author == 'string' ? packageJson.author : packageJson.author.name

const PROJECT_IDENTITY = Object.freeze({
  packageName: packageJson.name,
  displayName: 'LX Music',
  appId: 'com.starkyyoureyes.lxmusic.desktop',
  productName: packageJson.name,
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
  authorName,
  repositoryUrl,
  repositoryOwner: repositoryPath[0],
  repositoryName: repositoryPath[1],
  issuesUrl: `${repositoryUrl}/issues`,
  releasesUrl: `${repositoryUrl}/releases`,
})

module.exports = { PROJECT_IDENTITY }
