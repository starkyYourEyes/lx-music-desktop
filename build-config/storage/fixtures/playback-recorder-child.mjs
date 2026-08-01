import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const typescript = require('typescript')

// The fixture deliberately loads the production reducer through the same explicit
// TypeScript transpilation mechanism used by the storage tests.
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

const dirname = path.dirname(fileURLToPath(import.meta.url))
const reducerPath = path.resolve(dirname, '../../../src/renderer/core/playbackRecorder/reducer.ts')
const validationPath = path.resolve(dirname, '../../../src/common/storage/playbackValidation.ts')
const { createPlaybackRecorderState, reduce } = require(reducerPath)
const {
  parsePlaybackCheckpointAck,
  parsePlaybackResumeAck,
  parsePlaybackStartResult,
} = require(validationPath)
const allowedRoot = path.resolve(dirname, '../../../.superpowers/sdd/2026-07-29-playback-activity/tmp/task-11')

const isContained = candidate => {
  const relative = path.relative(allowedRoot, candidate)
  return relative != '' && !relative.startsWith(`..${path.sep}`) && relative != '..' && !path.isAbsolute(relative)
}

for (const name of ['TEMP', 'TMP', 'LX_PROFILE_ROOT', 'LX_DATA_ROOT', 'LX_DATABASE_ROOT']) {
  const value = process.env[name]
  if (typeof value != 'string' || !path.isAbsolute(value) || path.parse(value).root.toUpperCase() != 'D:\\' || !isContained(path.resolve(value))) {
    throw new Error('invalid_child_storage_root')
  }
}

const exactRecord = (value, keys) => {
  if (value == null || typeof value != 'object' || Array.isArray(value) || Object.getPrototypeOf(value) != Object.prototype) return null
  const actual = Reflect.ownKeys(value)
  if (actual.length != keys.length || actual.some(key => typeof key != 'string' || !keys.includes(key))) return null
  return value
}

const safeRequestId = value => Number.isSafeInteger(value) && value > 0
const send = value => {
  if (typeof process.send != 'function') throw new Error('ipc_unavailable')
  process.send(value)
}

let state = createPlaybackRecorderState()
let lastParentRequestId = 0
let lastDurable = null
let lastDurableBytes = null
let lastDurableRequestId = null

const durable = requestId => {
  const command = state.outbox[0]
  if (command == null) throw new Error('durable_command_missing')
  lastDurable = { type: 'durable', version: 1, requestId, command }
  lastDurableBytes = JSON.stringify(lastDurable.command)
  lastDurableRequestId = requestId
  send(lastDurable)
}

const start = (requestId, action) => {
  const input = exactRecord(action, ['type', 'playbackGroupUuid', 'occurredAtMs'])
  if (input == null || input.type != 'start' || typeof input.playbackGroupUuid != 'string' ||
    !Number.isSafeInteger(input.occurredAtMs) || input.occurredAtMs < 0) throw new Error('invalid_start_command')
  const request = {
    version: 1,
    playbackGroupUuid: input.playbackGroupUuid,
    track: { source: 'fixture', sourceTrackId: 'fixture-track', name: 'Fixture', singer: 'Fixture', durationMs: 120_000, playablePayload: null },
    context: { type: 'unknown', id: null },
    resume: { listId: null, indexHint: null },
    startReason: 'auto',
    startPositionMs: 0,
    occurredAtMs: input.occurredAtMs,
    consent: { recentAllowed: true, statsAllowed: true, privateMode: false },
  }
  state = reduce(state, { type: 'start-requested', request })
  state = reduce(state, {
    type: 'native-playing',
    monotonicMs: 0,
    positionMs: 0,
    playbackRate: 1,
    occurredAtMs: input.occurredAtMs,
  })
  durable(requestId)
}

const advanceCheckpoint = (requestId, action) => {
  const input = exactRecord(action, ['type', 'cumulativePlayedMs', 'occurredAtMs'])
  if (input == null || input.type != 'advance-checkpoint' || !Number.isSafeInteger(input.cumulativePlayedMs) ||
    input.cumulativePlayedMs < 0 || !Number.isSafeInteger(input.occurredAtMs) || input.occurredAtMs < 0) {
    throw new Error('invalid_checkpoint_command')
  }
  state = reduce(state, {
    type: 'periodic-checkpoint',
    monotonicMs: input.cumulativePlayedMs,
    positionMs: input.cumulativePlayedMs,
    occurredAtMs: input.occurredAtMs,
  })
  durable(requestId)
}

