const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { execFile, execFileSync, spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const test = require('node:test')
const WebSocket = require('ws')
const { createTestStorageRoot } = require('./storage/helpers/test-storage-root.js')

const startupTimeoutMs = 45_000
const cleanupTimeoutMs = 10_000
const pollIntervalMs = 200
const processPollIntervalMs = 1_000
const outputTailLimit = 32 * 1024
const inspectorPattern = /Debugger listening on (ws:\/\/[^\s]+)/

const fixtureProcessScript = `$root = [IO.Path]::GetFullPath($env:LX_PORTABLE_FIXTURE_ROOT).TrimEnd('\\') + '\\'
Get-CimInstance Win32_Process |
  Where-Object {
    $_.ExecutablePath -and
    [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
      $root, [StringComparison]::OrdinalIgnoreCase)
  } |
  Select-Object ProcessId, ParentProcessId, ExecutablePath |
  ConvertTo-Json -Compress`

const normalizeFullPath = targetPath => path.resolve(targetPath).replace(/[\\/]+$/, '').toLowerCase()

const isPathInside = (rootPath, targetPath) => {
  const root = `${normalizeFullPath(rootPath)}${path.sep}`
  return normalizeFullPath(targetPath).startsWith(root)
}

const formatInventory = inventory => JSON.stringify(inventory.map(processInfo => ({
  processId: processInfo.processId,
  parentProcessId: processInfo.parentProcessId,
  executablePath: processInfo.executablePath,
})))

const enumerateFixtureProcesses = (fixturePath, timeoutMs) => new Promise((resolve, reject) => {
  execFile('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    fixtureProcessScript,
  ], {
    env: { ...process.env, LX_PORTABLE_FIXTURE_ROOT: fixturePath },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: Math.max(1, timeoutMs),
    windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error != null) {
      reject(new Error(`fixture process enumeration failed: ${error.message}; stderr: ${stderr.trim()}`))
      return
    }

    let parsed
    try {
      parsed = stdout.trim() == '' ? [] : JSON.parse(stdout)
    } catch (error) {
      reject(new Error(`fixture process inventory was not valid JSON: ${error.message}`))
      return
    }

    const entries = parsed == null ? [] : Array.isArray(parsed) ? parsed : [parsed]
    try {
      const inventory = entries.map(entry => {
        const processId = Number(entry.ProcessId)
        const parentProcessId = Number(entry.ParentProcessId)
        const executablePath = entry.ExecutablePath
        if (!Number.isInteger(processId) || processId <= 0 ||
          !Number.isInteger(parentProcessId) || parentProcessId < 0 ||
          typeof executablePath != 'string' || !path.isAbsolute(executablePath) ||
          !isPathInside(fixturePath, executablePath)) {
          throw new Error(`invalid fixture process identity: ${JSON.stringify(entry)}`)
        }
        return { processId, parentProcessId, executablePath }
      })
      resolve(inventory)
    } catch (error) {
      reject(error)
    }
  })
})

const createOutputTail = stream => {
  let output = Buffer.alloc(0)
  stream.on('data', chunk => {
    output = Buffer.concat([output, Buffer.from(chunk)])
    if (output.length > outputTailLimit) output = output.subarray(output.length - outputTailLimit)
  })
  return () => output.toString('utf8')
}

const formatLauncherOutput = (readStdout, readStderr) => [
  '',
  'launcher stdout (final 32 KiB):',
  readStdout(),
  'launcher stderr (final 32 KiB):',
  readStderr(),
].join('\n')

const formatLauncherOutputs = launchers => launchers.map(({ label, readStdout, readStderr }) => [
  '',
  `${label} launcher stdout (final 32 KiB):`,
  readStdout(),
  `${label} launcher stderr (final 32 KiB):`,
  readStderr(),
].join('\n')).join('\n')

const createInspectorEndpointCapture = streams => {
  const buffers = new Map(streams.map(stream => [stream, '']))
  for (const stream of streams) {
    stream.on('data', chunk => {
      const output = `${buffers.get(stream)}${Buffer.from(chunk).toString('utf8')}`
      buffers.set(stream, output.length > outputTailLimit ? output.slice(-outputTailLimit) : output)
    })
  }
  return () => {
    for (const output of buffers.values()) {
      const match = output.match(inspectorPattern)
      if (match != null) return match[1]
    }
  }
}

const assertForbiddenPathAbsent = targetPath => {
  try {
    fs.lstatSync(targetPath)
  } catch (error) {
    if (error.code == 'ENOENT') return
    throw error
  }
  assert.fail(`forbidden path exists: ${targetPath}`)
}

const observeLauncherSpawn = launcher => new Promise(resolve => {
  launcher.once('spawn', () => { resolve(null) })
  launcher.once('error', error => { resolve(error) })
})

const requiredPathIsReady = ({ targetPath, type }) => {
  let identity
  try {
    identity = fs.lstatSync(targetPath)
  } catch (error) {
    if (error.code == 'ENOENT') return false
    throw error
  }
  assert.equal(identity.isSymbolicLink(), false, `required path must not be a link: ${targetPath}`)
  assert.equal(
    type == 'file' ? identity.isFile() : identity.isDirectory(),
    true,
    `required path must be a ${type}: ${targetPath}`,
  )
  return true
}

