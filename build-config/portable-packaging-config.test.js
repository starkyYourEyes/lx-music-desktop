const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')

const buildPackPath = path.join(__dirname, 'build-pack.js')
const electronBuilder = require('electron-builder')

const captureBuildConfiguration = async parameters => {
  const originalArgv = process.argv
  const originalLoad = Module._load
  let buildConfiguration

  process.argv = ['node', buildPackPath, ...parameters]
  Module._load = function(request, parent, isMain) {
    if (request == 'electron-builder') {
      return {
        ...electronBuilder,
        build: configuration => {
          buildConfiguration = configuration
          return Promise.resolve()
        },
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    delete require.cache[buildPackPath]
    require(buildPackPath)
    await new Promise(resolve => { setImmediate(resolve) })
  } finally {
    process.argv = originalArgv
    Module._load = originalLoad
    delete require.cache[buildPackPath]
  }

  assert.notEqual(buildConfiguration, undefined, 'electron-builder.build() was not called')
  return buildConfiguration
}

test('portable build passes a launch-unique extraction directory configuration to electron-builder', async() => {
  const buildConfiguration = await captureBuildConfiguration([
    'target=win',
    'arch=x64',
    'type=portable',
  ])

  assert.deepEqual(buildConfiguration.win, ['portable'])
  assert.deepEqual(buildConfiguration.config.portable, {
    unpackDirName: true,
  })
})

test('setup build does not receive portable extraction configuration', async() => {
  const buildConfiguration = await captureBuildConfiguration([
    'target=win',
    'arch=x64',
    'type=setup',
  ])

  assert.deepEqual(buildConfiguration.win, ['nsis'])
  assert.equal(buildConfiguration.config.portable, undefined)
})