const advanceOnly = (requestId, action) => {
  const input = exactRecord(action, ['type', 'cumulativePlayedMs'])
  if (input == null || input.type != 'advance-only' || !Number.isSafeInteger(input.cumulativePlayedMs) || input.cumulativePlayedMs < 0) {
    throw new Error('invalid_advance_command')
  }
  state = reduce(state, {
    type: 'sample',
    monotonicMs: input.cumulativePlayedMs,
    positionMs: input.cumulativePlayedMs,
  })
  send({
    type: 'ack',
    version: 1,
    requestId,
    checkpointSeq: state.checkpointSeq,
    cumulativePlayedMs: state.cumulativePlayedMs,
  })
}

const retry = (requestId, action) => {
  const input = exactRecord(action, ['type'])
  if (input == null || input.type != 'retry' || lastDurable == null || lastDurableBytes == null) throw new Error('invalid_retry_command')
  if (JSON.stringify(lastDurable.command) != lastDurableBytes) throw new Error('durable_request_changed')
  lastDurable = { ...lastDurable, requestId }
  lastDurableRequestId = requestId
  send(lastDurable)
}

const acknowledge = message => {
  const input = exactRecord(message, ['type', 'version', 'requestId', 'durableRequestId', 'ack'])
  if (input == null || input.type != 'ack' || input.version !== 1 || !safeRequestId(input.requestId) ||
    !safeRequestId(input.durableRequestId)) throw new Error('invalid_ack_message')
  if (input.requestId <= lastParentRequestId) throw new Error('invalid_ack_message')
  lastParentRequestId = input.requestId
  if (input.durableRequestId != lastDurableRequestId) throw new Error('ack_durable_mismatch')
  const command = state.outbox[0]
  if (command == null || lastDurable == null || command !== lastDurable.command) throw new Error('unexpected_ack')
  try {
    switch (command.kind) {
      case 'start': {
        const result = parsePlaybackStartResult(input.ack)
        if (result.mode != 'activity') throw new Error('ack_kind_mismatch')
        if (result.ack.playbackGroupUuid != command.request.playbackGroupUuid) throw new Error('ack_group_mismatch')
        if (result.ack.checkpointSeq != 1) throw new Error('ack_sequence_mismatch')
        state = reduce(state, { type: 'start-result', result })
        break
      }
      case 'commit': {
        const ack = parsePlaybackCheckpointAck(input.ack)
        if (ack.playbackGroupUuid != command.request.checkpoint.playbackGroupUuid) throw new Error('ack_group_mismatch')
        if (ack.checkpointSeq != command.request.checkpoint.checkpointSeq) throw new Error('ack_sequence_mismatch')
        state = reduce(state, { type: 'acknowledged', ack })
        break
      }
      case 'resume': {
        const ack = parsePlaybackResumeAck(input.ack)
        if (ack.playbackGroupUuid != command.request.playbackGroupUuid) throw new Error('ack_group_mismatch')
        if (ack.checkpointSeq != command.request.checkpointSeq) throw new Error('ack_sequence_mismatch')
        state = reduce(state, { type: 'acknowledged', ack })
        break
      }
      case 'preplay_failure': {
        const ack = parsePlaybackCheckpointAck(input.ack)
        if (ack.playbackGroupUuid != command.request.playbackGroupUuid) throw new Error('ack_group_mismatch')
        if (ack.checkpointSeq != 1) throw new Error('ack_sequence_mismatch')
        state = reduce(state, { type: 'acknowledged', ack })
        break
      }
    }
  } catch (error) {
    if (error instanceof Error && /^ack_[a-z0-9_]+$/.test(error.message)) throw error
    throw new Error('invalid_ack_payload')
  }
  send({
    type: 'ack',
    version: 1,
    requestId: input.requestId,
    durableRequestId: input.durableRequestId,
    checkpointSeq: state.checkpointSeq,
  })
}

process.on('message', message => {
  let requestId = 0
  try {
    if (message != null && typeof message == 'object' && message.type == 'ack') {
      if (safeRequestId(message.requestId)) requestId = message.requestId
      acknowledge(message)
      return
    }
    const input = exactRecord(message, ['type', 'version', 'requestId', 'action'])
    if (input == null || input.type != 'command' || input.version !== 1 || !safeRequestId(input.requestId) ||
      input.requestId <= lastParentRequestId || !exactRecord(input.action, Object.keys(input.action ?? {}))) {
      throw new Error('invalid_command_message')
    }
    requestId = input.requestId
    lastParentRequestId = input.requestId
    switch (input.action.type) {
      case 'start': start(requestId, input.action); break
      case 'advance-checkpoint': advanceCheckpoint(requestId, input.action); break
      case 'advance-only': advanceOnly(requestId, input.action); break
      case 'retry': retry(requestId, input.action); break
      default: throw new Error('invalid_command_action')
    }
  } catch (error) {
    send({
      type: 'error',
      version: 1,
      requestId,
      code: error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'child_command_failed',
    })
  }
})

if (process.env.LX_PLAYBACK_CHILD_SUPPRESS_READY != '1') {
  send({ type: 'ready', version: 1 })
}
