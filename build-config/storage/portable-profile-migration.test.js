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

const replaceDirectoryWithSameContent = directoryPath => {
  const originalPath = `${directoryPath}-original`
  fs.renameSync(directoryPath, originalPath)
  fs.cpSync(originalPath, directoryPath, { recursive: true })
  return originalPath
}

const readJournal = (fixture, journalFile) => JSON.parse(fs.readFileSync(
  path.join(fixture.portableRoot, journalFile),
  'utf8',
))

const retirementIsolationPath = (fixture, journal) => path.join(
  path.dirname(fixture.sourceRoot),
  journal.retirement.isolationBasename,
)

const prepareAcknowledgedFixture = async(fixture, migration) => {
  const prepared = await migration.preparePortableProfile(fixture)
  assert.equal(prepared.state, 'promoted')
  await migration.acknowledgePortableProfileStartup(prepared.token)
  return prepared
}

const legacyJournalFrom = journal => ({
  version: 1,
  sourceManifestHash: journal.sourceManifestHash,
  destinationManifestHash: journal.destinationManifestHash,
  destinationIdentity: journal.destinationIdentity,
  promotionRunId: journal.promotionRunId,
  preparationRunId: journal.preparationRunId,
  state: journal.state,
  acknowledgementRunId: journal.acknowledgementRunId,
})

