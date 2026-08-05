const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFile, execFileSync, spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const test = require('node:test')
const { createTestStorageRoot } = require('./storage/helpers/test-storage-root.js')

const startupTimeoutMs = 45_000
const cleanupTimeoutMs = 10_000
const pollIntervalMs = 200
const processPollIntervalMs = 1_000
const outputTailLimit = 32 * 1024

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

const waitForDefaultStartup = async({
  fixturePath,
  launcher,
  requiredPaths,
  readStdout,
  readStderr,
  readSpawnError,
}) => {
  const deadline = Date.now() + startupTimeoutMs
  let inventory = []
  let nextProcessPollAt = 0
  while (Date.now() < deadline) {
    const output = formatLauncherOutput(readStdout, readStderr)
    const spawnError = readSpawnError()
    if (spawnError != null) assert.fail(`portable launcher spawn failed: ${spawnError.message}${output}`)
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

const cleanupFixture = async(fixture, launcher, copiedArtifact) => {
  const deadline = Date.now() + cleanupTimeoutMs
  let inventory = []
  let cleanupError

  try {
    while (Date.now() < deadline) {
      inventory = await enumerateFixtureProcesses(fixture.path, Math.max(1, deadline - Date.now()))
      if (inventory.length == 0) {
        fixture.cleanup()
        return
      }

      if (launcherIsAlive(launcher)) {
        const launcherProcess = inventory.find(processInfo => processInfo.processId == launcher.pid)
        if (launcherProcess == null ||
          normalizeFullPath(launcherProcess.executablePath) != normalizeFullPath(copiedArtifact)) {
          throw new Error(`launcher identity could not be proven for PID ${launcher.pid}`)
        }
      }

      const inventoryByPid = new Map(inventory.map(processInfo => [processInfo.processId, processInfo]))
      const deepestFirst = [...inventory].sort((left, right) =>
        processDepth(right, inventoryByPid) - processDepth(left, inventoryByPid))
      for (const processInfo of deepestFirst) {
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) break
        try {
          execFileSync('taskkill.exe', ['/PID', String(processInfo.processId), '/F'], {
            stdio: 'ignore',
            timeout: remainingMs,
            windowsHide: true,
          })
        } catch {}
      }

      if (Date.now() < deadline) {
        await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
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
  const readStdout = createOutputTail(launcher.stdout)
  const readStderr = createOutputTail(launcher.stderr)
  let spawnError
  launcher.once('error', error => { spawnError = error })

  const portableRoot = path.join(launcherRoot, 'portable')
  await waitForDefaultStartup({
    fixturePath: fixture.path,
    launcher,
    requiredPaths: [
      { targetPath: path.join(portableRoot, 'profile', 'lx.data.db'), type: 'file' },
      { targetPath: path.join(portableRoot, 'runtime', 'electron-user-data'), type: 'directory' },
      { targetPath: path.join(portableRoot, 'runtime', 'session-data'), type: 'directory' },
      { targetPath: path.join(portableRoot, 'runtime', 'run-state.v1.json'), type: 'file' },
      { targetPath: path.join(portableRoot, 'temp'), type: 'directory' },
    ],
    readStdout,
    readStderr,
    readSpawnError: () => spawnError,
  })

  assert.equal(fs.existsSync(path.join(roaming, 'starky-lx-music-desktop')), false)
  assert.equal(fs.existsSync(path.join(local, 'starky-lx-music-desktop')), false)
  assert.equal(fs.existsSync(path.join(portableRoot, 'backups')), false)
})
