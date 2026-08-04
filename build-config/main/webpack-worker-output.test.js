const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const webpack = require('webpack')

const productionConfig = require('./webpack.config.prod')

const compileMainBundle = async(outputPath) => {
  const config = {
    ...productionConfig,
    output: {
      ...productionConfig.output,
      path: outputPath,
    },
    plugins: productionConfig.plugins.filter(plugin => plugin.constructor.name !== 'CopyPlugin'),
  }

  await new Promise((resolve, reject) => {
    webpack(config, (error, stats) => {
      if (error) return reject(error)
      if (stats?.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })))
      resolve()
    })
  })
}

test('production bundle creates the database worker with a valid constructor', async() => {
  const outputPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-main-bundle-'))

  try {
    await compileMainBundle(outputPath)
    const outputFiles = fs.readdirSync(outputPath)
    const applicationBundle = outputFiles
      .filter(filename => filename.endsWith('.js') && filename !== 'dbService.worker.js')
      .map(filename => fs.readFileSync(path.join(outputPath, filename), 'utf8'))
      .join('\n')
    const workerConstructors = applicationBundle.match(/new external_node_worker_threads_\.Worker\(new URL\(/g) ?? []

    assert.doesNotMatch(applicationBundle, /Worker__webpack_require__\.wc/)
    assert.equal(workerConstructors.length, 1)
    assert.deepEqual(outputFiles.filter(filename => filename === 'dbService.worker.js'), ['dbService.worker.js'])
  } finally {
    fs.rmSync(outputPath, { recursive: true, force: true })
  }
})
