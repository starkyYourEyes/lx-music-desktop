const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

const getStyle = source => {
  const match = source.match(/<style\b[^>]*>([\s\S]*?)<\/style>/)
  assert(match, 'Vue component should contain a style block')
  return match[1]
}

const skipString = (source, start) => {
  const quote = source[start]
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\') index++
    else if (source[index] === quote) return index
  }
  return source.length - 1
}

const skipComment = (source, start) => {
  if (source[start + 1] === '/') {
    const end = source.indexOf('\n', start + 2)
    return end === -1 ? source.length - 1 : end
  }
  if (source[start + 1] === '*') {
    const end = source.indexOf('*/', start + 2)
    return end === -1 ? source.length - 1 : end + 1
  }
  return start
}

const maskCommentsAndStrings = source => {
  const sanitized = source.split('')

  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    let end = index
    if (char === '"' || char === "'") end = skipString(source, index)
    else if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) end = skipComment(source, index)
    else continue

    sanitized.fill(' ', index, end + 1)
    index = end
  }

  return sanitized.join('')
}

const findClosingBrace = (source, openIndex) => {
  let depth = 1
  for (let index = openIndex + 1; index < source.length; index++) {
    const char = source[index]
    if (char === '"' || char === "'") index = skipString(source, index)
    else if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) index = skipComment(source, index)
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return index
  }
  assert.fail(`Unclosed rule starting at character ${openIndex}`)
}

const normalizeSelector = selector => selector
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\r\n]*/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const getRule = (source, selector) => {
  const expectedSelector = normalizeSelector(selector)
  let statementStart = 0

  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === '"' || char === "'") {
      index = skipString(source, index)
    } else if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipComment(source, index)
    } else if (char === ';') {
      statementStart = index + 1
    } else if (char === '{') {
      const ruleSelector = normalizeSelector(source.slice(statementStart, index))
      const closeIndex = findClosingBrace(source, index)
      if (ruleSelector === expectedSelector) return source.slice(index + 1, closeIndex)
      index = closeIndex
      statementStart = closeIndex + 1
    }
  }

  assert.fail(`Expected top-level rule ${selector}`)
}

const getDirectDeclarations = rule => {
  const declarations = []
  const sanitizedRule = maskCommentsAndStrings(rule)
  let statementStart = 0

  for (let index = 0; index < sanitizedRule.length; index++) {
    const char = sanitizedRule[index]
    if (char === ';') {
      declarations.push(sanitizedRule.slice(statementStart, index + 1))
      statementStart = index + 1
    } else if (char === '{') {
      const closeIndex = findClosingBrace(sanitizedRule, index)
      index = closeIndex
      statementStart = closeIndex + 1
    }
  }

  return declarations.join('\n')
}

const extractionFixture = `
.target h1 { width: 50%; }
.target {
  width: 100%;
  nested { width: 25%; }
}
`
const fixtureRule = getRule(extractionFixture, '.target')
const fixtureDeclarations = getDirectDeclarations(fixtureRule)
assert.match(fixtureDeclarations, /width:\s*100%;/, 'Rule extraction should retain direct declarations')
assert.doesNotMatch(fixtureDeclarations, /50%|25%/, 'Rule extraction should exclude descendant and nested declarations')

const commentDeclarations = getDirectDeclarations('/* width: 100%; */ color: red;')
assert.match(commentDeclarations, /color:\s*red;/, 'Declaration extraction should retain declarations after comments')
assert.doesNotMatch(commentDeclarations, /width:\s*100%;/, 'Comments should not satisfy declaration contracts')

const stringDeclarations = getDirectDeclarations(String.raw`content: "escaped quote: \"; width: 100%"; color: red;`)
assert.match(stringDeclarations, /color:\s*red;/, 'Declaration extraction should retain declarations after strings')
assert.doesNotMatch(stringDeclarations, /width:\s*100%/, 'Strings should not satisfy declaration contracts')

const turntable = read('src/renderer/components/layout/PlayDetail/Turntable.vue')
const playDetail = read('src/renderer/components/layout/PlayDetail/index.vue')
const lyricPlayer = read('src/renderer/components/layout/PlayDetail/LyricPlayer.vue')
const playBar = read('src/renderer/components/layout/PlayDetail/PlayBar.vue')

const turntableStyle = getStyle(turntable)
const playDetailStyle = getStyle(playDetail)
const playBarStyle = getStyle(playBar)

