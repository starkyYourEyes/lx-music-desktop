const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

const worktreeRoot = path.resolve(__dirname, '../..')
const fixturePath = path.join(worktreeRoot, 'build-config/storage/fixtures/playback-recorder-child.mjs')

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
const { createTestStorageRoot } = require('../storage/helpers/test-storage-root.js')
const roots = []
const children = new Set()
const exitedChildren = new WeakSet()
const closedChildren = new WeakSet()
const startedAtMs = Date.parse('2026-08-01T00:00:00.000Z')

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
  let exited = child.exitCode != null || child.signalCode != null || exitedChildren.has(child)
  let closed = closedChildren.has(child)
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
    resolve({ exitCode: child.exitCode, signalCode: child.signalCode })
  }
  const onExit = () => { exited = true; exitedChildren.add(child); finish() }
  const onClose = () => { closed = true; closedChildren.add(child); finish() }
  const onError = error => { cleanup(); reject(error) }
  child.on('exit', onExit)
  child.on('close', onClose)
  child.on('error', onError)
  if (exited && closed) { finish(); return }
  timer = setTimeout(() => { cleanup(); reject(new Error('child_exit_timeout')) }, timeoutMs)
})

const signalAndWait = async(child, signal, timeoutMs) => {
  const completed = awaitExitAndClose(child, timeoutMs)
  try {
    child.kill(signal)
  } catch (error) {
    completed.catch(() => {})
    throw error
  }
  return completed
}

const terminateChild = async(child, { gracefulTimeoutMs = 1_000, forcedTimeoutMs = 1_000 } = {}) => {
  if (exitedChildren.has(child) && closedChildren.has(child)) {
    return { exitCode: child.exitCode, signalCode: child.signalCode }
  }
  try {
    return await signalAndWait(child, 'SIGTERM', gracefulTimeoutMs)
  } catch {}
  try {
    return await signalAndWait(child, 'SIGKILL', forcedTimeoutMs)
  } catch {
    throw new Error('cleanup_child_timeout')
  }
}

const killAndWait = async(child, timeoutMs = 3_000) => {
  const result = await terminateChild(child, { gracefulTimeoutMs: timeoutMs, forcedTimeoutMs: timeoutMs })
  children.delete(child)
  return result
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
  child.once('exit', () => exitedChildren.add(child))
  child.once('close', () => closedChildren.add(child))
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
  child.send({ type: 'ack', version: 1, requestId: id, durableRequestId: durable.requestId, ack })
  const result = await pending
  assert.equal(result.durableRequestId, durable.requestId)
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
  const fixture = createTestStorageRoot('crash')
  roots.push(fixture)
  const root = fixture.path
  for (const child of ['profile', 'data', 'database']) fs.mkdirSync(path.join(root, child), { recursive: true })
  return root
}

