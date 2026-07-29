const assert = require('node:assert/strict')
const { describe, it } = require('node:test')
const fs = require('node:fs')
const typescript = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS },
  }).outputText
  module._compile(output, filename)
}

const { canonicalJson, sha256Canonical } = require('../../src/common/storage/canonicalJson.ts')
const { assertRecord, assertBoundedString, assertFiniteInteger, assertJsonByteSize } = require('../../src/common/storage/validation.ts')

describe('storage canonical JSON', () => {
  it('sorts object keys recursively without reordering arrays', () => {
    const left = { z: [{ b: 2, a: 1 }], a: true }
    const right = { a: true, z: [{ a: 1, b: 2 }] }
    assert.equal(canonicalJson(left), canonicalJson(right))
    assert.equal(sha256Canonical(left), sha256Canonical(right))
  })

  it('accepts plain records and rejects non-plain objects', () => {
    assert.doesNotThrow(() => assertRecord({ value: true }, 'metadata'))
    assert.throws(() => assertRecord([], 'metadata'), /metadata/)
    assert.throws(() => assertRecord(new Date(), 'metadata'), /metadata/)
  })

  it('rejects invalid scalar and payload limits', () => {
    assert.throws(() => assertBoundedString('', 'term', 1, 200), /term/)
    assert.throws(() => assertFiniteInteger(1.5, 'sequence', 0, 10), /sequence/)
    assert.throws(() => assertFiniteInteger(Number.POSITIVE_INFINITY, 'sequence', 0, 10), /sequence/)
    assert.throws(() => assertJsonByteSize({ value: 'x'.repeat(20) }, 'payload', 8), /payload/)
    assert.throws(() => assertJsonByteSize({ value: '你' }, 'payload', 14), /payload/)
  })
})
