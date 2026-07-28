const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const pkg = require('../package.json')
const lockText = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')

const extractOptionsBlock = (source, startMarker, endMarker) => {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const start = normalizedSource.indexOf(startMarker)
  assert.notEqual(start, -1, `missing options start marker: ${startMarker}`)
  const end = normalizedSource.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing options end marker: ${endMarker}`)
  return normalizedSource.slice(start, end)
}

test('direct dependencies use approved official npm releases', () => {
  assert.equal(pkg.devDependencies['electron-devtools-installer'], '^4.0.0')
  assert.equal(pkg.devDependencies['eslint-formatter-friendly'], '^7.0.0')
  assert.equal(pkg.devDependencies.spinnies, '^0.5.1')
  assert.equal(pkg.devDependencies['webpack-hot-middleware'], '^2.26.1')
  assert.equal(pkg.dependencies.needle, '^3.5.0')
  assert.equal(Object.hasOwn(pkg.dependencies, 'message2call'), false)
  assert.doesNotMatch(lockText, /github(?:\.com)?:lyswhut|github\.com\/lyswhut/i)
})

test('renderer needle wrapper preserves fork proxy and parsing behavior', () => {
  const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/utils/request.js'), 'utf8')
  const rendererOptions = extractOptionsBlock(
    rendererSource,
    'return request(url, {\n    ...options,',
    '\n  }, (err, resp, body) => {',
  )
  assert.match(rendererOptions, /\.\.\.options,[\s\S]*use_proxy_from_env_var:\s*false/)
  assert.match(rendererOptions, /\.\.\.options,[\s\S]*parse:\s*false/)
})

test('user API preload needle wrapper preserves fork proxy and parsing behavior', () => {
  const preloadSource = fs.readFileSync(path.join(root, 'src/main/modules/userApi/renderer/preload.js'), 'utf8')
  const preloadOptions = extractOptionsBlock(
    preloadSource,
    'let options = {',
    '\n      }\n      let data',
  )
  assert.match(preloadOptions, /use_proxy_from_env_var:\s*false/)
  assert.match(preloadOptions, /parse:\s*false/)
})
