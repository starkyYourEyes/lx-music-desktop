const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Storage tests require an explicit disposable base; never reuse application data.
const withTestEnvironment = run => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-test-run-'))
  const previous = process.env.LX_TEST_STORAGE_ROOT
  process.env.LX_TEST_STORAGE_ROOT = fixture
  let result = 1
  try {
    result = run()
    return result
  } finally {
    if (previous === undefined) delete process.env.LX_TEST_STORAGE_ROOT
    else process.env.LX_TEST_STORAGE_ROOT = previous
    if (result === 0) fs.rmSync(fixture, { recursive: true, force: true })
    else console.error(`Test fixtures retained: ${fixture}`)
  }
}

module.exports = { withTestEnvironment }
if (require.main === module) {
  const { spawnSync } = require('node:child_process')
  process.exitCode = withTestEnvironment(() => {
    const result = spawnSync(process.execPath, process.argv.slice(2), { stdio: 'inherit', windowsHide: true })
    if (result.error) console.error(result.error.message)
    return result.status ?? 1
  })
}
