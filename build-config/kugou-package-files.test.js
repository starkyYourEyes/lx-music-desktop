const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

test('keeps KuGouMusicApi external and packages its dynamic module directory', () => {
  const webpackConfig = fs.readFileSync(path.join(root, 'build-config/main/webpack.config.base.js'), 'utf8')
  const packConfig = fs.readFileSync(path.join(root, 'build-config/build-pack.js'), 'utf8')
  assert.match(webpackConfig, /['"]kugoumusicapi['"]\s*:\s*['"]kugoumusicapi['"]/)
  assert.match(packConfig, /getPackageFiles\(['"]kugoumusicapi['"]\)/)
})

test('resolves KuGouMusicApi without making a network request', () => {
  const http = require('node:http')
  const https = require('node:https')
  const request = http.request
  const secureRequest = https.request
  const fail = () => {
    throw new Error('unexpected network request while resolving kugoumusicapi')
  }
  http.request = fail
  https.request = fail
  try {
    const api = require('kugoumusicapi')
    assert.equal(typeof api.top_playlist, 'function')
  } finally {
    http.request = request
    https.request = secureRequest
  }
})