assert.match(
  turntable,
  /div\(:class="\[\$style\.tonearm,\s*\{\s*\[\$style\.tonearmPlaying\]:\s*isPlay\s*\}\]"/,
  'Tonearm should receive a playing class from isPlay',
)

const tonearm = getDirectDeclarations(getRule(turntableStyle, '.tonearm'))
assert.match(tonearm, /transform:\s*rotate\(4deg\);/, 'Tonearm should rest away from the record')
assert.match(tonearm, /transform-origin:\s*0\s+0;/, 'Tonearm should rotate around its pivot')
assert.match(
  tonearm,
  /transition:\s*transform\s+360ms\s+cubic-bezier\(\.2,\s*\.75,\s*\.25,\s*1\);/,
  'Tonearm movement should use the intended transition',
)

const tonearmPlaying = getDirectDeclarations(getRule(turntableStyle, '.tonearmPlaying'))
assert.match(
  tonearmPlaying,
  /transform:\s*rotate\(18deg\);/,
  'Playing tonearm should rotate onto the outer groove',
)

const reducedMotion = getRule(turntableStyle, '@media (prefers-reduced-motion: reduce)')
const reducedRecord = getDirectDeclarations(getRule(reducedMotion, '.record'))
const reducedTonearm = getDirectDeclarations(getRule(reducedMotion, '.tonearm'))
assert.match(reducedRecord, /animation:\s*none;/, 'Reduced motion should disable record animation')
assert.match(reducedTonearm, /transition:\s*none;/, 'Reduced motion should disable tonearm transition')

const trackHeaderRule = getRule(playDetailStyle, '.trackHeader')
const trackHeader = getDirectDeclarations(trackHeaderRule)
assert.match(trackHeader, /align-items:\s*center;/, 'Track information should be horizontally centered')
assert.match(trackHeader, /text-align:\s*center;/, 'Track information text should be centered')

const trackTitle = getDirectDeclarations(getRule(trackHeaderRule, 'h1'))
assert.match(trackTitle, /width:\s*100%;/, 'Centered track title should use the full header width')
assert.match(trackTitle, /overflow:\s*hidden;/, 'Track title should hide overflow')
assert.match(trackTitle, /text-overflow:\s*ellipsis;/, 'Track title should retain ellipsis truncation')
assert.match(trackTitle, /white-space:\s*nowrap;/, 'Track title should remain on one line')

const trackMetaRule = getRule(playDetailStyle, '.trackMeta')
const trackMeta = getDirectDeclarations(trackMetaRule)
assert.match(trackMeta, /width:\s*100%;/, 'Singer and album row should use the full width')
assert.match(trackMeta, /justify-content:\s*center;/, 'Singer and album row should be centered')

const trackMetaSpan = getDirectDeclarations(getRule(trackMetaRule, 'span'))
assert.match(trackMetaSpan, /min-width:\s*0;/, 'Track metadata should be allowed to shrink')
assert.match(trackMetaSpan, /overflow:\s*hidden;/, 'Track metadata should hide overflow')
assert.match(trackMetaSpan, /text-overflow:\s*ellipsis;/, 'Track metadata should retain ellipsis truncation')
assert.match(trackMetaSpan, /white-space:\s*nowrap;/, 'Track metadata should remain on one line')

assert.match(
  lyricPlayer,
  /textAlign:\s*appSetting\['playDetail\.style\.align'\]/,
  'Lyric alignment should remain controlled by the play detail setting',
)

const footer = getDirectDeclarations(getRule(playBarStyle, '.footer'))
assert.match(footer, /flex:\s*0\s+0\s+72px;/, 'Play detail footer should be 72px high')
assert.match(footer, /padding:\s*10px\s+28px\s+4px;/, 'Play detail footer should use compact padding')

const progressTrack = getDirectDeclarations(getRule(playBarStyle, '.progressTrack'))
assert.match(progressTrack, /height:\s*10px;/, 'Progress track should be 10px high')
assert.match(progressTrack, /padding-top:\s*4px;/, 'Progress track should use 4px top padding')

const partyBtn = getDirectDeclarations(getRule(playBarStyle, '.partyBtn'))
assert.match(partyBtn, /min-height:\s*30px;/, 'Party button should be 30px high')
assert.match(partyBtn, /padding:\s*6px\s+10px;/, 'Party button should use compact padding')

const playBtn = getDirectDeclarations(getRule(playBarStyle, '.playBtn'))
assert.match(playBtn, /width:\s*32px;/, 'Playback buttons should be 32px wide')
assert.match(playBtn, /height:\s*32px;/, 'Playback buttons should be 32px high')
assert.match(playBtn, /padding:\s*6px;/, 'Playback buttons should use compact padding')

const playBtnPrimary = getDirectDeclarations(getRule(playBarStyle, '.playBtnPrimary'))
assert.match(playBtnPrimary, /width:\s*42px;/, 'Primary play button should be 42px wide')
assert.match(playBtnPrimary, /height:\s*42px;/, 'Primary play button should be 42px high')
assert.match(playBtnPrimary, /padding:\s*11px;/, 'Primary play button should use compact padding')

const narrowPlayBar = getRule(playBarStyle, '@media (max-width: 900px)')
const narrowPlayBtn = getDirectDeclarations(getRule(narrowPlayBar, '.playBtn'))
const narrowPlayBtnPrimary = getDirectDeclarations(getRule(narrowPlayBar, '.playBtnPrimary'))
assert.match(narrowPlayBtn, /width:\s*30px;/, 'Narrow playback buttons should be 30px wide')
assert.match(narrowPlayBtn, /height:\s*30px;/, 'Narrow playback buttons should be 30px high')
assert.match(narrowPlayBtnPrimary, /width:\s*38px;/, 'Narrow primary play button should be 38px wide')
assert.match(narrowPlayBtnPrimary, /height:\s*38px;/, 'Narrow primary play button should be 38px high')

assert.match(playBar, /@click="playPrev\(\)"/, 'Previous control should remain available')
assert.match(playBar, /@click="togglePlay"/, 'Play and pause control should remain available')
assert.match(playBar, /xlink:href="#icon-pause"/, 'Pause state icon should remain available')
assert.match(playBar, /xlink:href="#icon-play"/, 'Play state icon should remain available')
assert.match(playBar, /@click="playNext\(\)"/, 'Next control should remain available')
assert.match(playBar, /isShowPlayQueue\s*=\s*!isShowPlayQueue/, 'Queue control should remain available')
assert.match(playBar, /<control-btns\s*\/>/, 'Additional player controls should remain available')
assert.match(playBar, /@click="party\.isShowModal\s*=\s*true"/, 'Party control should remain available')

console.log('play detail refinement tests passed')
