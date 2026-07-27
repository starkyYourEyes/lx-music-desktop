const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const asar = require('@electron/asar')

const archivePath = path.join(__dirname, '../build/win-unpacked/resources/app.asar')

const extractVerifiedFile = (filePath) => {
  const file = asar.extractFile(archivePath, filePath)
  const metadata = asar.statFile(archivePath, filePath)
  const hash = crypto.createHash('sha256').update(file).digest('hex')

  assert.equal(hash, metadata.integrity.hash, `${filePath} failed its ASAR integrity check`)
  return file
}

test('packaged application contains a valid manifest and main process bundle', () => {
  assert.equal(fs.existsSync(archivePath), true, 'packaged app.asar is missing')

  const manifest = JSON.parse(extractVerifiedFile('package.json').toString('utf8'))
  const mainBundle = extractVerifiedFile(manifest.main.replace(/^\.\//, '')).toString('utf8')

  assert.equal(manifest.name, 'lx-music-desktop')
  assert.doesNotMatch(mainBundle, /Worker__webpack_require__\.wc/)
})
