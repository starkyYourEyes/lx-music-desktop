const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

const worktreeRoot = path.resolve(__dirname, '../..')
const taskRoot = path.join(worktreeRoot, '.superpowers/sdd/2026-07-29-playback-activity/tmp/task-11')
const fixturePath = path.join(worktreeRoot, 'build-config/storage/fixtures/playback-recorder-child.mjs')
fs.mkdirSync(taskRoot, { recursive: true })
process.env.TEMP = taskRoot
process.env.TMP = taskRoot

// Electron ABI tests transpile source modules in-process.
// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  module._compile(output, filename)
}

const dbService = require('../../src/main/worker/dbService/db.ts')
const repository = require('../../src/main/worker/dbService/modules/playback/index.ts')
const roots = []
const children = new Set()
const startedAtMs = Date.parse('2026-08-01T00:00:00.000Z')

const timeoutAfter = (timeoutMs, code) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(code)), timeoutMs)
  timer.unref?.()
})

const waitForMessage = (child, predicate, timeoutMs = 3_000) => new Promise((resolve, reject) => {
  let timer
  const cleanup = () => {
    clearTimeout(timer)
    child.off('message', onMessage)
    child.off('error', onError)
    child.off('exit', onExit)
  }
  const finish = callback => value => { cleanup(); callback(value) }
  const onMessage = value => {
    let matches = false
    try { matches = predicate(value) } catch (error) { finish(reject)(error); return }
    if (matches) finish(resolve)(value)
  }
  const onError = finish(reject)
  const onExit = finish(() => reject(new Error('child_exited_before_message')))
  child.on('message', onMessage)
  child.on('error', onError)
  child.on('exit', onExit)
  timer = setTimeout(() => finish(() => reject(new Error('child_message_timeout')))(), timeoutMs)
  timer.unref?.()
})

const awaitExitAndClose = (child, timeoutMs = 3_000) => new Promise((resolve, reject) => {
  let exited = child.exitCode != null
  let closed = false
  let timer
  const cleanup = () => {
    clearTimeout(timer)
    child.off('exit', onExit)
    child.off('close', onClose)
    child.off('error', onError)
  }
  const finish = () => {
    if (!exited || !closed) return
    cleanup()
    children.delete(child)
    resolve({ exitCode: child.exitCode, signalCode: child.signalCode })
  }
  const onExit = () => { exited = true; finish() }
  const onClose = () => { closed = true; finish() }
  const onError = error => { cleanup(); reject(error) }
  child.on('exit', onExit)
  child.on('close', onClose)
  child.on('error', onError)
  timer = setTimeout(() => { cleanup(); reject(new Error('child_exit_timeout')) }, timeoutMs)
  timer.unref?.()
})

const killAndWait = async(child, timeoutMs = 3_000) => {
  const exited = awaitExitAndClose(child, timeoutMs)
  assert.equal(child.kill(), true)
  return exited
}