const legacyReceiptFrom = journal => ({
  version: 1,
  sourceManifestHash: journal.sourceManifestHash,
  destinationManifestHash: journal.destinationManifestHash,
  destinationIdentity: journal.destinationIdentity,
  promotionRunId: journal.promotionRunId,
  preparationRunId: journal.preparationRunId,
  nonce: '0123456789abcdef0123456789abcdef',
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
  it('durably records retirement-intent before moving LxDatas', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    await prepareAcknowledgedFixture(fixture, migration)
    const events = []

    const result = await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      afterJournalWrite(journal) { events.push(journal.state) },
      beforeSourceRename() { events.push('rename') },
    })

    assert.equal(result.state, 'retired')
    assert.deepEqual(events.slice(0, 2), ['retirement-intent', 'rename'])
    assert.equal(readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE).state, 'retired')
  })

  it('records an exact interrupted payload as retired-retained without deleting it', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    await prepareAcknowledgedFixture(fixture, migration)
    const interrupted = await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      afterJournalWrite(journal) {
        if (journal.state == 'retirement-isolated') throw new Error('interrupt_after_isolation')
      },
    })
    assert.equal(interrupted.state, 'failed')
    const isolatedJournal = readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    const isolationPath = retirementIsolationPath(fixture, isolatedJournal)
    const payloadPath = path.join(isolationPath, 'payload')
    assert.equal(exists(payloadPath), true)

    const result = await migration.retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-3' })

    assert.equal(result.state, 'failed')
    assert.equal(readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE).state, 'retired-retained')
    assert.equal(exists(payloadPath), true)
  })

  it('finalizes retired-retained when the exact payload is removed and its private directory is empty', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    await prepareAcknowledgedFixture(fixture, migration)
    await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      afterJournalWrite(journal) {
        if (journal.state == 'retirement-isolated') throw new Error('interrupt_after_isolation')
      },
    })
    await migration.retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-3' })
    const retainedJournal = readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    const isolationPath = retirementIsolationPath(fixture, retainedJournal)
    fs.rmSync(path.join(isolationPath, 'payload'), { recursive: true, force: false })

    const result = await migration.retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-4' })

    assert.equal(result.state, 'retired')
    assert.equal(readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE).state, 'retired')
    assert.deepEqual(fs.readdirSync(isolationPath), [])
  })

  it('recovers an exact empty retirement isolation after payload removal interrupts final journalling', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    await prepareAcknowledgedFixture(fixture, migration)

    const interrupted = await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      afterRetirementPayloadRemoval() {
        throw new Error('interrupt_after_retirement_payload_removal')
      },
    })

    assert.equal(interrupted.state, 'failed')
    const isolatedJournal = readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    assert.equal(isolatedJournal.state, 'retirement-isolated')
    const isolationPath = retirementIsolationPath(fixture, isolatedJournal)
    const isolationBeforeResume = fs.lstatSync(isolationPath, { bigint: true })
    assert.deepEqual(fs.readdirSync(isolationPath), [])
    assert.deepEqual(
      { dev: String(isolationBeforeResume.dev), ino: String(isolationBeforeResume.ino) },
      isolatedJournal.retirement.isolationIdentity,
    )

    const resumed = await migration.retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-3' })

    assert.equal(resumed.state, 'retired')
    assert.equal(readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE).state, 'retired')
    const isolationAfterResume = fs.lstatSync(isolationPath, { bigint: true })
    assert.deepEqual(fs.readdirSync(isolationPath), [])
    assert.deepEqual(
      { dev: String(isolationAfterResume.dev), ino: String(isolationAfterResume.ino) },
      isolatedJournal.retirement.isolationIdentity,
    )
  })

  it('revalidates destination evidence after payload removal before journalling retired', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    await prepareAcknowledgedFixture(fixture, migration)
    let movedProfileRoot

    const result = await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      afterRetirementPayloadRemoval() {
        movedProfileRoot = replaceDirectoryWithSameContent(fixture.profileRoot)
      },
    })

    assert.equal(result.state, 'failed')
    const journal = readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    assert.equal(journal.state, 'retirement-isolated')
    assert.deepEqual(fs.readdirSync(retirementIsolationPath(fixture, journal)), [])
    assert.equal(fs.readFileSync(path.join(fixture.profileRoot, 'lx.data.db'), 'utf8'), 'database-v1')
    assert.equal(fs.readFileSync(path.join(movedProfileRoot, 'lx.data.db'), 'utf8'), 'database-v1')
  })

  it('preserves a source replacement introduced at the retirement rename boundary', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const replacementRoot = `${fixture.sourceRoot}-replacement`
    const movedRoot = `${fixture.sourceRoot}-original`
    fs.mkdirSync(replacementRoot)
    fs.writeFileSync(path.join(replacementRoot, 'replacement'), 'must-survive')
    const migration = require(migrationModule)
    await prepareAcknowledgedFixture(fixture, migration)

    const result = await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      beforeSourceRename() {
        fs.renameSync(fixture.sourceRoot, movedRoot)
        fs.renameSync(replacementRoot, fixture.sourceRoot)
      },
    })

    assert.equal(result.state, 'failed')
    assert.equal(fs.readFileSync(path.join(fixture.sourceRoot, 'replacement'), 'utf8'), 'must-survive')
    assert.equal(fs.readFileSync(path.join(movedRoot, 'lx.data.db'), 'utf8'), 'database-v1')
  })

  it('retains the isolated payload when a source replacement appears after isolation journalling', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    await prepareAcknowledgedFixture(fixture, migration)
    let isolationPath

    const result = await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      afterJournalWrite(journal) {
        if (journal.state != 'retirement-isolated') return
        isolationPath = retirementIsolationPath(fixture, journal)
        fs.mkdirSync(fixture.sourceRoot)
        fs.writeFileSync(path.join(fixture.sourceRoot, 'replacement'), 'must-survive')
      },
    })

    assert.equal(result.state, 'failed')
    assert.equal(readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE).state, 'retired-retained')
    assert.equal(fs.readFileSync(path.join(fixture.sourceRoot, 'replacement'), 'utf8'), 'must-survive')
    assert.equal(fs.readFileSync(path.join(isolationPath, 'payload', 'lx.data.db'), 'utf8'), 'database-v1')
  })

  it('does not remove a foreign payload after the retirement isolation changes at the removal boundary', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    await prepareAcknowledgedFixture(fixture, migration)
    let isolationPath
    let isolationReads = 0
    let moveIsolationOnPayloadStat = false
    let movedIsolation
    const fsApi = {
      ...fs,
      readdirSync(target, options) {
        const entries = fs.readdirSync(target, options)
        if (target == isolationPath && ++isolationReads == 2) {
          moveIsolationOnPayloadStat = true
        }
        return entries
      },
      lstatSync(target, options) {
        const stat = fs.lstatSync(target, options)
        if (moveIsolationOnPayloadStat && target == path.join(isolationPath, 'payload')) {
          moveIsolationOnPayloadStat = false
          movedIsolation = `${isolationPath}-original`
          fs.renameSync(isolationPath, movedIsolation)
          fs.mkdirSync(path.join(isolationPath, 'payload'), { recursive: true })
          fs.writeFileSync(path.join(isolationPath, 'payload', 'foreign'), 'must-survive')
        }
        return stat
      },
    }

    const result = await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      fsApi,
      afterJournalWrite(journal) {
        if (journal.state == 'retirement-isolated') {
          isolationPath = retirementIsolationPath(fixture, journal)
        }
      },
    })

    assert.equal(result.state, 'failed')
    assert.equal(readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE).state, 'retired-retained')
    assert.equal(fs.readFileSync(path.join(movedIsolation, 'payload', 'lx.data.db'), 'utf8'), 'database-v1')
    assert.equal(fs.readFileSync(path.join(isolationPath, 'payload', 'foreign'), 'utf8'), 'must-survive')
  })

  it('resumes only the exact journal-bound empty retirement isolation', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    await prepareAcknowledgedFixture(fixture, migration)
    const interrupted = await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      afterJournalWrite(journal) {
        if (journal.state == 'retirement-intent') throw new Error('interrupt_after_intent')
      },
    })
    assert.equal(interrupted.state, 'failed')
    const intentJournal = readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    const isolationPath = retirementIsolationPath(fixture, intentJournal)
    assert.deepEqual(fs.readdirSync(isolationPath), [])
    let observedIsolation

    const result = await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-3',
      beforeSourceRename() { observedIsolation = isolationPath },
    })

    assert.equal(result.state, 'retired')
    assert.equal(observedIsolation, isolationPath)
  })

  it('fails closed when the journal-bound retirement isolation identity changes', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    await prepareAcknowledgedFixture(fixture, migration)
    await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      afterJournalWrite(journal) {
        if (journal.state == 'retirement-intent') throw new Error('interrupt_after_intent')
      },
    })
    const intentJournal = readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    const isolationPath = retirementIsolationPath(fixture, intentJournal)
    const movedIsolation = `${isolationPath}-original`
    fs.renameSync(isolationPath, movedIsolation)
    fs.mkdirSync(isolationPath)

    const result = await migration.retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-3' })

    assert.equal(result.state, 'failed')
    assert.equal(exists(fixture.sourceRoot), true)
    assert.equal(exists(isolationPath), true)
    assert.equal(exists(movedIsolation), true)
  })

  it('fails closed when an empty retirement isolation identity changes during recovery inspection', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    await prepareAcknowledgedFixture(fixture, migration)
    await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      afterRetirementPayloadRemoval() {
        throw new Error('interrupt_after_retirement_payload_removal')
      },
    })
    const isolatedJournal = readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    const isolationPath = retirementIsolationPath(fixture, isolatedJournal)
    const movedIsolation = `${isolationPath}-original`
    let replaced = false
    const fsApi = {
      ...fs,
      readdirSync(target, options) {
        if (!replaced && target == isolationPath) {
          replaced = true
          fs.renameSync(isolationPath, movedIsolation)
          fs.mkdirSync(isolationPath)
          return []
        }
        return fs.readdirSync(target, options)
      },
    }

    const result = await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-3',
      fsApi,
    })

    assert.equal(result.state, 'failed')
    assert.equal(readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE).state, 'retirement-isolated')
    assert.equal(exists(isolationPath), true)
    assert.equal(exists(movedIsolation), true)
  })

  it('revalidates userData identity before finalizing an empty retirement isolation', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    await prepareAcknowledgedFixture(fixture, migration)
    await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      afterRetirementPayloadRemoval() {
        throw new Error('interrupt_after_retirement_payload_removal')
      },
    })
    const isolatedJournal = readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    const userDataPath = path.dirname(fixture.sourceRoot)
    const movedUserData = `${userDataPath}-original`
    const isolationPath = retirementIsolationPath(fixture, isolatedJournal)
    const movedIsolation = path.join(movedUserData, isolatedJournal.retirement.isolationBasename)
    fs.renameSync(userDataPath, movedUserData)
    fs.mkdirSync(userDataPath)
    fs.renameSync(movedIsolation, isolationPath)

    const result = await migration.retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-3' })

    assert.equal(result.state, 'failed')
    assert.equal(readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE).state, 'retirement-isolated')
    assert.equal(exists(isolationPath), true)
    assert.equal(exists(movedUserData), true)
  })

  it('retains unexpected entries in the journal-bound private isolation', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    await prepareAcknowledgedFixture(fixture, migration)
    await migration.retireAcknowledgedPortableSource({
      ...fixture,
      runId: 'startup-2',
      afterJournalWrite(journal) {
        if (journal.state == 'retirement-intent') throw new Error('interrupt_after_intent')
      },
    })
    const intentJournal = readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    const isolationPath = retirementIsolationPath(fixture, intentJournal)
    const unexpectedPath = path.join(isolationPath, 'unexpected')
    fs.writeFileSync(unexpectedPath, 'retain')

    const result = await migration.retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-3' })

    assert.equal(result.state, 'failed')
    assert.equal(exists(fixture.sourceRoot), true)
    assert.equal(fs.readFileSync(unexpectedPath, 'utf8'), 'retain')
  })

  it('preserves unreferenced portable retirement isolations', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    await prepareAcknowledgedFixture(fixture, migration)
    const unreferencedPath = path.join(
      path.dirname(fixture.sourceRoot),
      '.lx-portable-retired-0123456789abcdef0123456789abcdef',
    )
    fs.mkdirSync(unreferencedPath)
    fs.writeFileSync(path.join(unreferencedPath, 'operator-data'), 'retain')

    const result = await migration.retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-2' })

    assert.equal(result.state, 'retired')
    assert.equal(fs.readFileSync(path.join(unreferencedPath, 'operator-data'), 'utf8'), 'retain')
  })

  it('upgrades an identity-bound version-1 journal only after exact source and destination reverify', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    const prepared = await migration.preparePortableProfile(fixture)
    const journalPath = path.join(fixture.portableRoot, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    const versionOne = readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    versionOne.version = 1
    delete versionOne.retirement
    fs.writeFileSync(journalPath, JSON.stringify(versionOne, null, 2))

    const resumed = await migration.preparePortableProfile({ ...fixture, runId: 'startup-2' })

    assert.equal(resumed.state, 'already-promoted')
    assert.equal(resumed.token.promotionRunId, prepared.token.promotionRunId)
    assert.deepEqual(readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE), {
      ...versionOne,
      version: 2,
      preparationRunId: 'startup-2',
      retirement: null,
    })
  })

  it('does not upgrade an identity-bound version-1 journal after destination manifest mismatch', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    await migration.preparePortableProfile(fixture)
    const journalPath = path.join(fixture.portableRoot, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    const versionOne = readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    versionOne.version = 1
    delete versionOne.retirement
    const versionOneRaw = JSON.stringify(versionOne, null, 2)
    fs.writeFileSync(journalPath, versionOneRaw)
    fs.writeFileSync(path.join(fixture.profileRoot, 'lx.data.db'), 'changed-destination')

    const result = await migration.preparePortableProfile({ ...fixture, runId: 'startup-2' })

    assert.equal(result.state, 'failed')
    assert.match(result.error.message, /destination manifest/i)
    assert.equal(fs.readFileSync(journalPath, 'utf8'), versionOneRaw)
    assert.equal(exists(fixture.sourceRoot), true)
  })

  it('keeps an identity-bound version-1 typed journal read-only when its source is absent', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    const prepared = await migration.preparePortableProfile(fixture)
    await migration.acknowledgePortableProfileStartup(prepared.token)
    const journalPath = path.join(fixture.portableRoot, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    const versionOne = readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    versionOne.version = 1
    delete versionOne.retirement
    const versionOneRaw = JSON.stringify(versionOne, null, 2)
    fs.writeFileSync(journalPath, versionOneRaw)
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: false })

    const result = await migration.preparePortableProfile({ ...fixture, runId: 'startup-2' })

    assert.equal(result.state, 'already-acknowledged')
    assert.equal(fs.readFileSync(journalPath, 'utf8'), versionOneRaw)
    const unchanged = readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    assert.equal(unchanged.version, 1)
    assert.equal(unchanged.retirement, undefined)
  })

  it('rejects a version-1 typed journal with an absent source and replaced userData identity', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const migration = require(migrationModule)
    const prepared = await migration.preparePortableProfile(fixture)
    await migration.acknowledgePortableProfileStartup(prepared.token)
    const journalPath = path.join(fixture.portableRoot, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    const versionOne = readJournal(fixture, migration.PORTABLE_PROFILE_JOURNAL_FILE)
    versionOne.version = 1
    delete versionOne.retirement
    const versionOneRaw = JSON.stringify(versionOne, null, 2)
    fs.writeFileSync(journalPath, versionOneRaw)
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: false })
    const movedUserData = replaceDirectoryWithSameContent(path.dirname(fixture.sourceRoot))

    const result = await migration.preparePortableProfile({ ...fixture, runId: 'startup-2' })

    assert.equal(result.state, 'failed')
    assert.match(result.error.message, /userData identity/i)
    assert.equal(fs.readFileSync(journalPath, 'utf8'), versionOneRaw)
    assert.equal(exists(movedUserData), true)
  })

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

    const first = await preparePortableProfile(fixture)

    assert.equal(first.state, 'promoted')
    assert.equal(exists(fixture.sourceRoot), true)
    assert.equal(exists(path.join(fixture.profileRoot, 'lx.data.db')), true)
    assert.equal(exists(path.join(fixture.profileRoot, 'Session Storage')), false)
    assert.equal(exists(path.join(fixture.profileRoot, 'outside.txt')), false)

    const acknowledged = await acknowledgePortableProfileStartup(first.token)
    assert.equal(acknowledged.state, 'typed-only-acknowledged')
    assert.equal(exists(fixture.sourceRoot), true)
    assert.equal((await retireAcknowledgedPortableSource(fixture)).state, 'same-startup')
    assert.equal(exists(fixture.sourceRoot), true)

    const nextStartup = { ...fixture, runId: 'startup-2' }
    assert.equal((await retireAcknowledgedPortableSource(nextStartup)).state, 'retired')
    assert.equal(exists(fixture.sourceRoot), false)
    assert.equal(exists(path.join(fixture.portableRoot, 'userData')), true)
    assert.equal(fs.readFileSync(path.join(fixture.portableRoot, 'userData', 'outside.txt'), 'utf8'), 'do-not-copy')
  })

  it('leaves a fresh portable install untouched when no legacy LxDatas exists', async() => {
    const fixture = createFixture()
    const { preparePortableProfile } = require(migrationModule)

    const result = await preparePortableProfile(fixture)

    assert.equal(result.state, 'source-missing')
    assert.equal(exists(fixture.profileRoot), false)
    assert.equal(result.token, undefined)
  })

  it('reclaims a failed owned stage and succeeds on retry', async() => {
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
      write(descriptor, buffer, offset, length, position, callback) {
        if (interrupted) return process.nextTick(callback, new Error('copy interrupted'))
        return fs.write(descriptor, buffer, offset, length, position, callback)
      },
    }

    const first = await preparePortableProfile({ ...fixture, fsApi })
    assert.equal(first.state, 'failed')
    assert.equal(exists(stagePath), false)
    interrupted = false

    const second = await preparePortableProfile(fixture)
    assert.equal(second.state, 'promoted')
    assert.equal(exists(stagePath), false)
    assert.equal(fs.readFileSync(path.join(fixture.profileRoot, 'nested', 'config.json'), 'utf8'), '{"theme":"dark"}')
  })

  it('fails while the real migration lease is held and succeeds after release', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const { PORTABLE_PROFILE_LOCK_FILE, preparePortableProfile } = require(migrationModule)
    const { acquireMigrationLease, releaseMigrationLease } = require('../../src/main/migration/migrationLease')
    const lockPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_LOCK_FILE)
    const lease = await acquireMigrationLease({ rootPath: fixture.portableRoot, lockPath, logger: silentLogger })

    const blocked = await preparePortableProfile(fixture)
    assert.equal(blocked.state, 'failed')
    assert.equal(exists(lockPath), true)
    assert.equal(exists(fixture.profileRoot), false)

    await releaseMigrationLease(lease)
    const recovered = await preparePortableProfile(fixture)
    assert.equal(recovered.state, 'promoted')
    assert.equal(exists(lockPath), false)
  })

  it('refuses a non-empty destination without a valid matching journal', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    fs.mkdirSync(fixture.profileRoot)
    fs.writeFileSync(path.join(fixture.profileRoot, 'collision.txt'), 'unowned')
    const { preparePortableProfile } = require(migrationModule)

    const result = await preparePortableProfile(fixture)

    assert.equal(result.state, 'failed')
    assert.match(result.error.message, /destination/i)
    assert.equal(fs.readFileSync(path.join(fixture.profileRoot, 'collision.txt'), 'utf8'), 'unowned')
    assert.equal(fs.readFileSync(path.join(fixture.sourceRoot, 'lx.data.db'), 'utf8'), 'database-v1')
  })

  it('does not promote a copy when the source mutates and succeeds from the new source on retry', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const databasePath = path.join(fixture.sourceRoot, 'lx.data.db')
    const { preparePortableProfile } = require(migrationModule)
    let mutate = true
    const fsApi = {
      ...fs,
      write(descriptor, buffer, offset, length, position, callback) {
        fs.write(descriptor, buffer, offset, length, position, (error, ...values) => {
          if (mutate) fs.writeFileSync(databasePath, 'database-v2')
          callback(error, ...values)
        })
      },
    }

    const first = await preparePortableProfile({ ...fixture, fsApi })
    assert.equal(first.state, 'failed')
    assert.equal(exists(fixture.profileRoot), false)
    mutate = false

    const second = await preparePortableProfile({ ...fixture, fsApi })
    assert.equal(second.state, 'promoted')
    assert.equal(fs.readFileSync(path.join(fixture.profileRoot, 'lx.data.db'), 'utf8'), 'database-v2')
  })

  it('rejects a linked source entry without reading or modifying its target', async t => {
    const fixture = createFixture()
    seedSource(fixture)
    const externalRoot = path.join(fixture.portableRoot, 'external')
    fs.mkdirSync(externalRoot)
    fs.writeFileSync(path.join(externalRoot, 'sentinel'), 'external')
    if (!createDirectoryLink(t, externalRoot, path.join(fixture.sourceRoot, 'linked'))) return
    const { preparePortableProfile } = require(migrationModule)

    const result = await preparePortableProfile(fixture)

    assert.equal(result.state, 'failed')
    assert.equal(exists(fixture.profileRoot), false)
    assert.equal(fs.readFileSync(path.join(externalRoot, 'sentinel'), 'utf8'), 'external')
  })

  it('serializes two creators so only one promotion owns the destination', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const { preparePortableProfile } = require(migrationModule)
    const results = await Promise.all([
      preparePortableProfile(fixture),
      preparePortableProfile({ ...fixture, runId: 'startup-2' }),
    ])

    assert.deepEqual(results.map(result => result.state).sort(), ['already-promoted', 'promoted'])
    assert.equal((await preparePortableProfile({ ...fixture, runId: 'startup-3' })).state, 'already-promoted')
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

    const collision = await preparePortableProfile({ ...fixture, fsApi })

    assert.equal(collision.state, 'failed')
    assert.equal(fs.readFileSync(path.join(fixture.profileRoot, 'collision.txt'), 'utf8'), 'unowned')
    const retry = await preparePortableProfile({ ...fixture, runId: 'startup-2' })
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

  it('finalizes a post-rename receipt without claiming an unreferenced owned stage', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      PORTABLE_PROFILE_RECEIPT_FILE,
      PORTABLE_PROFILE_STAGE_PREFIX,
      preparePortableProfile,
    } = require(migrationModule)
    const { STAGE_MARKER_FILE } = require('../../src/main/migration/guardedDirectoryMigration.js')
    assert.equal((await preparePortableProfile(fixture)).state, 'promoted')
    const journalPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    fs.unlinkSync(journalPath)
    fs.writeFileSync(path.join(fixture.portableRoot, PORTABLE_PROFILE_RECEIPT_FILE), JSON.stringify({
      version: 1,
      sourceManifestHash: journal.sourceManifestHash,
      destinationManifestHash: journal.destinationManifestHash,
      userDataIdentity: journal.userDataIdentity,
      sourceIdentity: journal.sourceIdentity,
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

    const retry = await preparePortableProfile({ ...fixture, runId: 'startup-2' })

    assert.equal(retry.state, 'already-promoted')
    assert.equal(exists(stagePath), true)
    assert.equal(exists(path.join(fixture.portableRoot, PORTABLE_PROFILE_RECEIPT_FILE)), false)
    assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).state, 'promoted')
  })

  it('keeps a valid legacy promoted journal usable without issuing deletion authority', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      preparePortableProfile,
      retireAcknowledgedPortableSource,
    } = require(migrationModule)
    assert.equal((await preparePortableProfile(fixture)).state, 'promoted')
    const journalPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    const legacyRaw = JSON.stringify(legacyJournalFrom(journal), null, 2)
    fs.writeFileSync(journalPath, legacyRaw)

    const resumed = await preparePortableProfile({ ...fixture, runId: 'startup-2' })

    assert.equal(resumed.state, 'already-promoted')
    assert.equal(resumed.token, undefined)
    assert.equal(exists(fixture.sourceRoot), true)
    assert.equal(fs.readFileSync(journalPath, 'utf8'), legacyRaw)
    assert.equal((await retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-3' })).state, 'not-acknowledged')
  })

  it('keeps a legacy typed-only journal usable without deletion authority', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      acknowledgePortableProfileStartup,
      preparePortableProfile,
      retireAcknowledgedPortableSource,
    } = require(migrationModule)
    const promoted = await preparePortableProfile(fixture)
    await acknowledgePortableProfileStartup(promoted.token)
    const journalPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    const legacyRaw = JSON.stringify(legacyJournalFrom(journal), null, 2)
    fs.writeFileSync(journalPath, legacyRaw)

    const firstLaterRun = await retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-2' })

    assert.equal(firstLaterRun.state, 'not-acknowledged')
    assert.equal(exists(fixture.sourceRoot), true)
    const prepared = await preparePortableProfile({ ...fixture, runId: 'startup-2' })
    assert.equal(prepared.state, 'already-acknowledged')
    assert.equal(prepared.token, undefined)
    assert.equal(fs.readFileSync(journalPath, 'utf8'), legacyRaw)
    assert.equal((await retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-3' })).state, 'not-acknowledged')
    assert.equal(exists(fixture.sourceRoot), true)
  })

  it('recovers a legacy pending receipt without creating deletion authority', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      PORTABLE_PROFILE_RECEIPT_FILE,
      PORTABLE_PROFILE_STAGE_PREFIX,
      preparePortableProfile,
      retireAcknowledgedPortableSource,
    } = require(migrationModule)
    const { STAGE_MARKER_FILE } = require('../../src/main/migration/guardedDirectoryMigration.js')
    assert.equal((await preparePortableProfile(fixture)).state, 'promoted')
    const journalPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    fs.unlinkSync(journalPath)
    const receiptPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_RECEIPT_FILE)
    fs.writeFileSync(receiptPath, JSON.stringify(legacyReceiptFrom(journal), null, 2))
    const stagePath = fs.mkdtempSync(path.join(fixture.portableRoot, PORTABLE_PROFILE_STAGE_PREFIX))
    const stageIdentity = fs.lstatSync(stagePath)
    fs.writeFileSync(path.join(stagePath, STAGE_MARKER_FILE), JSON.stringify({
      version: 1,
      nonce: 'abcdef0123456789abcdef0123456789',
      runId: journal.promotionRunId,
      directoryIdentity: { dev: String(stageIdentity.dev), ino: String(stageIdentity.ino) },
    }))

    const recovered = await preparePortableProfile({ ...fixture, runId: 'startup-2' })

    assert.equal(recovered.state, 'already-promoted')
    assert.equal(exists(fixture.sourceRoot), true)
    assert.equal(exists(receiptPath), false)
    assert.equal(exists(stagePath), true)
    assert.equal(recovered.token, undefined)
    const recoveredJournal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    assert.equal(recoveredJournal.userDataIdentity, undefined)
    assert.equal(recoveredJournal.sourceIdentity, undefined)
    assert.equal(recoveredJournal.version, 1)
    assert.equal(recoveredJournal.state, 'promoted')
    assert.equal((await retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-3' })).state, 'not-acknowledged')
    assert.equal(exists(fixture.sourceRoot), true)
  })

  for (const target of ['source', 'userData']) {
    it(`preserves same-content ${target} replacement present before legacy journal handling`, async() => {
      const fixture = createFixture()
      seedSource(fixture)
      const {
        PORTABLE_PROFILE_JOURNAL_FILE,
        acknowledgePortableProfileStartup,
        preparePortableProfile,
        retireAcknowledgedPortableSource,
      } = require(migrationModule)
      assert.equal((await preparePortableProfile(fixture)).state, 'promoted')
      const journalPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
      fs.writeFileSync(journalPath, JSON.stringify(legacyJournalFrom(journal), null, 2))
      const replacementTarget = target == 'source' ? fixture.sourceRoot : path.dirname(fixture.sourceRoot)
      const originalRoot = replaceDirectoryWithSameContent(replacementTarget)

      const resumed = await preparePortableProfile({ ...fixture, runId: 'startup-2' })
      if (resumed.token != null) await acknowledgePortableProfileStartup(resumed.token)
      const retirement = await retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-3' })

      assert.equal(retirement.state, 'not-acknowledged')
      assert.equal(resumed.token, undefined)
      assert.equal(fs.readFileSync(path.join(fixture.sourceRoot, 'lx.data.db'), 'utf8'), 'database-v1')
      const originalDatabase = target == 'source'
        ? path.join(originalRoot, 'lx.data.db')
        : path.join(originalRoot, 'LxDatas', 'lx.data.db')
      assert.equal(fs.readFileSync(originalDatabase, 'utf8'), 'database-v1')
    })

    it(`preserves same-content ${target} replacement present before legacy receipt recovery`, async() => {
      const fixture = createFixture()
      seedSource(fixture)
      const {
        PORTABLE_PROFILE_JOURNAL_FILE,
        PORTABLE_PROFILE_RECEIPT_FILE,
        acknowledgePortableProfileStartup,
        preparePortableProfile,
        retireAcknowledgedPortableSource,
      } = require(migrationModule)
      assert.equal((await preparePortableProfile(fixture)).state, 'promoted')
      const journalPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
      fs.unlinkSync(journalPath)
      fs.writeFileSync(
        path.join(fixture.portableRoot, PORTABLE_PROFILE_RECEIPT_FILE),
        JSON.stringify(legacyReceiptFrom(journal), null, 2),
      )
      const replacementTarget = target == 'source' ? fixture.sourceRoot : path.dirname(fixture.sourceRoot)
      const originalRoot = replaceDirectoryWithSameContent(replacementTarget)

      const recovered = await preparePortableProfile({ ...fixture, runId: 'startup-2' })
      if (recovered.token != null) await acknowledgePortableProfileStartup(recovered.token)
      const retirement = await retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-3' })

      assert.equal(retirement.state, 'not-acknowledged')
      assert.equal(recovered.token, undefined)
      assert.equal(fs.readFileSync(path.join(fixture.sourceRoot, 'lx.data.db'), 'utf8'), 'database-v1')
      const originalDatabase = target == 'source'
        ? path.join(originalRoot, 'lx.data.db')
        : path.join(originalRoot, 'LxDatas', 'lx.data.db')
      assert.equal(fs.readFileSync(originalDatabase, 'utf8'), 'database-v1')
    })
  }

  it('fails closed on an ambiguous legacy receipt beside a bound journal', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      PORTABLE_PROFILE_RECEIPT_FILE,
      preparePortableProfile,
    } = require(migrationModule)
    assert.equal((await preparePortableProfile(fixture)).state, 'promoted')
    const journalPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
    const receiptPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_RECEIPT_FILE)
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    fs.writeFileSync(receiptPath, JSON.stringify(legacyReceiptFrom(journal), null, 2))
    fs.rmSync(fixture.profileRoot, { recursive: true, force: false })

    const result = await preparePortableProfile({ ...fixture, runId: 'startup-2' })

    assert.equal(result.state, 'failed')
    assert.equal(exists(fixture.sourceRoot), true)
    assert.equal(exists(journalPath), true)
    assert.equal(exists(receiptPath), true)
  })

  it('does not enrich a legacy journal when its recorded source manifest no longer matches', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const { PORTABLE_PROFILE_JOURNAL_FILE, preparePortableProfile } = require(migrationModule)
    assert.equal((await preparePortableProfile(fixture)).state, 'promoted')
    const journalPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    const legacyRaw = JSON.stringify(legacyJournalFrom(journal), null, 2)
    fs.writeFileSync(journalPath, legacyRaw)
    fs.writeFileSync(path.join(fixture.sourceRoot, 'lx.data.db'), 'changed-before-upgrade')

    const result = await preparePortableProfile({ ...fixture, runId: 'startup-2' })

    assert.equal(result.state, 'failed')
    assert.match(result.error.message, /source manifest/i)
    assert.equal(fs.readFileSync(journalPath, 'utf8'), legacyRaw)
    assert.equal(exists(fixture.sourceRoot), true)
  })

  it('rejects acknowledgement tokens that do not match the recorded promotion', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      acknowledgePortableProfileStartup,
      preparePortableProfile,
    } = require(migrationModule)
    const promoted = await preparePortableProfile(fixture)
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
      const promoted = await preparePortableProfile(fixture)
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

  it('rejects same-content source replacement before acknowledgement', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      acknowledgePortableProfileStartup,
      preparePortableProfile,
    } = require(migrationModule)
    const promoted = await preparePortableProfile(fixture)
    const journalPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
    const journalBeforeAcknowledgement = fs.readFileSync(journalPath, 'utf8')
    const originalSourceRoot = replaceDirectoryWithSameContent(fixture.sourceRoot)

    await assert.rejects(acknowledgePortableProfileStartup(promoted.token), /source|identity|ownership/i)

    assert.equal(fs.readFileSync(journalPath, 'utf8'), journalBeforeAcknowledgement)
    assert.equal(fs.readFileSync(path.join(fixture.sourceRoot, 'lx.data.db'), 'utf8'), 'database-v1')
    assert.equal(fs.readFileSync(path.join(originalSourceRoot, 'lx.data.db'), 'utf8'), 'database-v1')
  })

  it('rejects same-content userData ancestry replacement before acknowledgement', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const userDataRoot = path.dirname(fixture.sourceRoot)
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      acknowledgePortableProfileStartup,
      preparePortableProfile,
    } = require(migrationModule)
    const promoted = await preparePortableProfile(fixture)
    const journalPath = path.join(fixture.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
    const journalBeforeAcknowledgement = fs.readFileSync(journalPath, 'utf8')
    const originalUserDataRoot = replaceDirectoryWithSameContent(userDataRoot)

    await assert.rejects(acknowledgePortableProfileStartup(promoted.token), /userData|identity|ownership/i)

    assert.equal(fs.readFileSync(journalPath, 'utf8'), journalBeforeAcknowledgement)
    assert.equal(fs.readFileSync(path.join(fixture.sourceRoot, 'lx.data.db'), 'utf8'), 'database-v1')
    assert.equal(fs.readFileSync(path.join(originalUserDataRoot, 'LxDatas', 'lx.data.db'), 'utf8'), 'database-v1')
  })

  it('rejects a token whose startup run ID changed without changing the journal', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      acknowledgePortableProfileStartup,
      preparePortableProfile,
    } = require(migrationModule)
    const promoted = await preparePortableProfile(fixture)
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
    assert.equal((await preparePortableProfile(fixture)).state, 'promoted')
    fs.writeFileSync(path.join(fixture.profileRoot, 'lx.data.db'), 'typed-schema-v7')

    const retry = await preparePortableProfile({ ...fixture, runId: 'startup-2' })

    assert.equal(retry.state, 'already-promoted')
    assert.equal(await acknowledgePortableProfileStartup(retry.token).then(result => result.state), 'typed-only-acknowledged')
    assert.equal((await retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-2' })).state, 'same-startup')
    assert.equal((await retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-3' })).state, 'retired')
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
      const promoted = await preparePortableProfile(fixture)
      await acknowledgePortableProfileStartup(promoted.token)
      const changedRoot = mutation == 'source' ? fixture.sourceRoot : fixture.profileRoot
      fs.writeFileSync(path.join(changedRoot, 'lx.data.db'), `${mutation}-changed`)

      const result = await retireAcknowledgedPortableSource({ ...fixture, runId: `later-${mutation}` })

      assert.equal(result.state, 'failed', mutation)
      assert.equal(exists(fixture.sourceRoot), true, mutation)
    }
  })

  it('rejects same-content source replacement before later-start retirement', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const {
      acknowledgePortableProfileStartup,
      preparePortableProfile,
      retireAcknowledgedPortableSource,
    } = require(migrationModule)
    const promoted = await preparePortableProfile(fixture)
    await acknowledgePortableProfileStartup(promoted.token)
    const originalSourceRoot = replaceDirectoryWithSameContent(fixture.sourceRoot)

    const result = await retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-2' })

    assert.equal(result.state, 'failed')
    assert.equal(fs.readFileSync(path.join(fixture.sourceRoot, 'lx.data.db'), 'utf8'), 'database-v1')
    assert.equal(fs.readFileSync(path.join(originalSourceRoot, 'lx.data.db'), 'utf8'), 'database-v1')
  })

  it('rejects same-content userData ancestry replacement before later-start retirement', async() => {
    const fixture = createFixture()
    seedSource(fixture)
    const userDataRoot = path.dirname(fixture.sourceRoot)
    const {
      acknowledgePortableProfileStartup,
      preparePortableProfile,
      retireAcknowledgedPortableSource,
    } = require(migrationModule)
    const promoted = await preparePortableProfile(fixture)
    await acknowledgePortableProfileStartup(promoted.token)
    const originalUserDataRoot = replaceDirectoryWithSameContent(userDataRoot)

    const result = await retireAcknowledgedPortableSource({ ...fixture, runId: 'startup-2' })

    assert.equal(result.state, 'failed')
    assert.equal(fs.readFileSync(path.join(fixture.sourceRoot, 'lx.data.db'), 'utf8'), 'database-v1')
    assert.equal(fs.readFileSync(path.join(originalUserDataRoot, 'LxDatas', 'lx.data.db'), 'utf8'), 'database-v1')
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
    const promoted = await preparePortableProfile(fixture)
    await acknowledgePortableProfileStartup(promoted.token)

    const result = await retireAcknowledgedPortableSource({
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
    const promoted = await preparePortableProfile(fixture)
    await acknowledgePortableProfileStartup(promoted.token)

    const result = await retireAcknowledgedPortableSource({
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
