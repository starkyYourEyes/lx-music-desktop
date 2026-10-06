const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const runTestScripts = ({
  directory = __dirname,
  executable = process.execPath,
  stdio = 'inherit',
  report = console.log,
} = {}) => {
  const scripts = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^test-.*\.js$/.test(entry.name))
    .map(entry => entry.name)
    .sort()
  if (!scripts.length) throw new Error(`No test scripts found in ${directory}`)
  const failed = []
  for (const name of scripts) {
    const result = spawnSync(executable, [path.join(directory, name)], { stdio, windowsHide: true })
    if (result.error || result.signal || result.status !== 0) {
      failed.push(name)
      report(`FAIL ${name}: ${result.error?.message || result.signal || `exit ${result.status}`}`)
    } else report(`PASS ${name}`)
  }
  report(`${scripts.length - failed.length}/${scripts.length} scripts passed`)
  if (failed.length) report(`Failed scripts:\n${failed.join('\n')}`)
  return failed.length ? 1 : 0
}

if (require.main === module) {
  const { withTestEnvironment } = require('./run-test-environment')
  try {
    process.exitCode = withTestEnvironment(runTestScripts)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}

module.exports = { runTestScripts }
