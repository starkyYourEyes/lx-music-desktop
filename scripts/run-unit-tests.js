const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// These suites need Electron, invoke webpack, or inspect/launch packaged artifacts.
// Baseline failures are NOT exclusions. See build-config/TESTS.md for the inventory.
const separateTests = new Set([
  'kugou-main-bundle.test.js',
  'kugou-packaged-app.test.js',
  'main/webpack-worker-output.test.js',
  'packaged-app.test.js',
  'performance/webpack-chunk-isolation.test.js',
  'player-audio-quality.test.js',
  'player-preload-electron.test.js',
  'portable-packaged-bootstrap.test.js',
  'sidebar-group-compositing.test.js',
  'storage/cache-phase-prerequisite.test.js',
  'storage/portable-filesystem.test.js',
  'storage/startup-coordinator.test.js',
])

const discoverUnitTests = root => {
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    const relative = path.relative(root, file).split(path.sep).join('/')
    if (relative === 'storage-electron') return []
    if (entry.isDirectory()) return walk(file)
    return entry.isFile() && entry.name.endsWith('.test.js') && !separateTests.has(relative) ? [file] : []
  })
  return walk(root).sort()
}

if (require.main === module) {
  const { withTestEnvironment } = require('./run-test-environment')
  try {
    process.exitCode = withTestEnvironment(() => {
      const files = discoverUnitTests(path.resolve(__dirname, '../build-config'))
      if (!files.length) throw new Error('No unit tests found')
      const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
        stdio: 'inherit', windowsHide: true,
      })
      if (result.error) console.error(result.error)
      return result.error || result.signal || result.status !== 0 ? 1 : 0
    })
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}

module.exports = { discoverUnitTests }
