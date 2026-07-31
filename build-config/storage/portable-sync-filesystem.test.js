const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { describe, it } = require('node:test')

const repoRoot = path.resolve(__dirname, '../..')
const smokePath = path.join(__dirname, 'portable-sync-metadata-smoke.js')

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
      assert.deepEqual(JSON.parse(result.stdout), { status: 'pass', fixtureRemoved: true })
      assert.deepEqual(await fsp.readdir(volumeRoot), [])
    } finally {
      await fsp.rm(volumeRoot, { recursive: true, force: true })
    }
  })
})
