const assert = require('node:assert')

const {
  normalizeWebDAVSubDir,
  createLocalMusicWebDAVFileName,
  createLocalMusicWebDAVPath,
} = require('../src/common/utils/localMusicWebdav')
const {
  normalizeWebDAVRootUrl,
  resolveWebDAVHref,
  createWebDAVFileUrl,
} = require('../src/common/utils/webdavUrl')

assert.strictEqual(normalizeWebDAVSubDir(' local-music\\\\demo// '), 'local-music/demo')
assert.strictEqual(normalizeWebDAVSubDir('/'), '')
assert.strictEqual(normalizeWebDAVSubDir('../escape'), 'escape')

assert.strictEqual(
  createLocalMusicWebDAVFileName({
    name: 'A:/Bad*Song?',
    singer: 'Singer<Name>',
    ext: 'mp3',
    filePath: 'D:/Music/A Bad Song.mp3',
  }),
  'SingerName - ABadSong [818f2d1c].mp3',
)

assert.strictEqual(
  createLocalMusicWebDAVPath({
    dir: 'local-music',
    name: 'Song',
    singer: '',
    ext: '.flac',
    filePath: 'D:/Music/Song.flac',
  }),
  'local-music/Song [9f89c0fa].flac',
)

const rootUrl = 'https://music.example/dav/library/'
assert.strictEqual(normalizeWebDAVRootUrl(rootUrl), rootUrl)
assert.deepStrictEqual(
  resolveWebDAVHref(rootUrl, `${rootUrl}album/`, 'song.mp3'),
  {
    url: `${rootUrl}album/song.mp3`,
    path: 'album/song.mp3',
  },
)
assert.deepStrictEqual(
  resolveWebDAVHref(rootUrl, rootUrl, 'A&amp;B.mp3'),
  {
    url: `${rootUrl}A&B.mp3`,
    path: 'A&B.mp3',
  },
)
assert.deepStrictEqual(
  resolveWebDAVHref(rootUrl, rootUrl, '&#x4E2D;&#25991;.mp3'),
  {
    url: `${rootUrl}%E4%B8%AD%E6%96%87.mp3`,
    path: '中文.mp3',
  },
)
assert.strictEqual(resolveWebDAVHref(rootUrl, rootUrl, 'https://attacker.example/song.mp3'), null)
assert.strictEqual(resolveWebDAVHref(rootUrl, rootUrl, 'https://music.example/dav/private/song.mp3'), null)
assert.strictEqual(resolveWebDAVHref(rootUrl, rootUrl, '&#46;&#46;/private/song.mp3'), null)
assert.strictEqual(createWebDAVFileUrl(rootUrl, 'album/A song.mp3'), `${rootUrl}album/A%20song.mp3`)
assert.throws(() => createWebDAVFileUrl(rootUrl, '../private/song.mp3'), /Invalid WebDAV file path/)
assert.throws(() => createWebDAVFileUrl(rootUrl, 'album/%2e%2e/song.mp3'), /Invalid WebDAV file path/)
assert.throws(() => normalizeWebDAVRootUrl('ftp://music.example/dav'), /HTTP or HTTPS/)

console.log('local music WebDAV helper tests passed')
