const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createTestStorageRoot } = require('../storage/helpers/test-storage-root')
const path = require('node:path')
const test = require('node:test')
const webpack = require('webpack')

test('optional chunks from all four compilers coexist and main imports still execute', async t => {
  const owned = createTestStorageRoot('lx-chunk-isolation')
  const fixture = owned.path
  t.after(() => owned.cleanup())
  const outputPath = path.join(fixture, 'dist')
  const emitted = new Set()
  for (const target of ['main', 'renderer', 'renderer-lyric', 'renderer-scripts']) {
    const base = require(`../${target}/webpack.config.base`)
    const source = path.join(fixture, target)
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'entry.js'), 'module.exports = () => import(/* webpackChunkName: "optional" */ "./optional.js")')
    fs.writeFileSync(path.join(source, 'optional.js'), `module.exports = ${JSON.stringify(target)}`)
    const stats = await new Promise((resolve, reject) => {
      webpack({
        mode: 'production',
        target: base.target,
        entry: { [target]: path.join(source, 'entry.js') },
        output: { ...base.output, path: outputPath },
        optimization: { minimize: false },
      }, (error, result) => {
        if (error) return reject(error)
        if (result.hasErrors()) return reject(new Error(result.toString({ all: false, errors: true })))
        resolve(result)
      })
    })
    for (const asset of stats.toJson({ all: false, assets: true }).assets) {
      assert.equal(emitted.has(asset.name), false, `${target} overwrites ${asset.name}`)
      emitted.add(asset.name)
    }
  }
  const optional = await require(path.join(outputPath, 'main.js'))()
  assert.equal(optional.default, 'main')
})
