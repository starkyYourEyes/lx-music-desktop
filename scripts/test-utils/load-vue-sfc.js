const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const babel = require('@babel/core')
const { compileScript, compileTemplate, parse } = require('@vue/compiler-sfc')

const loadVueSfc = (filePath, mocks = {}) => {
  const filename = path.resolve(filePath)
  const source = fs.readFileSync(filename, 'utf8')
  const { descriptor, errors } = parse(source, { filename })
  if (errors.length) throw errors[0]

  const id = `test-${Buffer.from(filename).toString('hex')}`
  const script = compileScript(descriptor, { id, genDefaultAs: '__sfc__' })
  const template = compileTemplate({
    source: descriptor.template.content,
    filename,
    id,
    scoped: descriptor.styles.some(style => style.scoped),
    compilerOptions: { bindingMetadata: script.bindings },
  })
  if (template.errors.length) throw template.errors[0]

  const { code } = babel.transformSync(`${script.content}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`, {
    babelrc: false,
    configFile: false,
    filename: `${filename}.ts`,
    presets: [[require.resolve('@babel/preset-typescript'), {
      allExtensions: true,
      allowDeclareFields: true,
    }]],
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

module.exports = { loadVueSfc }
