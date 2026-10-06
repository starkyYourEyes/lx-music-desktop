const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')
const typescript = require('typescript')
const vm = require('node:vm')
const asar = require('@electron/asar')

const root = path.resolve(__dirname, '..')
const archivePath = path.join(root, 'build/win-unpacked/resources/app.asar')
const packageRoot = 'node_modules/kugoumusicapi'

const readSource = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

const isContained = (basePath, candidate) => {
  const relative = path.relative(basePath, candidate)
  return relative == '' || (relative != '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

const loadTypeScriptModule = (relativePath, mocks) => {
  const filename = path.join(root, relativePath)
  const output = typescript.transpileModule(readSource(relativePath), {
    compilerOptions: {
      esModuleInterop: true,
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText
  const fixtureModule = new Module(filename, module)
  fixtureModule.filename = filename
  fixtureModule.paths = []
  fixtureModule.require = (request) => {
    if (Object.hasOwn(mocks, request)) return mocks[request]
    throw new Error(`Unexpected fixture dependency: ${request}`)
  }
  fixtureModule._compile(output, filename)
  return fixtureModule.exports
}

const extractVerifiedFile = (filePath) => {
  const file = asar.extractFile(archivePath, filePath)
  const metadata = asar.statFile(archivePath, filePath)
  const hash = crypto.createHash('sha256').update(file).digest('hex')

  assert.equal(hash, metadata.integrity.hash, `${filePath} failed its ASAR integrity check`)
  return file
}

const withPackagedArtifact = (t) => {
  if (fs.existsSync(archivePath)) return true
  t.skip('packaged artifact required: run npm run pack:dir')
  return false
}

test('getListDetail and getListDetailAll resolve source kg through musicSdk.kg.songList', async() => {
  const sdkCalls = []
  const musicSdk = {
    kg: {
      songList: {
        getListDetail: async(id, page) => {
          sdkCalls.push({ id, page })
          return {
            source: 'kg',
            info: {},
            list: [{ id: `${id}-${page}`, source: 'kg' }],
            total: 3,
            limit: 2,
            page,
          }
        },
      },
    },
  }
  const failIpc = async() => { throw new Error('unexpected playlist IPC') }
  const action = loadTypeScriptModule('src/renderer/store/songList/action.ts', {
    '@common/performance/boundedCache': loadTypeScriptModule('src/common/performance/boundedCache.ts', {}),
    '@common/performance/cacheProfile': loadTypeScriptModule('src/common/performance/cacheProfile.ts', {}),
    '@renderer/utils': { deduplicationList: list => list, toNewMusicInfo: item => item },
    '@renderer/utils/musicSdk': { __esModule: true, default: musicSdk },
    '@renderer/utils/ipc': { getNeteasePlaylistDetail: failIpc, getQQMusicPlaylistDetail: failIpc },
    '@renderer/store/qqMusic': { getQQMusicAccountKey: () => null },
    '@renderer/store/dailyRecommend/action': {
      getDailyRecommendPlaylistDetail: failIpc,
      loadDailyRecommendSongs: failIpc,
    },
    '@renderer/store/dailyRecommend/state': { DAILY_RECOMMEND_TEMP_LIST_ID: 'wy-daily' },
    '@renderer/store/qqDailyRecommend/action': { getQQDailyRecommendPlaylistDetail: failIpc },
    '@renderer/store/qqDailyRecommend/state': {
      QQ_DAILY_RECOMMEND_LIST_ID: 'tx-daily',
      qqDailyRecommendGeneration: { value: 0 },
    },
    '@common/utils/vueTools': { markRaw: value => value, markRawList: value => value },
    './state': {
      tags: {},
      listInfo: { list: [] },
      listDetailInfo: { list: [] },
      selectListInfo: {},
      isVisibleListDetail: { value: false },
      openSongListInputInfo: {},
    },
  })

  const detail = await action.getListDetail('kg-single', 'kg', 1, true)
  assert.equal(detail.source, 'kg')
  assert.deepEqual(sdkCalls, [{ id: 'kg-single', page: 1 }])

  sdkCalls.length = 0
  const all = await action.getListDetailAll('kg-all', 'kg', true)
  assert.deepEqual(sdkCalls, [
    { id: 'kg-all', page: 1 },
    { id: 'kg-all', page: 2 },
  ])
  assert.deepEqual(all.map(item => item.id), ['kg-all-1', 'kg-all-2'])
})

test('playSongListDetail forwards source kg to both unified detail loaders', async() => {
  const detailCalls = []
  const allCalls = []
  const tempCalls = []
  const firstSong = { id: 'first', source: 'kg' }
  const fullList = [firstSong, { id: 'second', source: 'kg' }]
  const action = loadTypeScriptModule('src/renderer/views/songList/Detail/action.ts', {
    '@renderer/store/list/state': { tempListMeta: { id: '' }, userLists: [] },
    '@renderer/plugins/Dialog': { dialog: { confirm: async() => false } },
    '@renderer/store/list/syncSourceList': { __esModule: true, default: async() => {} },
    '@renderer/store/songList/action': {
      getListDetail: async(id, source, page) => {
        detailCalls.push({ id, source, page })
        return { list: [firstSong] }
      },
      getListDetailAll: async(id, source) => {
        allCalls.push({ id, source })
        return fullList
      },
    },
    '@renderer/store/list/action': {
      createUserList: async() => {},
      setTempList: async(id, list) => { tempCalls.push({ id, list }) },
    },
    '@renderer/core/player/action': { playList: () => {} },
    '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
    '@renderer/utils': { toMD5: value => value },
    '@renderer/store/dailyRecommend/state': { DAILY_RECOMMEND_TEMP_LIST_ID: 'wy-daily' },
    '@renderer/store/qqMusic': { getQQMusicAccountKey: () => null },
    '@renderer/store/qqDailyRecommend/action': { playQQDailyRecommend: async() => {} },
    '@renderer/store/qqDailyRecommend/state': { QQ_DAILY_RECOMMEND_LIST_ID: 'tx-daily' },
  })

  await action.playSongListDetail('kg-playlist', 'kg')

  assert.deepEqual(detailCalls, [{ id: 'kg-playlist', source: 'kg', page: 1 }])
  assert.deepEqual(allCalls, [{ id: 'kg-playlist', source: 'kg' }])
  assert.deepEqual(tempCalls.map(call => call.id), ['kg__kg-playlist'])
})

test('Kugou recommendation playlists open and play through source kg', () => {
  const playback = readSource('src/renderer/views/KugouRecommend/useKugouRecommendPlayback.ts')

  assert.match(playback, /query:\s*\{[\s\S]*?source: 'kg',[\s\S]*?id: playlist\.id,/)
  assert.match(playback, /playSongListDetail\(playlist\.id, 'kg'\)/)
})

test('packaged ASAR contains the complete Kugou dynamic module directory', (t) => {
  if (!withPackagedArtifact(t)) return

  const manifest = JSON.parse(extractVerifiedFile(path.join(packageRoot, 'package.json')).toString('utf8'))
  const topPlaylist = extractVerifiedFile(path.join(packageRoot, 'module', 'top_playlist.js'))
  const sourceModuleDir = path.join(root, packageRoot, 'module')
  const expectedModules = fs.readdirSync(sourceModuleDir)
    .filter(file => file.endsWith('.js'))
    .sort()
  const packagedModules = asar.listPackage(archivePath)
    .map(file => file.replace(/\\/g, '/').replace(/^\//, ''))
    .filter(file => file.startsWith(`${packageRoot}/module/`) && file.endsWith('.js'))
    .map(file => path.posix.basename(file))
    .sort()

  assert.equal(manifest.name, 'kugoumusicapi')
  assert.notEqual(topPlaylist.length, 0)
  assert.deepEqual(packagedModules, expectedModules)
})

test('packaged main bundle resolves KugouMusicApi without executing its entry or server', (t) => {
  if (!withPackagedArtifact(t)) return

  const manifest = JSON.parse(extractVerifiedFile('package.json').toString('utf8'))
  const mainPath = manifest.main.replace(/^\.\//, '')
  const mainBundle = extractVerifiedFile(mainPath).toString('utf8')
  const extractDir = fs.mkdtempSync(path.join(path.dirname(root), '.lx-kugou-packaged-'))

  try {
    assert.equal(isContained(root, extractDir), false, 'packaged fixture must stay outside the workspace')
    new vm.Script(mainBundle, { filename: mainPath })
    assert.match(mainBundle, /kugoumusicapi/)

    asar.extractAll(archivePath, extractDir)
    const extractedMain = path.join(extractDir, mainPath)
    const extractedEntry = path.join(extractDir, packageRoot, 'main.js')
    const extractedEndpoint = path.join(extractDir, packageRoot, 'module', 'top_playlist.js')
    fs.writeFileSync(path.join(extractDir, '.env'), 'KUGOU_PACKAGED_ENV_MARKER=loaded\n')
    const childScript = `
      const assert = require('node:assert/strict')
      const Module = require('node:module')
      const path = require('node:path')
      const { createRequire, isBuiltin } = Module
      const root = process.env.LX_PACKAGED_ROOT
      const main = process.env.LX_PACKAGED_MAIN
      const entry = process.env.LX_PACKAGED_ENTRY
      const endpoint = process.env.LX_PACKAGED_ENDPOINT
      const isContained = candidate => {
        const relative = path.relative(root, candidate)
        return relative == '' || (relative != '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
      }
      const blocked = () => { throw new Error('network access disabled') }
      for (const name of ['node:http', 'node:https']) {
        const api = require(name)
        api.request = blocked
        api.get = blocked
      }
      const net = require('node:net')
      net.connect = blocked
      net.createConnection = blocked
      require('node:tls').connect = blocked
      require('node:dgram').createSocket = blocked
      global.fetch = blocked
      const resolveFilename = Module._resolveFilename
      Module._resolveFilename = function(request, parent, isMain, options) {
        const resolved = resolveFilename.call(this, request, parent, isMain, options)
        if (!isBuiltin(request) && path.isAbsolute(resolved)) {
          assert.equal(isContained(resolved), true, 'module resolved outside extracted package')
        }
        return resolved
      }
      const packagedRequire = createRequire(main)
      const resolved = packagedRequire.resolve('kugoumusicapi')
      assert.equal(path.resolve(resolved), path.resolve(entry))
      assert.equal(isContained(resolved), true)
      const server = path.join(path.dirname(entry), 'server.js')
      delete require.cache[server]
      delete process.env.KUGOU_PACKAGED_ENV_MARKER
      const topPlaylist = require(endpoint)
      assert.equal(typeof topPlaylist, 'function')
      assert.equal(require.cache[server], undefined)
      assert.equal(process.env.KUGOU_PACKAGED_ENV_MARKER, undefined)
      process.stdout.write(JSON.stringify({ resolved, endpoint, serverLoaded: require.cache[server] != null }))
    `
    const child = spawnSync(process.execPath, ['-e', childScript], {
      cwd: extractDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        INIT_CWD: extractDir,
        NODE_OPTIONS: '',
        NODE_PATH: '',
        LX_PACKAGED_ROOT: extractDir,
        LX_PACKAGED_MAIN: extractedMain,
        LX_PACKAGED_ENTRY: extractedEntry,
        LX_PACKAGED_ENDPOINT: extractedEndpoint,
      },
      timeout: 30_000,
      windowsHide: true,
    })

    assert.equal(child.status, 0, child.stderr || 'isolated packaged module load failed')
    const result = JSON.parse(child.stdout)
    assert.equal(path.resolve(result.resolved), path.resolve(extractedEntry))
    assert.equal(isContained(extractDir, result.resolved), true)
    assert.equal(path.resolve(result.endpoint), path.resolve(extractedEndpoint))
    assert.equal(result.serverLoaded, false)
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true })
  }
})