const openStore = async root => {
  const dataPath = path.join(root, 'database')
  const result = await dbService.init({
    dataPath,
    cacheRoot: path.join(root, 'cache'),
    backupsRoot: path.join(root, 'backups'),
    previousShutdownWasClean: false,
    targetSchemaVersion: 6,
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

const terminationDouble = ({ exitOnSignal = null } = {}) => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.signals = []
  child.kill = signal => {
    const actual = signal ?? 'SIGTERM'
    child.signals.push(actual)
    if (actual == exitOnSignal) {
      queueMicrotask(() => {
        child.signalCode = actual
        child.emit('exit', null, actual)
        child.emit('close', null, actual)
      })
    }
    return true
  }
  return child
}

const cleanupCrashResources = async({
  activeChildren = children,
  cleanupRoots = roots,
  closeDatabase = () => dbService.close(),
  gracefulTimeoutMs = 1_000,
  forcedTimeoutMs = 1_000,
} = {}) => {
  for (const child of [...activeChildren]) {
    await terminateChild(child, { gracefulTimeoutMs, forcedTimeoutMs })
    activeChildren.delete(child)
  }
  await closeDatabase()
  for (const fixture of cleanupRoots) fixture.cleanup()
  cleanupRoots.splice(0)
}

afterEach(async() => {
  await cleanupCrashResources()
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

  it('requires a durable request correlation before accepting an acknowledgement', async() => {
    const root = createRoot()
    await openStore(root)
    const child = await spawnRecorder(root)
    const durable = await sendCommand(child, {
      type: 'start',
      playbackGroupUuid: group('10'),
      occurredAtMs: startedAtMs,
    })
    const ack = commitDurable(durable)
    const id = ++requestId
    const response = waitForMessage(child, message => message?.type == 'error' || message?.requestId == id)
    child.send({ type: 'ack', version: 1, requestId: id, ack })
    assert.deepEqual(await response, { type: 'error', version: 1, requestId: id, code: 'invalid_ack_message' })
  })

  it('rejects malformed acknowledgement payloads through production validation', async() => {
    const root = createRoot()
    await openStore(root)
    const child = await spawnRecorder(root)
    const durable = await sendCommand(child, {
      type: 'start',
      playbackGroupUuid: group('11'),
      occurredAtMs: startedAtMs,
    })
    const id = ++requestId
    const response = waitForMessage(child, message => message?.type == 'error')
    child.send({ type: 'ack', version: 1, requestId: id, durableRequestId: durable.requestId, ack: { mode: 'activity', ack: {} } })
    assert.deepEqual(await response, { type: 'error', version: 1, requestId: id, code: 'invalid_ack_payload' })
  })

  it('rejects a valid acknowledgement for the wrong playback group', async() => {
    const root = createRoot()
    await openStore(root)
    const child = await spawnRecorder(root)
    const durable = await sendCommand(child, {
      type: 'start',
      playbackGroupUuid: group('12'),
      occurredAtMs: startedAtMs,
    })
    const ack = commitDurable(durable)
    ack.ack.playbackGroupUuid = group('13')
    const id = ++requestId
    const response = waitForMessage(child, message => message?.type == 'error')
    child.send({ type: 'ack', version: 1, requestId: id, durableRequestId: durable.requestId, ack })
    assert.deepEqual(await response, { type: 'error', version: 1, requestId: id, code: 'ack_group_mismatch' })
  })

  it('rejects a valid acknowledgement for the wrong durable sequence', async() => {
    const root = createRoot()
    await openStore(root)
    const child = await spawnRecorder(root)
    const durable = await sendCommand(child, {
      type: 'start',
      playbackGroupUuid: group('14'),
      occurredAtMs: startedAtMs,
    })
    const ack = commitDurable(durable)
    ack.ack.checkpointSeq++
    const id = ++requestId
    const response = waitForMessage(child, message => message?.type == 'error')
    child.send({ type: 'ack', version: 1, requestId: id, durableRequestId: durable.requestId, ack })
    assert.deepEqual(await response, { type: 'error', version: 1, requestId: id, code: 'ack_sequence_mismatch' })
  })

  it('rejects stale and unrelated durable request correlation', async() => {
    const root = createRoot()
    await openStore(root)
    const child = await spawnRecorder(root)
    const durable = await sendCommand(child, {
      type: 'start',
      playbackGroupUuid: group('15'),
      occurredAtMs: startedAtMs,
    })
    const ack = commitDurable(durable)
    const retry = await sendCommand(child, { type: 'retry' })
    assert.equal(JSON.stringify(retry.command), JSON.stringify(durable.command))

    for (const durableRequestId of [durable.requestId, retry.requestId + 100]) {
      const id = ++requestId
      const response = waitForMessage(child, message => message?.type == 'error')
      child.send({ type: 'ack', version: 1, requestId: id, durableRequestId, ack })
      assert.deepEqual(await response, { type: 'error', version: 1, requestId: id, code: 'ack_durable_mismatch' })
    }
  })

  it('escalates a timed-out graceful termination and waits for forced exit and close', async() => {
    const child = terminationDouble({ exitOnSignal: 'SIGKILL' })
    await terminateChild(child, { gracefulTimeoutMs: 10, forcedTimeoutMs: 50 })
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  })

  it('preserves roots and surfaces cleanup failure while a child may still be alive', async() => {
    const fixture = createTestStorageRoot('cleanup-failure')
    const root = fixture.path
    const child = terminationDouble()
    let databaseClosed = false
    try {
      await assert.rejects(async() => cleanupCrashResources({
        activeChildren: new Set([child]),
        cleanupRoots: [fixture],
        closeDatabase: () => { databaseClosed = true },
        gracefulTimeoutMs: 10,
        forcedTimeoutMs: 10,
      }), /cleanup_child_timeout/)
      assert.equal(databaseClosed, false)
      assert.equal(fs.existsSync(root), true)
    } finally {
      fixture.cleanup()
    }
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
