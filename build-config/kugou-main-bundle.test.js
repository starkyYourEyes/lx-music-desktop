const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')

const compileModule = (filename, source) => {
  const compiled = new Module(filename, module)
  compiled.filename = filename
  compiled.paths = Module._nodeModulePaths(path.dirname(filename))
  compiled._compile(source, filename)
  return compiled
}

test('fresh production main bundle executes the compiled Kugou endpoint loader', () => {
  const build = spawnSync(process.execPath, [
    require.resolve('webpack-cli/bin/cli.js'),
    '--config',
    path.join(root, 'build-config/main/webpack.config.prod.js'),
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 60_000,
    windowsHide: true,
  })
  assert.equal(build.status, 0, build.stderr || build.stdout || 'production main build failed')

  const mainPath = path.join(dist, 'main.js')
  const mainSource = fs.readFileSync(mainPath, 'utf8')
  const applicationImport = mainSource.match(
    /Promise\.all\([^[]*\[([^\]]+)]\)\.then\(__webpack_require__\.bind\(__webpack_require__,\s*(\d+)\)\)/,
  )
  assert.ok(applicationImport, 'main.js must expose the production application import')
  const chunkIds = [...applicationImport[1].matchAll(/__webpack_require__\.e\((\d+)\)/g)].map(match => Number(match[1]))
  const applicationModuleId = Number(applicationImport[2])
  assert.ok(chunkIds.length > 0, 'production application import must reference at least one chunk')

  const chunkFiles = chunkIds.map(id => path.join(dist, `${id}.js`))
  const kugouChunks = chunkFiles.filter(file => fs.readFileSync(file, 'utf8').includes('src/main/modules/kugouMusic/api.ts'))
  assert.equal(kugouChunks.length, 1, 'exactly one application chunk must contain the Kugou client')
  const kugouChunkPath = kugouChunks[0]
  const kugouChunkSource = fs.readFileSync(kugouChunkPath, 'utf8')
  const exportMarker = ';// ./src/common/kugouMusic.ts'
  assert.ok(kugouChunkSource.includes(exportMarker), 'compiled Kugou client must precede its common contract')
  const instrumentedChunkSource = kugouChunkSource.replace(
    exportMarker,
    '__webpack_require__.__kugouBundleTest = { createKugouApiClient };\nreturn;\n' + exportMarker,
  )

  const runtimeSource = mainSource.replace(
    /var __webpack_exports__ = __webpack_require__\(__webpack_require__\.s = \d+\);/,
    'module.exports = __webpack_require__; return;',
  )
  assert.notEqual(runtimeSource, mainSource, 'test harness must replace the production startup call')

  const packageRoot = path.dirname(require.resolve('kugoumusicapi'))
  const packageEntry = path.join(packageRoot, 'main.js')
  const packageServer = path.join(packageRoot, 'server.js')
  const loadedPackageFiles = []
  const originalLoad = Module._load
  const previousChunkCache = require.cache[kugouChunkPath]
  try {
    Module._load = function(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent, isMain)
      if (typeof resolved == 'string' && resolved.startsWith(`${packageRoot}${path.sep}`)) {
        loadedPackageFiles.push(path.normalize(resolved))
        assert.notEqual(path.normalize(resolved), path.normalize(packageEntry), 'Kugou package entry must not execute')
        assert.notEqual(path.normalize(resolved), path.normalize(packageServer), 'Kugou server must not execute')
      }
      return originalLoad.call(this, request, parent, isMain)
    }

    require.cache[kugouChunkPath] = compileModule(kugouChunkPath, instrumentedChunkSource)
    const runtime = compileModule(mainPath, runtimeSource).exports
    for (const chunkId of chunkIds) runtime.e(chunkId)
    runtime(applicationModuleId)

    const client = runtime.__kugouBundleTest.createKugouApiClient()
    assert.equal(typeof client.topPlaylist, 'function')
    assert.equal(typeof client.recommendSongs, 'function')
    assert.ok(loadedPackageFiles.some(file => file.endsWith(`${path.sep}module${path.sep}top_playlist.js`)))
    assert.ok(loadedPackageFiles.some(file => file.endsWith(`${path.sep}module${path.sep}recommend_songs.js`)))
    assert.equal(require.cache[packageEntry], undefined)
    assert.equal(require.cache[packageServer], undefined)
  } finally {
    Module._load = originalLoad
    if (previousChunkCache == null) delete require.cache[kugouChunkPath]
    else require.cache[kugouChunkPath] = previousChunkCache
  }
})
