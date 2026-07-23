const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const babel = require('@babel/core')

module.exports = (filePath, mocks = {}) => {
  const filename = path.resolve(filePath)
  const source = fs.readFileSync(filename, 'utf8')
  const { code } = babel.transformSync(source, {
    babelrc: false,
    configFile: false,
    filename,
    presets: [[require.resolve('@babel/preset-typescript'), { allowDeclareFields: true }]],
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
  })

  const loadedModule = new Module(filename, module)
  loadedModule.filename = filename
  loadedModule.paths = Module._nodeModulePaths(path.dirname(filename))

  const originalLoad = Module._load
  Module._load = (request, parent, isMain) => {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request]
    return originalLoad(request, parent, isMain)
  }
  try {
    loadedModule._compile(code, filename)
  } finally {
    Module._load = originalLoad
  }
  return loadedModule.exports
}