const launcherIsAlive = launcher => launcher != null &&
  Number.isInteger(launcher.pid) && launcher.pid > 0 &&
  launcher.exitCode == null && launcher.signalCode == null

const enumerateListeningPorts = (processId, timeoutMs) => new Promise((resolve, reject) => {
  execFile('netstat.exe', ['-ano', '-p', 'TCP'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: Math.max(1, timeoutMs),
    windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error != null) {
      reject(new Error(`TCP listener enumeration failed: ${error.message}; stderr: ${stderr.trim()}`))
      return
    }
    const ports = new Set()
    for (const line of stdout.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 5 || fields[0].toUpperCase() != 'TCP' || Number(fields.at(-1)) != processId) continue
      const match = fields[1].match(/^127\.0\.0\.1:(\d+)$/)
      if (match != null) ports.add(Number(match[1]))
    }
    resolve([...ports])
  })
})

const fetchInspectorTarget = (port, timeoutMs) => new Promise(resolve => {
  let settled = false
  const settle = value => {
    if (settled) return
    settled = true
    resolve(value)
  }
  const request = http.get({
    hostname: '127.0.0.1',
    port,
    path: '/json/list',
    timeout: Math.max(1, timeoutMs),
  }, response => {
    let body = ''
    response.setEncoding('utf8')
    response.on('data', chunk => {
      body += chunk
      if (body.length > 1024 * 1024) request.destroy(new Error('inspector target response exceeded 1 MiB'))
    })
    response.on('end', () => {
      if (response.statusCode != 200) {
        settle()
        return
      }
      try {
        const targets = JSON.parse(body)
        const target = Array.isArray(targets)
          ? targets.find(entry => typeof entry?.webSocketDebuggerUrl == 'string')
          : undefined
        settle(target == null ? undefined : { ...target, port })
      } catch {
        settle()
      }
    })
  })
  request.on('timeout', () => { request.destroy() })
  request.on('error', () => { settle() })
})

const waitForInspectorEndpoint = async({ fixturePath, launcher, readEndpoint, label, formatOutput }) => {
  const deadline = Date.now() + startupTimeoutMs
  let nextProcessPollAt = 0
  let mainProcess
  let streamEndpoint
  while (Date.now() < deadline) {
    streamEndpoint ??= readEndpoint()
    if (!launcherIsAlive(launcher)) {
      assert.fail(`${label} launcher exited before publishing its inspector endpoint: ` +
        `${launcher.exitCode}/${launcher.signalCode}${formatOutput()}`)
    }
    if (Date.now() >= nextProcessPollAt) {
      const inventory = await enumerateFixtureProcesses(fixturePath, Math.max(1, deadline - Date.now()))
      mainProcess = inventory.find(processInfo => processInfo.parentProcessId == launcher.pid)
      if (mainProcess != null) {
        if (streamEndpoint != null) return { endpoint: streamEndpoint, mainProcess }
        const ports = await enumerateListeningPorts(mainProcess.processId, Math.max(1, deadline - Date.now()))
        for (const port of ports) {
          const target = await fetchInspectorTarget(port, Math.min(1_000, Math.max(1, deadline - Date.now())))
          if (target != null) {
            return { endpoint: target.webSocketDebuggerUrl, mainProcess, target }
          }
        }
      }
      nextProcessPollAt = Date.now() + processPollIntervalMs
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
  }
  assert.fail(`${label} inspector endpoint was not published within ${startupTimeoutMs} ms; ` +
    `last fixture-owned main process: ${JSON.stringify(mainProcess)}${formatOutput()}`)
}

const connectCdp = (endpoint, deadline) => new Promise((resolve, reject) => {
  const remainingMs = Math.max(1, deadline - Date.now())
  const socket = new WebSocket(endpoint, { handshakeTimeout: remainingMs })
  const timer = setTimeout(() => {
    socket.terminate()
    reject(new Error(`inspector connection deadline expired: ${endpoint}`))
  }, remainingMs)
  socket.once('open', () => {
    clearTimeout(timer)
    let nextRequestId = 1
    const pending = new Map()
    const eventWaiters = new Map()

    socket.on('message', data => {
      let message
      try {
        message = JSON.parse(Buffer.from(data).toString('utf8'))
      } catch (error) {
        for (const request of pending.values()) request.reject(error)
        pending.clear()
        return
      }
      if (!Number.isInteger(message.id)) {
        const waiters = eventWaiters.get(message.method)
        if (waiters == null) return
        eventWaiters.delete(message.method)
        for (const waiter of waiters) {
          clearTimeout(waiter.timer)
          waiter.resolve(message.params)
        }
        return
      }
      const request = pending.get(message.id)
      if (request == null) return
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error != null) request.reject(new Error(`${request.method} failed: ${JSON.stringify(message.error)}`))
      else request.resolve(message.result)
    })
    socket.on('close', () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer)
        request.reject(new Error('inspector socket closed before its reply'))
      }
      pending.clear()
      for (const waiters of eventWaiters.values()) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer)
          waiter.reject(new Error('inspector socket closed before its event'))
        }
      }
      eventWaiters.clear()
    })
    socket.on('error', error => {
      for (const request of pending.values()) {
        clearTimeout(request.timer)
        request.reject(error)
      }
      pending.clear()
      for (const waiters of eventWaiters.values()) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer)
          waiter.reject(error)
        }
      }
      eventWaiters.clear()
    })

    resolve({
      socket,
      send(method, params, commandDeadline) {
        return new Promise((_resolve, _reject) => {
          const id = nextRequestId++
          const commandRemainingMs = Math.max(1, commandDeadline - Date.now())
          const request = {
            method,
            resolve: _resolve,
            reject: _reject,
            timer: setTimeout(() => {
              pending.delete(id)
              _reject(new Error(`inspector command deadline expired: ${method}`))
            }, commandRemainingMs),
          }
          pending.set(id, request)
          socket.send(JSON.stringify({ id, method, params }), error => {
            if (error == null) return
            pending.delete(id)
            clearTimeout(request.timer)
            _reject(error)
          })
        })
      },
      waitForEvent(method, eventDeadline) {
        return new Promise((_resolve, _reject) => {
          const waiter = {
            resolve: _resolve,
            reject: _reject,
            timer: setTimeout(() => {
              const waiters = eventWaiters.get(method) ?? []
              const remaining = waiters.filter(candidate => candidate != waiter)
              if (remaining.length == 0) eventWaiters.delete(method)
              else eventWaiters.set(method, remaining)
              _reject(new Error(`inspector event deadline expired: ${method}`))
            }, Math.max(1, eventDeadline - Date.now())),
          }
          eventWaiters.set(method, [...(eventWaiters.get(method) ?? []), waiter])
        })
      },
    })
  })
  socket.once('error', error => {
    clearTimeout(timer)
    reject(error)
  })
})

