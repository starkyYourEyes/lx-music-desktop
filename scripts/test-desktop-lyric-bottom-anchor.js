const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const horizontalLyric = fs.readFileSync(
  path.join(root, 'src/renderer-lyric/components/layout/LyricHorizontal/useLyric.js'),
  'utf8',
)

assert(
  /const\s+getAutoHeightBounds\s*=\s*\(\s*windowWidth\s*,\s*windowHeight\s*,\s*targetHeight\s*\)/.test(horizontalLyric),
  'Horizontal desktop lyric should centralize automatic height bounds calculation',
)

assert(
  /y:\s*windowHeight\s*-\s*targetHeight/.test(horizontalLyric),
  'Automatic desktop lyric height changes should keep the bottom edge anchored',
)

assert(
  /setWindowBounds\(\s*getAutoHeightBounds\(\s*window\.innerWidth\s*,\s*window\.innerHeight\s*,\s*targetHeight\s*\)\s*\)/s.test(horizontalLyric),
  'Horizontal desktop lyric should use bottom-anchored bounds when syncing height',
)

console.log('desktop lyric bottom anchor tests passed')
