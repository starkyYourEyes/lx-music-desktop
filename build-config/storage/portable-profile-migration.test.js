const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const { createTestStorageRoot } = require('./helpers/test-storage-root.js')

const migrationModule = '../../src/main/migration/portableProfile.js'
const fixtures = []
const silentLogger = { info() {}, warn() {}, error() {} }

const exists = candidate => fs.existsSync(candidate)

const createFixture = (runId = 'startup-1') => {
  const fixture = createTestStorageRoot('portable-profile')
  fixtures.push(fixture)
  const portableRoot = path.join(fixture.path, 'portable')
  const sourceRoot = path.join(portableRoot, 'userData', 'LxDatas')
  const profileRoot = path.join(portableRoot, 'profile')
  fs.mkdirSync(portableRoot)
  return { portableRoot, sourceRoot, profileRoot, runId, logger: silentLogger }
}

const seedSource = fixture => {
  fs.mkdirSync(path.join(fixture.sourceRoot, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(fixture.sourceRoot, 'lx.data.db'), 'database-v1')
  fs.writeFileSync(path.join(fixture.sourceRoot, 'nested', 'config.json'), '{"theme":"dark"}')
}

const makeLockMetadata = pid => JSON.stringify({
  version: 1,
  pid,
  nonce: '0123456789abcdef0123456789abcdef',
  createdAt: '2026-07-29T00:00:00.000Z',
})

const createDirectoryLink = (t, targetPath, linkPath) => {
  try {
    fs.symlinkSync(targetPath, linkPath, process.platform == 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    if (['EACCES', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(error.code)) {
      t.skip(`directory links are unavailable: ${error.code}`)
      return false
    }
    throw error
  }
}

afterEach(() => {
  try { delete require.cache[require.resolve(migrationModule)] } catch {}
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

describe('portable profile migration journal', () => {
  it('promotes only LxDatas and retains it through the acknowledged startup', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    fs.mkdirSync(path.join(fixture.portableRoot, 'userData', 'Session Storage'), { recursive: true })
    fs.writeFileSync(path.join(fixture.portableRoot, 'userData', 'Session Storage', 'session'), 'do-not-copy')
    fs.writeFileSync(path.join(fixture.portableRoot, 'userData', 'outside.txt'), 'do-not-copy')
    const {
      acknowledgePortableProfileStartup,
      preparePortableProfile,
      retireAcknowledgedPortableSource,
    } = require(migrationModule)

    const first = preparePortableProfile(fixture)

    assert.equal(first.state, 'promoted')
    assert.equal(exists(fixture.sourceRoot), true)
    assert.equal(exists(path.join(fixture.profileRoot, 'lx.data.db')), true)
    assert.equal(exists(path.join(fixture.profileRoot, 'Session Storage')), false)
    assert.equal(exists(path.join(fixture.profileRoot, 'outside.txt')), false)

    const acknowledged = await acknowledgePortableProfileStartup(first.token)
    assert.equal(acknowledged.state, 'typed-only-acknowledged')
    assert.equal(exists(fixture.sourceRoot), true)
    assert.equal(retireAcknowledgedPortableSource(fixture).state, 'same-startup')
    assert.equal(exists(fixture.sourceRoot), true)

    const nextStartup = { ...fixture, runId: 'startup-2' }
    assert.equal(retireAcknowledgedPortableSource(nextStartup).state, 'retired')
    assert.equal(exists(fixture.sourceRoot), false)
    assert.equal(exists(path.join(fixture.portableRoot, 'userData')), true)
    assert.equal(fs.readFileSync(path.join(fixture.portableRoot, 'userData', 'outside.txt'), 'utf8'), 'do-not-copy')
  })

  it('leaves a fresh portable install untouched when no legacy LxDatas exists', () => {
    const fixture = createFixture()
    const { preparePortableProfile } = require(migrationModule)

    const result = preparePortableProfile(fixture)

    assert.equal(result.state, 'source-missing')
    assert.equal(exists(fixture.profileRoot), false)
    assert.equal(result.token, undefined)
  })

  it('cleans an interrupted owned stage and succeeds on retry', () => {
    const fixture = createFixture()
    seedSource(fixture)
    const { preparePortableProfile } = require(migrationModule)
    let interrupted = true
    let stagePath
    const fsApi = {
      ...fs,
      mkdtempSync(prefix) {
        stagePath = fs.mkdtempSync(prefix)
        return stagePath
      },
      cpSync(source, destination, options) {
        fs.cpSync(source, destination, options)
        if (interrupted) throw new Error('copy interrupted')
      },
      rmSync(target, options) {
        if (interrupted && target == stagePath) throw new Error('simulated process interruption')
        return fs.rmSync(target, options)
      },
    }

    const first = preparePortableProfile({ ...fixture, fsApi })
    assert.equal(first.state, 'failed')
    assert.equal(exists(stagePath), true)
    interrupted = false

    const second = preparePortableProfile(fixture)
    assert.equal(second.state, 'promoted')
    assert.equal(exists(stagePath), false)
    assert.equal(fs.readFileSync(path.join(fixture.profileRoot, 'nested', 'config.json'), 'utf8'), '{"theme":"dark"}')
  })

  it('keeps an active lock and reclaims the same lock after its owner is dead', () => {
    const fixture = createFixture()
    seedSource(fixture)
    const { PORTABLE_PROFILE_LOCK_FILE, preparePortableProfile } = require(migrationModule)
    const lockPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_LOCK_FILE)
    fs.writeFileSync(lockPath, makeLockMetadata(2147483647))

    const blocked = preparePortableProfile({ ...fixture, isProcessAlive: () => true })
    assert.equal(blocked.state, 'failed')
    assert.equal(exists(lockPath), true)
    assert.equal(exists(fixture.profileRoot), false)

    const recovered = preparePortableProfile({ ...fixture, isProcessAlive: () => false })
    assert.equal(recovered.state, 'promoted')
    assert.equal(exists(lockPath), false)
  })

  it('refuses a non-empty destination without a valid matching journal', () => {
    const fixture = createFixture()
    seedSource(fixture)
    fs.mkdirSync(fixture.profileRoot)
    fs.writeFileSync(path.join(fixture.profileRoot, 'collision.txt'), 'unowned')
    const { preparePortableProfile } = require(migrationModule)

    const result = preparePortableProfile(fixture)

    assert.equal(result.state, 'failed')
    assert.match(result.error.message, /destination/i)
    assert.equal(fs.readFileSync(path.join(fixture.profileRoot, 'collision.txt'), 'utf8'), 'unowned')
    assert.equal(fs.readFileSync(path.join(fixture.sourceRoot, 'lx.data.db'), 'utf8'), 'database-v1')
  })

  it('does not promote a copy when the source mutates and succeeds from the new source on retry', () => {
    const fixture = createFixture()
    seedSource(fixture)
    const databasePath = path.join(fixture.sourceRoot, 'lx.data.db')
    const { preparePortableProfile } = require(migrationModule)
    let mutate = true
    const fsApi = {
      ...fs,
      cpSync(source, destination, options) {
        fs.cpSync(source, destination, options)
        if (mutate) fs.writeFileSync(databasePath, 'database-v2')
      },
    }

    const first = preparePortableProfile({ ...fixture, fsApi })
    assert.equal(first.state, 'failed')
    assert.equal(exists(fixture.profileRoot), false)
    mutate = false

    const second = preparePortableProfile({ ...fixture, fsApi })
    assert.equal(second.state, 'promoted')
    assert.equal(fs.readFileSync(path.join(fixture.profileRoot, 'lx.data.db'), 'utf8'), 'database-v2')
  })

  it('rejects a linked source entry without reading or modifying its target', t => {
    const fixture = createFixture()
    seedSource(fixture)
    const externalRoot = path.join(fixture.portableRoot, 'external')
    fs.mkdirSync(externalRoot)
    fs.writeFileSync(path.join(externalRoot, 'sentinel'), 'external')
    if (!createDirectoryLink(t, externalRoot, path.join(fixture.sourceRoot, 'linked'))) return
    const { preparePortableProfile } = require(migrationModule)

    const result = preparePortableProfile(fixture)

    assert.equal(result.state, 'failed')
    assert.equal(exists(fixture.profileRoot), false)
    assert.equal(fs.readFileSync(path.join(externalRoot, 'sentinel'), 'utf8'), 'external')
  })

  it('serializes two creators so only one promotion owns the destination', () => {
    const fixture = createFixture()
    seedSource(fixture)
    const { preparePortableProfile } = require(migrationModule)
    let concurrentResult
    let attempted = false
    const fsApi = {
      ...fs,
      cpSync(source, destination, options) {
        if (!attempted) {
          attempted = true
          concurrentResult = preparePortableProfile({ ...fixture, isProcessAlive: () => true })
        }
        fs.cpSync(source, destination, options)
      },
    }

    const creator = preparePortableProfile({ ...fixture, fsApi })

    assert.equal(concurrentResult.state, 'failed')
    assert.equal(creator.state, 'promoted')
    assert.equal(preparePortableProfile({ ...fixture, runId: 'startup-2' }).state, 'already-promoted')
    assert.equal(fs.readFileSync(path.join(fixture.profileRoot, 'lx.data.db'), 'utf8'), 'database-v1')
  })

  it('keeps a destination collision after the promotion journal fail-closed on retry and acknowledgement', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      PORTABLE_PROFILE_RECEIPT_FILE,
      acknowledgePortableProfileStartup,
      preparePortableProfile,
    } = require(migrationModule)
    let destinationChecks = 0
    const fsApi = {
      ...fs,
      existsSync(target) {
        if (target == fixture.profileRoot && ++destinationChecks == 2) {
          fs.mkdirSync(fixture.profileRoot)
          fs.writeFileSync(path.join(fixture.profileRoot, 'collision.txt'), 'unowned')
        }
        return fs.existsSync(target)
      },
    }

    const collision = preparePortableProfile({ ...fixture, fsApi })

    assert.equal(collision.state, 'failed')
    assert.equal(fs.readFileSync(path.join(fixture.profileRoot, 'collision.txt'), 'utf8'), 'unowned')
    const retry = preparePortableProfile({ ...fixture, runId: 'startup-2' })
    assert.equal(retry.state, 'failed')
    assert.equal(retry.token, undefined)

    const journalPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.portableRoot, PORTABLE_PROFILE_RECEIPT_FILE),
      'utf8',
    ))
    assert.equal(exists(journalPath), false)
    await assert.rejects(acknowledgePortableProfileStartup({
      version: 1,
      portableRoot: fixture.portableRoot,
      promotionRunId: receipt.promotionRunId,
      startupRunId: receipt.preparationRunId,
      destinationIdentity: receipt.destinationIdentity,
    }), /ENOENT|token|journal|destination/i)
    assert.equal(exists(journalPath), false)
  })

  it('finalizes a post-rename receipt and removes its orphaned owned stage on retry', () => {
    const fixture = createFixture()
    seedSource(fixture)
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      PORTABLE_PROFILE_RECEIPT_FILE,
      PORTABLE_PROFILE_STAGE_PREFIX,
      preparePortableProfile,
    } = require(migrationModule)
    const { STAGE_MARKER_FILE } = require('../../src/main/migration/guardedDirectoryMigration.js')
    assert.equal(preparePortableProfile(fixture).state, 'promoted')
    const journalPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    fs.unlinkSync(journalPath)
    fs.writeFileSync(path.join(fixture.portableRoot, PORTABLE_PROFILE_RECEIPT_FILE), JSON.stringify({
      version: 1,
      sourceManifestHash: journal.sourceManifestHash,
      destinationManifestHash: journal.destinationManifestHash,
      destinationIdentity: journal.destinationIdentity,
      promotionRunId: journal.promotionRunId,
      preparationRunId: journal.preparationRunId,
      nonce: '0123456789abcdef0123456789abcdef',
    }))
    const stagePath = fs.mkdtempSync(path.join(fixture.portableRoot, PORTABLE_PROFILE_STAGE_PREFIX))
    const stageIdentity = fs.lstatSync(stagePath)
    fs.writeFileSync(path.join(stagePath, STAGE_MARKER_FILE), JSON.stringify({
      version: 1,
      nonce: 'abcdef0123456789abcdef0123456789',
      runId: journal.promotionRunId,
      directoryIdentity: { dev: String(stageIdentity.dev), ino: String(stageIdentity.ino) },
    }))

    const retry = preparePortableProfile({ ...fixture, runId: 'startup-2' })

    assert.equal(retry.state, 'already-promoted')
    assert.equal(exists(stagePath), false)
    assert.equal(exists(path.join(fixture.portableRoot, PORTABLE_PROFILE_RECEIPT_FILE)), false)
    assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).state, 'promoted')
  })

  it('rejects acknowledgement tokens that do not match the recorded promotion', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      acknowledgePortableProfileStartup,
      preparePortableProfile,
    } = require(migrationModule)
    const promoted = preparePortableProfile(fixture)
    const mismatched = { ...promoted.token, promotionRunId: 'wrong-promotion' }

    await assert.rejects(acknowledgePortableProfileStartup(mismatched), /token/i)

    const journal = JSON.parse(fs.readFileSync(path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE), 'utf8'))
    assert.equal(journal.state, 'promoted')
    assert.equal(journal.acknowledgementRunId, null)
    assert.equal(exists(fixture.sourceRoot), true)
  })

  for (const replacement of ['changed-content', 'same-content']) {
    it(`rejects ${replacement} destination replacement before acknowledgement without changing the journal`, async() => {
      const fixture = createFixture()
      seedSource(fixture)
      const movedProfileRoot = `${fixture.profileRoot}-moved`
      const {
        PORTABLE_PROFILE_JOURNAL_FILE,
        acknowledgePortableProfileStartup,
        preparePortableProfile,
      } = require(migrationModule)
      const promoted = preparePortableProfile(fixture)
      const journalPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
      const journalBeforeAcknowledgement = fs.readFileSync(journalPath, 'utf8')
      fs.renameSync(fixture.profileRoot, movedProfileRoot)
      fs.cpSync(movedProfileRoot, fixture.profileRoot, { recursive: true })
      if (replacement == 'changed-content') {
        fs.writeFileSync(path.join(fixture.profileRoot, 'lx.data.db'), 'replacement-database')
      }

      await assert.rejects(acknowledgePortableProfileStartup(promoted.token), /identity|destination|token/i)

      assert.equal(fs.readFileSync(journalPath, 'utf8'), journalBeforeAcknowledgement)
      assert.equal(exists(fixture.sourceRoot), true)
    })
  }

  it('rejects a token whose startup run ID changed without changing the journal', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      acknowledgePortableProfileStartup,
      preparePortableProfile,
    } = require(migrationModule)
    const promoted = preparePortableProfile(fixture)
    const journalPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
    const journalBeforeAcknowledgement = fs.readFileSync(journalPath, 'utf8')

    await assert.rejects(acknowledgePortableProfileStartup({
      ...promoted.token,
      startupRunId: 'changed-startup-run',
    }), /token|startup|preparation/i)

    assert.equal(fs.readFileSync(journalPath, 'utf8'), journalBeforeAcknowledgement)
    assert.equal(exists(fixture.sourceRoot), true)
  })

  it('checkpoints the typed destination manifest after an interrupted promoted startup retries', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const {
      acknowledgePortableProfileStartup,
      preparePortableProfile,
      retireAcknowledgedPortableSource,
    } = require(migrationModule)
    assert.equal(preparePortableProfile(fixture).state, 'promoted')
    fs.writeFileSync(path.join(fixture.profileRoot, 'lx.data.db'), 'typed-schema-v7')

    const retry = preparePortableProfile({ ...fixture, runId: 'startup-2' })

    assert.equal(retry.state, 'already-promoted')
    assert.equal(await acknowledgePortableProfileStartup(retry.token).then(result => result.state), 'typed-only-acknowledged')
    assert.equal(retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-2' }).state, 'same-startup')
    assert.equal(retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-3' }).state, 'retired')
    assert.equal(fs.readFileSync(path.join(fixture.profileRoot, 'lx.data.db'), 'utf8'), 'typed-schema-v7')
  })

  it('keeps the source when either recorded manifest changes before retirement', async() => {
    for (const mutation of ['source', 'destination']) {
      const fixture = createFixture()
      seedSource(fixture)
      const {
        acknowledgePortableProfileStartup,
        preparePortableProfile,
        retireAcknowledgedPortableSource,
      } = require(migrationModule)
      const promoted = preparePortableProfile(fixture)
      await acknowledgePortableProfileStartup(promoted.token)
      const changedRoot = mutation == 'source' ? fixture.sourceRoot : fixture.profileRoot
      fs.writeFileSync(path.join(changedRoot, 'lx.data.db'), `${mutation}-changed`)

      const result = retireAcknowledgedPortableSource({ ...fixture, runId: `later-${mutation}` })

      assert.equal(result.state, 'failed', mutation)
      assert.equal(exists(fixture.sourceRoot), true, mutation)
    }
  })

  it('revalidates source identity after the final retirement race boundary', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const replacementRoot = `${fixture.sourceRoot}-replacement`
    const movedRoot = `${fixture.sourceRoot}-moved`
    fs.mkdirSync(replacementRoot)
    fs.writeFileSync(path.join(replacementRoot, 'replacement'), 'must-survive')
    const {
      acknowledgePortableProfileStartup,
      preparePortableProfile,
      retireAcknowledgedPortableSource,
    } = require(migrationModule)
    const promoted = preparePortableProfile(fixture)
    await acknowledgePortableProfileStartup(promoted.token)

    const result = retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      beforeSourceRetirement() {
        fs.renameSync(fixture.sourceRoot, movedRoot)
        fs.renameSync(replacementRoot, fixture.sourceRoot)
      },
    })

    assert.equal(result.state, 'failed')
    assert.equal(fs.readFileSync(path.join(fixture.sourceRoot, 'replacement'), 'utf8'), 'must-survive')
    assert.equal(fs.readFileSync(path.join(movedRoot, 'lx.data.db'), 'utf8'), 'database-v1')
  })

  it('revalidates same-content destination identity after the final retirement race boundary', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const movedProfileRoot = `${fixture.profileRoot}-moved`
    const {
      acknowledgePortableProfileStartup,
      preparePortableProfile,
      retireAcknowledgedPortableSource,
    } = require(migrationModule)
    const promoted = preparePortableProfile(fixture)
    await acknowledgePortableProfileStartup(promoted.token)

    const result = retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      beforeSourceRetirement() {
        fs.renameSync(fixture.profileRoot, movedProfileRoot)
        fs.mkdirSync(path.join(fixture.profileRoot, 'nested'), { recursive: true })
        fs.copyFileSync(path.join(movedProfileRoot, 'lx.data.db'), path.join(fixture.profileRoot, 'lx.data.db'))
        fs.copyFileSync(
          path.join(movedProfileRoot, 'nested', 'config.json'),
          path.join(fixture.profileRoot, 'nested', 'config.json'),
        )
      },
    })

    assert.equal(result.state, 'failed')
    assert.equal(exists(fixture.sourceRoot), true)
    assert.equal(fs.readFileSync(path.join(fixture.profileRoot, 'lx.data.db'), 'utf8'), 'database-v1')
    assert.equal(fs.readFileSync(path.join(movedProfileRoot, 'lx.data.db'), 'utf8'), 'database-v1')
  })
})