const closeCdp = client => new Promise(resolve => {
  if (client == null || client.socket.readyState == WebSocket.CLOSED) {
    resolve()
    return
  }
  const timer = setTimeout(() => {
    client.socket.terminate()
    resolve()
  }, 1_000)
  client.socket.once('close', () => {
    clearTimeout(timer)
    resolve()
  })
  client.socket.close()
})

const evaluate = async(client, expression, deadline) => {
  const response = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  }, deadline)
  if (response.exceptionDetails != null) {
    throw new Error(`inspector evaluation failed: ${JSON.stringify(response.exceptionDetails)}`)
  }
  return response.result.value
}

const evaluateUntil = async({ client, expression, accept, label, formatOutput }) => {
  const deadline = Date.now() + startupTimeoutMs
  let lastValue
  while (Date.now() < deadline) {
    lastValue = await evaluate(client, expression, deadline)
    if (accept(lastValue)) return lastValue
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
  }
  assert.fail(`${label} condition was not met within ${startupTimeoutMs} ms; ` +
    `last value: ${JSON.stringify(lastValue)}${formatOutput()}`)
}

const waitForLauncherExit = async({ launcher, label, formatOutput }) => {
  const deadline = Date.now() + startupTimeoutMs
  while (Date.now() < deadline) {
    if (launcher.exitCode != null || launcher.signalCode != null) {
      return { exitCode: launcher.exitCode, signalCode: launcher.signalCode }
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
  }
  assert.fail(`${label} launcher did not exit within ${startupTimeoutMs} ms${formatOutput()}`)
}

const waitForPathAbsent = async({ targetPath, label, formatOutput }) => {
  const deadline = Date.now() + cleanupTimeoutMs
  while (Date.now() < deadline) {
    try {
      fs.lstatSync(targetPath)
    } catch (error) {
      if (error.code == 'ENOENT') return
      throw error
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
  }
  assert.fail(`${label} remained after ${cleanupTimeoutMs} ms: ${targetPath}${formatOutput()}`)
}

const assertRegularFile = (targetPath, message) => {
  const identity = fs.lstatSync(targetPath)
  assert.equal(identity.isSymbolicLink(), false, `${message} must not be a link: ${targetPath}`)
  assert.equal(identity.isFile(), true, `${message} must be a regular file: ${targetPath}`)
}

const assertPortableExtractionRoot = (rootPath, targetPath, message) => {
  const pluginRoot = path.dirname(targetPath)
  const pluginRelativePath = path.relative(rootPath, pluginRoot)
  assert.equal(path.basename(targetPath).toLowerCase(), 'app', `${message} must end in the NSIS app directory`)
  assert.notEqual(pluginRelativePath, '', `${message} plugin root must not equal TEMP`)
  assert.equal(path.dirname(pluginRelativePath), '.',
    `${message} plugin root must be a direct child of TEMP: ${pluginRoot}`)

  const relativePath = path.relative(rootPath, targetPath)
  assert.notEqual(relativePath, '', `${message} must not equal TEMP`)
  assert.equal(path.isAbsolute(relativePath), false, `${message} must be inside TEMP: ${targetPath}`)
  assert.equal(relativePath.split(path.sep).includes('..'), false, `${message} must be inside TEMP: ${targetPath}`)

  let currentPath = rootPath
  for (const segment of relativePath.split(path.sep)) {
    currentPath = path.join(currentPath, segment)
    const identity = fs.lstatSync(currentPath)
    assert.equal(identity.isSymbolicLink(), false, `${message} hierarchy must not contain links: ${currentPath}`)
    assert.equal(identity.isDirectory(), true, `${message} hierarchy must contain directories: ${currentPath}`)
  }
  assert.equal(isPathInside(fs.realpathSync(rootPath), fs.realpathSync(targetPath)), true,
    `${message} real path must remain inside TEMP`)
}

const waitForDefaultStartup = async({
  fixturePath,
  launcher,
  requiredPaths,
  readStdout,
  readStderr,
  launcherSpawn,
}) => {
  const spawnError = await launcherSpawn
  if (spawnError != null) {
    assert.fail(`portable launcher spawn failed: ${spawnError.message}${formatLauncherOutput(readStdout, readStderr)}`)
  }
  const deadline = Date.now() + startupTimeoutMs
  let inventory = []
  let nextProcessPollAt = 0
  while (Date.now() < deadline) {
    const output = formatLauncherOutput(readStdout, readStderr)
    if (!launcherIsAlive(launcher)) {
      assert.fail(`portable launcher exited before startup completed: ${launcher.exitCode}${output}`)
    }

    const pathsReady = requiredPaths.every(requiredPathIsReady)
    if (Date.now() >= nextProcessPollAt) {
      inventory = await enumerateFixtureProcesses(fixturePath, Math.max(1, deadline - Date.now()))
      nextProcessPollAt = Date.now() + processPollIntervalMs
      if (!launcherIsAlive(launcher)) {
        assert.fail(`portable launcher exited before startup completed: ${launcher.exitCode}${formatLauncherOutput(readStdout, readStderr)}`)
      }
    }
    if (pathsReady && inventory.length > 0) return
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
  }
  assert.fail(`portable startup did not publish required paths within ${startupTimeoutMs} ms${formatLauncherOutput(readStdout, readStderr)}`)
}

const processDepth = (processInfo, inventoryByPid) => {
  let depth = 0
  let parentProcessId = processInfo.parentProcessId
  const visited = new Set([processInfo.processId])
  while (inventoryByPid.has(parentProcessId) && !visited.has(parentProcessId)) {
    visited.add(parentProcessId)
    depth++
    parentProcessId = inventoryByPid.get(parentProcessId).parentProcessId
  }
  return depth
}

const cleanupFixture = async(fixture, launcherOrLaunchers, copiedArtifact, dependencies = {}) => {
  const {
    enumerateProcesses = enumerateFixtureProcesses,
    now = Date.now,
    wait = delay,
  } = dependencies
  const launchers = (Array.isArray(launcherOrLaunchers) ? launcherOrLaunchers : [launcherOrLaunchers])
    .filter(launcher => launcher != null)
  const deadline = now() + cleanupTimeoutMs
  let inventory = []
  let cleanupError

  try {
    while (now() < deadline) {
      inventory = await enumerateProcesses(fixture.path, Math.max(1, deadline - now()))
      if (inventory.length == 0 && launchers.every(launcher => !launcherIsAlive(launcher))) {
        fixture.cleanup()
        return
      }

      if (inventory.length > 0) {
        for (const launcher of launchers.filter(launcherIsAlive)) {
          const launcherProcess = inventory.find(processInfo => processInfo.processId == launcher.pid)
          if (launcherProcess == null ||
            normalizeFullPath(launcherProcess.executablePath) != normalizeFullPath(copiedArtifact)) {
            throw new Error(`launcher identity could not be proven for PID ${launcher.pid}`)
          }
        }
      }

      if (inventory.length > 0) {
        const inventoryByPid = new Map(inventory.map(processInfo => [processInfo.processId, processInfo]))
        const deepestFirst = [...inventory].sort((left, right) =>
          processDepth(right, inventoryByPid) - processDepth(left, inventoryByPid))
        for (const processInfo of deepestFirst) {
          const remainingMs = deadline - now()
          if (remainingMs <= 0) break
          try {
            execFileSync('taskkill.exe', ['/PID', String(processInfo.processId), '/F'], {
              stdio: 'ignore',
              timeout: remainingMs,
              windowsHide: true,
            })
          } catch {}
        }
      }

      if (now() < deadline) {
        await wait(Math.min(pollIntervalMs, Math.max(1, deadline - now())))
      }
    }
  } catch (error) {
    cleanupError = error
  }

  throw new Error([
    `fixture cleanup could not be proven; retained fixture: ${fixture.path}`,
    `fixture process inventory: ${formatInventory(inventory)}`,
    cleanupError == null ? null : `cleanup error: ${cleanupError.message}`,
  ].filter(Boolean).join('; '))
}

test('retains the fixture when CIM inventory is empty while the launcher remains alive', async() => {
  const fixturePath = path.join(__dirname, 'empty-inventory-fixture')
  let cleanupCalled = false
  let nowMs = 0
  let cleanupError

  try {
    await cleanupFixture({
      path: fixturePath,
      cleanup: () => { cleanupCalled = true },
    }, {
      pid: 1234,
      exitCode: null,
      signalCode: null,
    }, path.join(fixturePath, 'artifact.exe'), {
      enumerateProcesses: async() => [],
      now: () => nowMs,
      wait: async() => { nowMs = cleanupTimeoutMs },
    })
  } catch (error) {
    cleanupError = error
  }

  assert.equal(cleanupCalled, false, 'a live launcher fixture must not be deleted')
  assert.match(cleanupError?.message ?? '', new RegExp(
    `retained fixture: ${fixturePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*fixture process inventory: \\[\\]`,
  ))
})

test('retains the fixture when either of two live launchers lacks CIM identity', async() => {
  const fixturePath = path.join(__dirname, 'two-launcher-identity-fixture')
  const copiedArtifact = path.join(fixturePath, 'artifact.exe')
  let cleanupCalled = false
  let cleanupError

  try {
    await cleanupFixture({
      path: fixturePath,
      cleanup: () => { cleanupCalled = true },
    }, [
      { pid: 1234, exitCode: null, signalCode: null },
      { pid: 5678, exitCode: null, signalCode: null },
    ], copiedArtifact, {
      enumerateProcesses: async() => [{
        processId: 1234,
        parentProcessId: 1,
        executablePath: copiedArtifact,
      }],
    })
  } catch (error) {
    cleanupError = error
  }

  assert.equal(cleanupCalled, false, 'an incompletely proven two-launcher fixture must not be deleted')
  assert.match(cleanupError?.message ?? '', /retained fixture: .*launcher identity could not be proven for PID 5678/)
})

test('forbidden path check rejects a dangling junction', {
  skip: process.platform != 'win32' || process.env.LX_TEST_STORAGE_ROOT == null
    ? 'Windows and LX_TEST_STORAGE_ROOT required'
    : false,
}, t => {
  const fixture = createTestStorageRoot('packaged-bootstrap-forbidden-path')
  t.after(() => { fixture.cleanup() })
  const danglingTarget = path.join(fixture.path, 'missing-target')
  const danglingJunction = path.join(fixture.path, 'dangling-junction')
  fs.symlinkSync(danglingTarget, danglingJunction, 'junction')

  assert.throws(
    () => { assertForbiddenPathAbsent(danglingJunction) },
    /forbidden path exists/,
  )
})

test('failed spawn is reported before launcher liveness is checked', async() => {
  const missingExecutable = path.join(__dirname, 'missing-portable-artifact.exe')
  const launcher = spawn(missingExecutable, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const launcherSpawn = observeLauncherSpawn(launcher)
  const readStdout = createOutputTail(launcher.stdout)
  const readStderr = createOutputTail(launcher.stderr)

  await assert.rejects(waitForDefaultStartup({
    fixturePath: __dirname,
    launcher,
    launcherSpawn,
    requiredPaths: [],
    readStdout,
    readStderr,
  }), /portable launcher spawn failed: .*ENOENT/)
})

test('concurrent portable launches retain distinct extraction roots and the primary window', {
  skip: process.platform != 'win32' || process.env.LX_PORTABLE_ARTIFACT == null
    ? 'Windows portable artifact and LX_PORTABLE_ARTIFACT required'
    : false,
  timeout: 180_000,
}, async t => {
  const artifact = process.env.LX_PORTABLE_ARTIFACT
  assert.equal(typeof artifact, 'string', 'LX_PORTABLE_ARTIFACT is required')
  assert.equal(path.isAbsolute(artifact), true)
  assertRegularFile(artifact, 'source portable artifact')

  let primaryLauncher
  let secondaryLauncher
  let primaryCdp
  let secondaryCdp
  let readPrimaryStdout = () => ''
  let readPrimaryStderr = () => ''
  let readSecondaryStdout = () => ''
  let readSecondaryStderr = () => ''
  const fixture = createTestStorageRoot('packaged-bootstrap-concurrent')
  const launcherRoot = path.join(fixture.path, 'launcher')
  const copiedArtifact = path.join(launcherRoot, 'artifact.exe')
  const formatOutput = () => formatLauncherOutputs([
    { label: 'primary', readStdout: readPrimaryStdout, readStderr: readPrimaryStderr },
    { label: 'secondary', readStdout: readSecondaryStdout, readStderr: readSecondaryStderr },
  ])
  t.after(async() => {
    await Promise.all([closeCdp(primaryCdp), closeCdp(secondaryCdp)])
    try {
      await cleanupFixture(fixture, [primaryLauncher, secondaryLauncher], copiedArtifact)
    } catch (error) {
      error.message += formatOutput()
      throw error
    }
  })

  try {
    const hostRoot = path.join(fixture.path, 'host')
    const roaming = path.join(hostRoot, 'roaming')
    const local = path.join(hostRoot, 'local')
    const userProfile = path.join(hostRoot, 'user')
    const temp = path.join(hostRoot, 'temp')
    for (const directoryPath of [launcherRoot, roaming, local, userProfile, temp]) {
      fs.mkdirSync(directoryPath, { recursive: true })
    }
    fs.copyFileSync(artifact, copiedArtifact)

    const portableRoot = path.join(launcherRoot, 'portable')
    assertForbiddenPathAbsent(portableRoot)
    const userFacingArguments = []
    assert.deepEqual(userFacingArguments, [])
    const childEnv = {
      ...process.env,
      APPDATA: roaming,
      LOCALAPPDATA: local,
      USERPROFILE: userProfile,
      HOME: userProfile,
      HOMEDRIVE: path.parse(userProfile).root.slice(0, 2),
      HOMEPATH: userProfile.slice(path.parse(userProfile).root.length - 1),
      TEMP: temp,
      TMP: temp,
    }
    delete childEnv.PORTABLE_EXECUTABLE_DIR
    delete childEnv.ELECTRON_RUN_AS_NODE

    primaryLauncher = spawn(copiedArtifact, [...userFacingArguments, '--inspect=127.0.0.1:0'], {
      cwd: launcherRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const primaryLauncherSpawn = observeLauncherSpawn(primaryLauncher)
    readPrimaryStdout = createOutputTail(primaryLauncher.stdout)
    readPrimaryStderr = createOutputTail(primaryLauncher.stderr)
    const readPrimaryEndpoint = createInspectorEndpointCapture([
      primaryLauncher.stdout,
      primaryLauncher.stderr,
    ])
    const primarySpawnError = await primaryLauncherSpawn
    if (primarySpawnError != null) {
      assert.fail(`primary portable launcher spawn failed: ${primarySpawnError.message}`)
    }
    const primaryInspector = await waitForInspectorEndpoint({
      fixturePath: fixture.path,
      launcher: primaryLauncher,
      readEndpoint: readPrimaryEndpoint,
      label: 'primary',
      formatOutput,
    })
    primaryCdp = await connectCdp(primaryInspector.endpoint, Date.now() + startupTimeoutMs)
    await primaryCdp.send('Runtime.enable', {}, Date.now() + startupTimeoutMs)

    const secondInstanceCounterKey = '__lxPortableSecondInstanceCount'
    const primaryStateExpression = `(() => {
      const { BrowserWindow } = process.mainModule.require('electron')
      return {
        pid: process.pid,
        execPath: process.execPath,
        resourcesPath: process.resourcesPath,
        secondInstanceCount: globalThis[${JSON.stringify(secondInstanceCounterKey)}] ?? null,
        windows: BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).map(window => ({
          browserWindowId: window.id,
          webContentsId: window.webContents.id,
          webContentsDestroyed: window.webContents.isDestroyed(),
          loading: window.webContents.isLoading(),
          url: window.webContents.getURL(),
        })),
      }
    })()`
    const primaryState = await evaluateUntil({
      client: primaryCdp,
      expression: primaryStateExpression,
      accept: state => state.windows.length == 1 &&
        !state.windows[0].webContentsDestroyed &&
        !state.windows[0].loading &&
        state.windows[0].url.startsWith('file:'),
      label: 'primary loaded BrowserWindow',
      formatOutput,
    })
    assert.equal(primaryState.pid, primaryInspector.mainProcess.processId,
      `primary inspector target must belong to the CIM-proven fixture main PID${formatOutput()}`)
    const initiallyLoadedPrimaryWindow = primaryState.windows[0]
    const installedCount = await evaluate(primaryCdp, `(() => {
      const { app } = process.mainModule.require('electron')
      const key = ${JSON.stringify(secondInstanceCounterKey)}
      if (globalThis[key] == null) {
        globalThis[key] = 0
        app.on('second-instance', () => { globalThis[key]++ })
      }
      return globalThis[key]
    })()`, Date.now() + startupTimeoutMs)
    assert.equal(installedCount, 0, `second-instance counter must start at zero${formatOutput()}`)

    secondaryLauncher = spawn(copiedArtifact, [...userFacingArguments, '--inspect-brk=127.0.0.1:0'], {
      cwd: launcherRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const secondaryLauncherSpawn = observeLauncherSpawn(secondaryLauncher)
    readSecondaryStdout = createOutputTail(secondaryLauncher.stdout)
    readSecondaryStderr = createOutputTail(secondaryLauncher.stderr)
    const readSecondaryEndpoint = createInspectorEndpointCapture([
      secondaryLauncher.stdout,
      secondaryLauncher.stderr,
    ])
    const secondarySpawnError = await secondaryLauncherSpawn
    if (secondarySpawnError != null) {
      assert.fail(`secondary portable launcher spawn failed: ${secondarySpawnError.message}`)
    }
    const secondaryInspector = await waitForInspectorEndpoint({
      fixturePath: fixture.path,
      launcher: secondaryLauncher,
      readEndpoint: readSecondaryEndpoint,
      label: 'secondary',
      formatOutput,
    })
    secondaryCdp = await connectCdp(secondaryInspector.endpoint, Date.now() + startupTimeoutMs)
    await secondaryCdp.send('Runtime.enable', {}, Date.now() + startupTimeoutMs)
    await secondaryCdp.send('Debugger.enable', {}, Date.now() + startupTimeoutMs)
    const secondaryPaused = secondaryCdp.waitForEvent('Debugger.paused', Date.now() + startupTimeoutMs)
    await secondaryCdp.send('Runtime.runIfWaitingForDebugger', {}, Date.now() + startupTimeoutMs)
    await secondaryPaused
    const secondaryState = await evaluate(secondaryCdp, `({
      pid: process.pid,
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
    })`, Date.now() + startupTimeoutMs)
    assert.equal(secondaryState.pid, secondaryInspector.mainProcess.processId,
      `secondary inspector target must belong to the CIM-proven fixture main PID${formatOutput()}`)

    assert.notEqual(primaryState.pid, secondaryState.pid, `main process PIDs must differ${formatOutput()}`)
    const primaryExtractionRoot = path.dirname(primaryState.resourcesPath)
    const secondaryExtractionRoot = path.dirname(secondaryState.resourcesPath)
    assert.equal(path.dirname(primaryState.execPath), primaryExtractionRoot,
      `primary executable and resources must share an extraction root${formatOutput()}`)
    assert.equal(path.dirname(secondaryState.execPath), secondaryExtractionRoot,
      `secondary executable and resources must share an extraction root${formatOutput()}`)
    assertPortableExtractionRoot(temp, primaryExtractionRoot, 'primary extraction root')
    assertPortableExtractionRoot(temp, secondaryExtractionRoot, 'secondary extraction root')
    assert.notEqual(normalizeFullPath(primaryExtractionRoot), normalizeFullPath(secondaryExtractionRoot),
      `concurrent launches must use distinct extraction roots${formatOutput()}`)

    const primaryAsar = path.join(primaryState.resourcesPath, 'app.asar')
    const secondaryAsar = path.join(secondaryState.resourcesPath, 'app.asar')
    assertRegularFile(primaryState.execPath, 'primary process.execPath')
    assertRegularFile(primaryAsar, 'primary resources/app.asar')
    assertRegularFile(secondaryState.execPath, 'secondary process.execPath')
    assertRegularFile(secondaryAsar, 'secondary resources/app.asar')

    const coexistenceInventory = await enumerateFixtureProcesses(fixture.path, startupTimeoutMs)
    for (const [label, processId] of [
      ['primary launcher', primaryLauncher.pid],
      ['primary main', primaryState.pid],
      ['secondary launcher', secondaryLauncher.pid],
      ['secondary main', secondaryState.pid],
    ]) {
      assert.equal(coexistenceInventory.some(processInfo => processInfo.processId == processId), true,
        `${label} PID ${processId} must be fixture-owned while both children coexist; ` +
        `inventory: ${formatInventory(coexistenceInventory)}${formatOutput()}`)
    }

    const primaryBeforeSecondaryResume = await evaluateUntil({
      client: primaryCdp,
      expression: primaryStateExpression,
      accept: state => state.secondInstanceCount == 0 && state.windows.some(window =>
        window.browserWindowId == initiallyLoadedPrimaryWindow.browserWindowId &&
        window.webContentsId == initiallyLoadedPrimaryWindow.webContentsId &&
        !window.webContentsDestroyed &&
        !window.loading &&
        window.url.startsWith('file:')),
      label: 'primary BrowserWindow immediately before secondary resume',
      formatOutput,
    })
    const primaryWindow = primaryBeforeSecondaryResume.windows.find(window =>
      window.browserWindowId == initiallyLoadedPrimaryWindow.browserWindowId)

    await secondaryCdp.send('Debugger.resume', {}, Date.now() + startupTimeoutMs)
    const secondaryExit = await waitForLauncherExit({
      launcher: secondaryLauncher,
      label: 'secondary',
      formatOutput,
    })
    assert.equal(secondaryExit.exitCode, 0, `secondary launcher exit code${formatOutput()}`)
    assert.equal(secondaryExit.signalCode, null, `secondary launcher signal${formatOutput()}`)
    await waitForPathAbsent({
      targetPath: secondaryExtractionRoot,
      label: 'secondary extraction root',
      formatOutput,
    })

    const retainedPrimaryState = await evaluateUntil({
      client: primaryCdp,
      expression: primaryStateExpression,
      accept: state => state.secondInstanceCount == 1 && state.windows.some(window =>
        window.browserWindowId == primaryWindow.browserWindowId &&
        window.webContentsId == primaryWindow.webContentsId &&
        !window.webContentsDestroyed &&
        !window.loading &&
        window.url == primaryWindow.url),
      label: 'primary second-instance delivery and retained BrowserWindow',
      formatOutput,
    })
    assert.equal(retainedPrimaryState.secondInstanceCount, 1,
      `primary must receive exactly one second-instance event${formatOutput()}`)
    assert.equal(retainedPrimaryState.pid, primaryState.pid,
      `primary main PID must remain unchanged after secondary cleanup${formatOutput()}`)
    assert.equal(retainedPrimaryState.execPath, primaryState.execPath,
      `primary process.execPath must remain unchanged after secondary cleanup${formatOutput()}`)
    assert.equal(retainedPrimaryState.resourcesPath, primaryState.resourcesPath,
      `primary resourcesPath must remain unchanged after secondary cleanup${formatOutput()}`)
    const retainedWindow = retainedPrimaryState.windows.find(window =>
      window.browserWindowId == primaryWindow.browserWindowId)
    assert.notEqual(retainedWindow, undefined, `primary BrowserWindow must remain present${formatOutput()}`)
    assert.equal(retainedWindow.webContentsDestroyed, false,
      `primary webContents must remain non-destroyed${formatOutput()}`)
    assert.equal(retainedWindow.loading, false, `primary window must remain loaded${formatOutput()}`)
    assert.equal(retainedWindow.webContentsId, primaryWindow.webContentsId,
      `primary webContents id must remain unchanged${formatOutput()}`)
    assert.equal(retainedWindow.url, primaryWindow.url,
      `primary file URL must remain unchanged${formatOutput()}`)
    assert.equal(retainedWindow.url.startsWith('file:'), true,
      `primary retained URL must use file:${formatOutput()}`)

    assert.equal(launcherIsAlive(primaryLauncher), true, `primary launcher must remain alive${formatOutput()}`)
    const retainedInventory = await enumerateFixtureProcesses(fixture.path, startupTimeoutMs)
    for (const [label, processId] of [
      ['primary launcher', primaryLauncher.pid],
      ['primary main', primaryState.pid],
    ]) {
      assert.equal(retainedInventory.some(processInfo => processInfo.processId == processId), true,
        `${label} PID ${processId} must remain fixture-owned; ` +
        `inventory: ${formatInventory(retainedInventory)}${formatOutput()}`)
    }
    assertRegularFile(primaryState.execPath, 'primary process.execPath after secondary cleanup')
    assertRegularFile(primaryAsar, 'primary resources/app.asar after secondary cleanup')
  } catch (error) {
    error.message += formatOutput()
    throw error
  }
})

test('default NSIS portable launch reaches launcher-local storage without a user-data-dir override', {
  skip: process.platform != 'win32' || process.env.LX_PORTABLE_ARTIFACT == null
    ? 'Windows portable artifact and LX_PORTABLE_ARTIFACT required'
    : false,
  timeout: 90_000,
}, async t => {
  const artifact = process.env.LX_PORTABLE_ARTIFACT
  assert.equal(typeof artifact, 'string', 'LX_PORTABLE_ARTIFACT is required')
  assert.equal(path.isAbsolute(artifact), true)
  assert.equal(fs.lstatSync(artifact).isFile(), true)

  let launcher
  const fixture = createTestStorageRoot('packaged-bootstrap')
  t.after(async() => {
    await cleanupFixture(fixture, launcher, path.join(fixture.path, 'launcher', 'artifact.exe'))
  })

  const launcherRoot = path.join(fixture.path, 'launcher')
  const hostRoot = path.join(fixture.path, 'host')
  const roaming = path.join(hostRoot, 'roaming')
  const local = path.join(hostRoot, 'local')
  const userProfile = path.join(hostRoot, 'user')
  const temp = path.join(hostRoot, 'temp')
  for (const directoryPath of [launcherRoot, roaming, local, userProfile, temp]) {
    fs.mkdirSync(directoryPath, { recursive: true })
  }

  const copiedArtifact = path.join(launcherRoot, 'artifact.exe')
  fs.copyFileSync(artifact, copiedArtifact)
  const launcherArguments = []
  assert.deepEqual(launcherArguments, [])

  const childEnv = {
    ...process.env,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    USERPROFILE: userProfile,
    HOME: userProfile,
    HOMEDRIVE: path.parse(userProfile).root.slice(0, 2),
    HOMEPATH: userProfile.slice(path.parse(userProfile).root.length - 1),
    TEMP: temp,
    TMP: temp,
  }
  delete childEnv.PORTABLE_EXECUTABLE_DIR
  delete childEnv.ELECTRON_RUN_AS_NODE

  launcher = spawn(copiedArtifact, launcherArguments, {
    cwd: launcherRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const launcherSpawn = observeLauncherSpawn(launcher)
  const readStdout = createOutputTail(launcher.stdout)
  const readStderr = createOutputTail(launcher.stderr)

  const portableRoot = path.join(launcherRoot, 'portable')
  await waitForDefaultStartup({
    fixturePath: fixture.path,
    launcher,
    launcherSpawn,
    requiredPaths: [
      { targetPath: path.join(portableRoot, 'profile', 'lx.data.db'), type: 'file' },
      { targetPath: path.join(portableRoot, 'runtime', 'electron-user-data'), type: 'directory' },
      { targetPath: path.join(portableRoot, 'runtime', 'session-data'), type: 'directory' },
      { targetPath: path.join(portableRoot, 'runtime', 'run-state.v1.json'), type: 'file' },
      { targetPath: path.join(portableRoot, 'temp'), type: 'directory' },
    ],
    readStdout,
    readStderr,
  })

  assertForbiddenPathAbsent(path.join(roaming, 'starky-lx-music-desktop'))
  assertForbiddenPathAbsent(path.join(local, 'starky-lx-music-desktop'))
  assertForbiddenPathAbsent(path.join(portableRoot, 'backups'))
})
