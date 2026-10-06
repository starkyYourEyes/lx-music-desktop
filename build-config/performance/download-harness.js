const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '../..')
const loadTs = (file, stubs = {}, globals = {}) => {
  const source = fs.readFileSync(path.join(root, file), 'utf8').replaceAll('import.meta.url', "'file:///worker.js'")
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const exports = {}
  vm.runInNewContext(code, { exports, require: id => id in stubs ? stubs[id] : require(id), console, queueMicrotask, setTimeout, clearTimeout, ...globals })
  return exports
}
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

module.exports = { loadTs, deferred, tick, root }