const spawnRecorder = async(root, options = {}) => {
  const child = fork(fixturePath, [], {
    execPath: process.execPath,
    cwd: worktreeRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TEMP: root,
      TMP: root,
      LX_PROFILE_ROOT: path.join(root, 'profile'),
      LX_DATA_ROOT: path.join(root, 'data'),
      LX_DATABASE_ROOT: path.join(root, 'database'),
      ...(options.suppressReady ? { LX_PLAYBACK_CHILD_SUPPRESS_READY: '1' } : {}),
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  children.add(child)
  if (!options.suppressReady) {
    assert.deepEqual(await waitForMessage(child, message => message?.type == 'ready'), { type: 'ready', version: 1 })
  }
  return child
}

let requestId = 0
const sendCommand = async(child, action, expectedType = 'durable', timeoutMs = 3_000) => {
  const id = ++requestId
  const pending = waitForMessage(child, message => message?.requestId == id && message.type == expectedType, timeoutMs)
  child.send({ type: 'command', version: 1, requestId: id, action })
  return pending
}

const acknowledge = async(child, durable, ack) => {
  const id = ++requestId
  const pending = waitForMessage(child, message => message?.type == 'ack' && message.requestId == id)
  child.send({ type: 'ack', version: 1, requestId: id, ack })
  const result = await pending
  assert.equal(result.checkpointSeq, ack.mode == 'activity' ? ack.ack.checkpointSeq : ack.checkpointSeq)
  return result
}

const commitDurable = durable => {
  assert.equal(durable.type, 'durable')
  switch (durable.command.kind) {
    case 'start': return repository.playbackStart(durable.command.request)
    case 'commit': return repository.playbackCommit(durable.command.request)
    default: throw new Error(`unexpected durable kind ${durable.command.kind}`)
  }
}

const createRoot = () => {
  const root = fs.mkdtempSync(path.join(taskRoot, 'crash-'))
  roots.push(root)
  for (const child of ['profile', 'data', 'database']) fs.mkdirSync(path.join(root, child), { recursive: true })
  return root
}

const openStore = async root => {
  const dataPath = path.join(root, 'database')
  const result = await dbService.init({
    dataPath,
    backupDir: path.join(dataPath, 'backups'),
    previousShutdownWasClean: false,
  })
  assert.equal(result.status, 'ready')
  return dbService.getDB()
}

const group = suffix => `123e4567-e89b-42d3-a456-4266141740${suffix}`
const totalLivePlayedMs = db => db.prepare('SELECT live_played_ms AS value FROM activity_totals WHERE id = 1').get().value
const session = (db, playbackGroupUuid) => db.prepare(`
  SELECT state, end_reason AS endReason, ended_at_ms AS endedAtMs, checkpoint_seq AS checkpointSeq,
    cumulative_played_ms AS cumulativePlayedMs
  FROM playback_sessions WHERE playback_group_uuid = ? ORDER BY segment_no DESC LIMIT 1
`).get(playbackGroupUuid)

const relevantSnapshot = db => Object.fromEntries([
  'playback_sessions', 'playback_events', 'recent_tracks', 'listening_daily', 'listening_tracks',
  'activity_totals', 'playback_resume_state',
].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))

const withoutInterruption = value => ({
  ...value,
  playback_sessions: value.playback_sessions.map(row => ({ ...row, state: 'playing', ended_at_ms: null })),
})

afterEach(async() => {
  for (const child of [...children]) {
    try {
      if (child.exitCode == null && child.signalCode == null) {
        await Promise.race([killAndWait(child, 1_000), timeoutAfter(1_100, 'cleanup_child_timeout')])
      }
    } catch {}
  }
  try { dbService.close() } catch {}
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('renderer crash checkpoint durability', () => {
  it('requires the rollback-safe Task 11 repository smoke before crash attestation', () => {
    assert.equal(typeof repository.playbackRunTypedSmoke, 'function')
  })

  it('validates malformed IPC and bounds ready and durable waits with cleanup', async() => {
    const root = createRoot()
    const silent = await spawnRecorder(root, { suppressReady: true })
    await assert.rejects(waitForMessage(silent, message => message?.type == 'ready', 50), /child_message_timeout/)
    await killAndWait(silent)

    const child = await spawnRecorder(root)
    await assert.rejects(awaitExitAndClose(child, 50), /child_exit_timeout/)
    const errorPromise = waitForMessage(child, message => message?.type == 'error')
    child.send({ type: 'command', version: 1, requestId: 1, action: { type: 'start' }, excess: true })
    const error = await errorPromise
    assert.deepEqual(error, { type: 'error', version: 1, requestId: 0, code: 'invalid_command_message' })
    await assert.rejects(sendCommand(child, { type: 'advance-only', cumulativePlayedMs: 1 }, 'durable', 50), /child_message_timeout/)
    await killAndWait(child)
  })

  it('loses exactly 14,999 ms after sequence 2 is durable and the renderer is killed', async() => {
    const root = createRoot()
    const db = await openStore(root)
    const playbackGroupUuid = group('00')
    const child = await spawnRecorder(root)

    const start = await sendCommand(child, { type: 'start', playbackGroupUuid, occurredAtMs: startedAtMs })
    const startResult = commitDurable(start)
    await acknowledge(child, start, startResult)

    const checkpoint = await sendCommand(child, {
      type: 'advance-checkpoint',
      cumulativePlayedMs: 15_000,
      occurredAtMs: startedAtMs + 15_000,
    })
    assert.equal(checkpoint.command.request.checkpoint.checkpointSeq, 2)
    const checkpointAck = commitDurable(checkpoint)
    assert.equal(session(db, playbackGroupUuid).checkpointSeq, 2)
    await acknowledge(child, checkpoint, checkpointAck)

    const advanced = await sendCommand(child, { type: 'advance-only', cumulativePlayedMs: 29_999 }, 'ack')
    assert.equal(advanced.cumulativePlayedMs, 29_999)
    await killAndWait(child)

    dbService.close()
    const reopened = await openStore(root)
    repository.playbackMarkStaleSessionsInterrupted({ nowMs: startedAtMs + 30_000 })
    assert.equal(totalLivePlayedMs(reopened), 15_000)
    assert.equal(29_999 - totalLivePlayedMs(reopened), 14_999)
    assert.deepEqual(session(reopened, playbackGroupUuid), {
      state: 'interrupted',
      endReason: null,
      endedAtMs: startedAtMs + 30_000,
      checkpointSeq: 2,
      cumulativePlayedMs: 15_000,
    })
    assert.deepEqual(repository.playbackCommit(checkpoint.command.request), checkpointAck)
    assert.equal(totalLivePlayedMs(reopened), 15_000)
    assert.deepEqual(reopened.pragma('quick_check'), [{ quick_check: 'ok' }])
    assert.deepEqual(reopened.pragma('foreign_key_check'), [])
  })

  it('keeps a dropped acknowledgement byte-identical and idempotent before and after reopen', async() => {
    const root = createRoot()
    const db = await openStore(root)
    const playbackGroupUuid = group('01')
    const child = await spawnRecorder(root)

    const start = await sendCommand(child, { type: 'start', playbackGroupUuid, occurredAtMs: startedAtMs })
    await acknowledge(child, start, commitDurable(start))
    const durable = await sendCommand(child, {
      type: 'advance-checkpoint',
      cumulativePlayedMs: 15_000,
      occurredAtMs: startedAtMs + 15_000,
    })
    const ack = commitDurable(durable)
    const afterFirstCommit = relevantSnapshot(db)

    // Deliberately drop only sequence 2's acknowledgement and ask the reducer adapter to retry.
    const retry = await sendCommand(child, { type: 'retry' })
    assert.equal(JSON.stringify(retry.command), JSON.stringify(durable.command))
    assert.deepEqual(commitDurable(retry), ack)
    assert.deepEqual(relevantSnapshot(db), afterFirstCommit)
    await killAndWait(child)

    dbService.close()
    const reopened = await openStore(root)
    assert.deepEqual(repository.playbackCommit(durable.command.request), ack)
    assert.deepEqual(relevantSnapshot(reopened), afterFirstCommit)
    repository.playbackMarkStaleSessionsInterrupted({ nowMs: startedAtMs + 30_000 })
    assert.deepEqual(withoutInterruption(relevantSnapshot(reopened)), afterFirstCommit)
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM playback_events').get().count, 1)
    assert.deepEqual(reopened.pragma('quick_check'), [{ quick_check: 'ok' }])
    assert.deepEqual(reopened.pragma('foreign_key_check'), [])
  })
})
