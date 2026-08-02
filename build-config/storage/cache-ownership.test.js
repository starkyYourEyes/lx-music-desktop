const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describe, it } = require('node:test')
const {
  assertFixturePathsOwned,
  createPhase4DurableFixture,
  seedDurableFiles,
} = require('./helpers/phase4-durable-fixture.js')

const root = path.resolve(__dirname, '../..')
const sourceExtensions = /\.(?:ts|js|vue|sql)$/
const readTree = directory => fs.readdirSync(path.join(root, directory), { withFileTypes: true })
  .flatMap(entry => {
    const relative = path.join(directory, entry.name)
    if (entry.isDirectory()) return readTree(relative)
    return sourceExtensions.test(entry.name)
      ? [{ file: relative.replaceAll('\\', '/'), text: fs.readFileSync(path.join(root, relative), 'utf8') }]
      : []
  })

const production = readTree('src')
const workerBoundaryFiles = [
  'src/main/worker/dbService/modules/index.ts',
  'src/main/worker/dbService/index.ts',
  'src/main/types/db_service.d.ts',
  'src/main/types/worker.d.ts',
]
const rendererBoundary = production.filter(({ file }) =>
  file.startsWith('src/renderer/') ||
  file.startsWith('src/main/modules/winMain/rendererEvent/') ||
  file.startsWith('src/main/modules/userApi/') ||
  file.startsWith('src/common/'),
)

const matches = (files, expression) => files.flatMap(({ file, text }) => {
  expression.lastIndex = 0
  return expression.test(text) ? [file] : []
})

describe('Phase 4 whole-source ownership gate', () => {
  it('exposes no generic or unscoped cache database API across production and worker boundaries', () => {
    const genericName = new RegExp(`\\b${'get'}${'DB'}\\b`)
    assert.deepEqual(matches(production, genericName), [])

    const boundary = workerBoundaryFiles.map(file => ({
      file,
      text: fs.readFileSync(path.join(root, file), 'utf8'),
    }))
    const legacyNames = [
      'getMusicUrl',
      'musicUrlSave',
      'musicUrlRemove',
      'musicInfoOtherSourceAdd',
      'musicInfoOtherSourceRemove',
    ]
    for (const name of legacyNames) {
      assert.deepEqual(matches(boundary, new RegExp(`\\b${name}\\b`)), [], `${name} crossed the worker boundary`)
    }
  })

  it('keeps authoritative legacy cache SQL in the schema, edited-lyric repository, and sole migration owners', () => {
    const owners = new Set([
      'src/main/migration/cache/cutover.ts',
      'src/main/migration/cache/rawLyrics.ts',
      'src/main/worker/dbService/tables.ts',
      'src/main/worker/dbService/modules/lyric/edited/statements.ts',
    ])
    const legacyDml = /\b(?:FROM|INTO|UPDATE|TABLE|JOIN|ON)\s+["']?(?:lyric|music_url|music_info_other_source)\b/i
    const activeOwners = matches(production.filter(({ file }) => file.startsWith('src/main/')), legacyDml)
    assert.deepEqual(activeOwners.filter(file => !owners.has(file)), [])
  })

  it('keeps backup roots, temp roots, renderer deletion authority, and cache-manager UI wiring inside their owners', () => {
    assert.deepEqual(matches(production, /\bos\.tmpdir\s*\(/), [])
    const backupRootDerivation = /path\.(?:join|resolve)\([^\n]*(?:['"]backups['"])/
    assert.deepEqual(matches(production, backupRootDerivation).filter(file => file != 'src/main/utils/storagePaths.ts'), [])
    assert.deepEqual(matches(production, /cacheRoot[^\n]{0,120}(?:artwork|audio)|(?:artwork|audio)[^\n]{0,120}cacheRoot/i), [])
    assert.deepEqual(matches(rendererBoundary, /cacheManager|\.clearAll\s*\(/), [])
    assert.deepEqual(matches(rendererBoundary, /(?:cache|storage)[A-Za-z_]*(?:delete|remove)[A-Za-z_]*\s*\([^)]*(?:path|target)/i), [])
  })

  it('keeps every generated installed and portable fixture path inside its owned direct child', () => {
    for (const layout of ['installed', 'portable']) {
      const fixture = createPhase4DurableFixture({ layout })
      try {
        seedDurableFiles(fixture, layout == 'portable' ? { profileRoot: fixture.legacyProfileRoot } : undefined)
        assert.equal(path.dirname(fixture.root), fs.realpathSync(process.env.LX_TEST_STORAGE_ROOT))
        assertFixturePathsOwned(fixture)
      } finally {
        fixture.cleanup()
      }
    }
  })
})
