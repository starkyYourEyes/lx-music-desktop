const assert = require('node:assert')

const {
  normalizeLocalMusicDirs,
  normalizeLocalMusicWebDAVDir,
} = require('../src/common/utils/localMusicSettings')

assert.deepStrictEqual(normalizeLocalMusicDirs(undefined), [])
assert.deepStrictEqual(normalizeLocalMusicDirs(null), [])
assert.deepStrictEqual(normalizeLocalMusicDirs('D:/Music'), [])
assert.deepStrictEqual(normalizeLocalMusicDirs([' D:/Music ', '', '  E:/Songs  ']), ['D:/Music', 'E:/Songs'])

assert.strictEqual(normalizeLocalMusicWebDAVDir(undefined), 'local-music')
assert.strictEqual(normalizeLocalMusicWebDAVDir(null), 'local-music')
assert.strictEqual(normalizeLocalMusicWebDAVDir(''), 'local-music')
assert.strictEqual(normalizeLocalMusicWebDAVDir(' my-local '), 'my-local')

console.log('local music settings helper tests passed')
