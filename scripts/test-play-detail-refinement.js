const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

const turntable = read('src/renderer/components/layout/PlayDetail/Turntable.vue')
const playDetail = read('src/renderer/components/layout/PlayDetail/index.vue')
const playBar = read('src/renderer/components/layout/PlayDetail/PlayBar.vue')

assert(
  /\$style\.tonearmPlaying\]:\s*isPlay/.test(turntable),
  'Tonearm should receive a playing class from isPlay',
)
assert(
  /\.tonearmPlaying\s*\{[^}]*transform:\s*rotate\(18deg\)/s.test(turntable),
  'Playing tonearm should rotate onto the outer groove',
)
assert(
  /\.trackHeader\s*\{[^}]*align-items:\s*center;[^}]*text-align:\s*center;/s.test(playDetail),
  'Track title and metadata container should be centered',
)
assert(
  /\.trackHeader\s*\{(?:(?!\n\}).)*?h1\s*\{[^}]*width:\s*100%;/s.test(playDetail),
  'Centered track title should remain constrained to the full header width',
)
assert(
  /\.trackMeta\s*\{[^}]*width:\s*100%;[^}]*justify-content:\s*center;/s.test(playDetail),
  'Singer and album row should be centered',
)
assert(
  /\.footer\s*\{[^}]*flex:\s*0\s+0\s+72px;/s.test(playBar),
  'Play detail footer should be 72px high',
)
assert(
  /\.playBtnPrimary\s*\{[^}]*width:\s*42px;[^}]*height:\s*42px;/s.test(playBar),
  'Primary play button should be 42px square',
)

console.log('play detail refinement tests passed')
