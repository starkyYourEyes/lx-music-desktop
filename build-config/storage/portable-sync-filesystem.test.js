const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { describe, it } = require('node:test')

const repoRoot = path.resolve(__dirname, '../..')
const smokePath = path.join(__dirname, 'portable-sync-metadata-smoke.js')
const successOutput = `${JSON.stringify({ status: 'pass', fixtureRemoved: true })}\n`

const writeCleanupFailurePreload = async() => {
  const preloadPath = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-portable-preload-')), 'cleanup-failure.js')
  await fsp.writeFile(preloadPath, [
    "const Module = require('node:module')",
    'const originalResolveFilename = Module._resolveFilename',
    "const originalTsExtension = require.extensions['.ts']",
    'const originalLoad = Module._load',
    'let intercepted = false',
    'Module._load = function(request, parent, isMain) {',
    "  if (!intercepted && request == 'node:fs/promises') {",
    '    intercepted = true',
    '    const fileSystem = originalLoad.call(this, request, parent, isMain)',
    "    return { ...fileSystem, rm: async() => { throw new Error('injected cleanup failure') } }",
    '  }',
    '  return originalLoad.call(this, request, parent, isMain)',
    '}',
    "process.on('exit', () => {",
    "  if (Module._resolveFilename !== originalResolveFilename || require.extensions['.ts'] !== originalTsExtension) {",
    "    process.stderr.write('smoke hooks were not restored\\n')",
    '    process.exitCode = 99',
    '  }',
    '})',
  ].join('\n'), 'utf8')
  return preloadPath
}

describe('portable sync filesystem smoke contract', () => {
  it('contains no production hard-link predecessor protocol', async() => {
    const sources = [
      'src/main/storage/atomicJsonFile.ts',
      'src/main/modules/sync/migrate.ts',
    ]
    for (const relative of sources) {
      const source = await fsp.readFile(path.join(repoRoot, relative), 'utf8')
      assert.doesNotMatch(source, /(?:fs|fileSystem)\.link|\blinkSync\b|expectedPreviousFileSha256|allowInvalidPreviousFileSha256|expected-previous/)
    }
  })

  it('runs the synthetic sync migration under an explicit temporary volume root', async() => {
    const volumeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-portable-volume-'))
    try {
      const result = spawnSync(process.execPath, [smokePath, volumeRoot], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, successOutput)
      assert.equal(result.stderr, '')
      assert.deepEqual(await fsp.readdir(volumeRoot), [])
    } finally {
      await fsp.rm(volumeRoot, { recursive: true, force: true })
    }
  })

  it('restores module hooks when fixture cleanup fails', async() => {
    const volumeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-portable-volume-'))
    const preloadPath = await writeCleanupFailurePreload()
    try {
      const result = spawnSync(process.execPath, ['--require', preloadPath, smokePath, volumeRoot], { encoding: 'utf8' })
      assert.equal(result.status, 1, result.stderr)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /injected cleanup failure/)
      assert.doesNotMatch(result.stderr, /smoke hooks were not restored/)
    } finally {
      await fsp.rm(path.dirname(preloadPath), { recursive: true, force: true })
      await fsp.rm(volumeRoot, { recursive: true, force: true })
    }
  })
})
