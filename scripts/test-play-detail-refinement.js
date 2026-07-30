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
  const declarations = new Map()
  const sanitizedRule = maskCommentsAndStrings(rule)
  let statementStart = 0

  for (let index = 0; index < sanitizedRule.length; index++) {
    const char = sanitizedRule[index]
    if (char === ';') {
      const statement = sanitizedRule.slice(statementStart, index).trim()
      const separatorIndex = statement.indexOf(':')
      if (separatorIndex !== -1) {
        const property = statement.slice(0, separatorIndex).trim()
        const value = statement.slice(separatorIndex + 1).replace(/\s+/g, ' ').trim()
        declarations.set(property, value)
      }
      statementStart = index + 1
    } else if (char === '{') {
      const closeIndex = findClosingBrace(sanitizedRule, index)
      index = closeIndex
      statementStart = closeIndex + 1
    }
  }

  return declarations
}

const hasDeclaration = (declarations, property, value) => declarations.get(property) === value
const expectDeclaration = (declarations, property, value, message) => {
  assert.strictEqual(declarations.get(property), value, message)
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
expectDeclaration(fixtureDeclarations, 'width', '100%', 'Rule extraction should retain direct declarations')
assert.strictEqual(fixtureDeclarations.size, 1, 'Rule extraction should exclude descendant and nested declarations')

const commentDeclarations = getDirectDeclarations('/* width: 100%; */ color: red;')
expectDeclaration(commentDeclarations, 'color', 'red', 'Declaration extraction should retain declarations after comments')
assert(!commentDeclarations.has('width'), 'Comments should not satisfy declaration contracts')

const stringDeclarations = getDirectDeclarations(String.raw`content: "escaped quote: \"; width: 100%"; color: red;`)
expectDeclaration(stringDeclarations, 'color', 'red', 'Declaration extraction should retain declarations after strings')
assert(!stringDeclarations.has('width'), 'Strings should not satisfy declaration contracts')

const prefixedSizeDeclarations = getDirectDeclarations('min-width: 100%; min-height: 42px;')
assert(!hasDeclaration(prefixedSizeDeclarations, 'width', '100%'), 'min-width should not satisfy a width contract')
assert(!hasDeclaration(prefixedSizeDeclarations, 'height', '42px'), 'min-height should not satisfy a height contract')

const exactSizeDeclarations = getDirectDeclarations('width: 100%; height: 42px;')
assert(hasDeclaration(exactSizeDeclarations, 'width', '100%'), 'Exact width declarations should satisfy width contracts')
assert(hasDeclaration(exactSizeDeclarations, 'height', '42px'), 'Exact height declarations should satisfy height contracts')

const turntable = read('src/renderer/components/layout/PlayDetail/Turntable.vue')
const playDetail = read('src/renderer/components/layout/PlayDetail/index.vue')
const lyricPlayer = read('src/renderer/components/layout/PlayDetail/LyricPlayer.vue')
const playBar = read('src/renderer/components/layout/PlayDetail/PlayBar.vue')

const turntableStyle = getStyle(turntable)
const playDetailStyle = getStyle(playDetail)
const playBarStyle = getStyle(playBar)

const label = getDirectDeclarations(getRule(turntableStyle, '.label'))
expectDeclaration(label, 'inset', '19%', 'Record center label should use the approved 62 percent diameter')

assert.match(
  turntable,
  /div\(:class="\[\$style\.tonearm,\s*\{\s*\[\$style\.tonearmPlaying\]:\s*isPlay\s*\}\]"/,
  'Tonearm should receive a playing class from isPlay',
)

const tonearm = getDirectDeclarations(getRule(turntableStyle, '.tonearm'))
expectDeclaration(tonearm, 'transform', 'rotate(4deg)', 'Tonearm should rest away from the record')
expectDeclaration(tonearm, 'transform-origin', '0 0', 'Tonearm should rotate around its pivot')
expectDeclaration(
  tonearm,
  'transition',
  'transform 360ms cubic-bezier(.2, .75, .25, 1)',
  'Tonearm movement should use the intended transition',
)

const tonearmPlaying = getDirectDeclarations(getRule(turntableStyle, '.tonearmPlaying'))
expectDeclaration(
  tonearmPlaying,
  'transform',
  'rotate(40deg)',
  'Playing tonearm should rotate onto the outer groove',
)

const arm = getDirectDeclarations(getRule(turntableStyle, '.arm'))
expectDeclaration(
  arm,
  'height',
  '7px',
  'Tonearm shaft should be a single straight bar',
)
expectDeclaration(
  arm,
  'background',
  'currentColor',
  'Tonearm shaft should be drawn as a solid bar',
)
expectDeclaration(
  arm,
  'transform',
  'rotate(17deg)',
  'Tonearm shaft should run directly from the pivot to the cartridge',
)
expectDeclaration(
  arm,
  'transform-origin',
  'left center',
  'Tonearm shaft should begin at the pivot center',
)
assert(!arm.has('border-left'), 'Tonearm shaft should not use a bent left border')
assert(!arm.has('border-right'), 'Tonearm shaft should not use a bent right border')
assert(!arm.has('border-bottom'), 'Tonearm shaft should not use a bent bottom border')

const reducedMotion = getRule(turntableStyle, '@media (prefers-reduced-motion: reduce)')
const reducedRecord = getDirectDeclarations(getRule(reducedMotion, '.record'))
const reducedTonearm = getDirectDeclarations(getRule(reducedMotion, '.tonearm'))
expectDeclaration(reducedRecord, 'animation', 'none', 'Reduced motion should disable record animation')
expectDeclaration(reducedTonearm, 'transition', 'none', 'Reduced motion should disable tonearm transition')

const trackHeaderRule = getRule(playDetailStyle, '.trackHeader')
const trackHeader = getDirectDeclarations(trackHeaderRule)
expectDeclaration(trackHeader, 'align-items', 'center', 'Track information should be horizontally centered')
expectDeclaration(trackHeader, 'text-align', 'center', 'Track information text should be centered')

const trackTitle = getDirectDeclarations(getRule(trackHeaderRule, 'h1'))
expectDeclaration(trackTitle, 'width', '100%', 'Centered track title should use the full header width')
expectDeclaration(trackTitle, 'overflow', 'hidden', 'Track title should hide overflow')
expectDeclaration(trackTitle, 'text-overflow', 'ellipsis', 'Track title should retain ellipsis truncation')
expectDeclaration(trackTitle, 'white-space', 'nowrap', 'Track title should remain on one line')

const trackMetaRule = getRule(playDetailStyle, '.trackMeta')
const trackMeta = getDirectDeclarations(trackMetaRule)
expectDeclaration(trackMeta, 'width', '100%', 'Singer and album row should use the full width')
expectDeclaration(trackMeta, 'justify-content', 'center', 'Singer and album row should be centered')

const trackMetaSpan = getDirectDeclarations(getRule(trackMetaRule, 'span'))
expectDeclaration(trackMetaSpan, 'min-width', '0', 'Track metadata should be allowed to shrink')
expectDeclaration(trackMetaSpan, 'overflow', 'hidden', 'Track metadata should hide overflow')
expectDeclaration(trackMetaSpan, 'text-overflow', 'ellipsis', 'Track metadata should retain ellipsis truncation')
expectDeclaration(trackMetaSpan, 'white-space', 'nowrap', 'Track metadata should remain on one line')

assert.match(
  lyricPlayer,
  /textAlign:\s*appSetting\['playDetail\.style\.align'\]/,
  'Lyric alignment should remain controlled by the play detail setting',
)

const footer = getDirectDeclarations(getRule(playBarStyle, '.footer'))
expectDeclaration(footer, 'flex', '0 0 72px', 'Play detail footer should be 72px high')
expectDeclaration(footer, 'padding', '10px 28px 4px', 'Play detail footer should use compact padding')

const progressTrack = getDirectDeclarations(getRule(playBarStyle, '.progressTrack'))
expectDeclaration(progressTrack, 'height', '10px', 'Progress track should be 10px high')
expectDeclaration(progressTrack, 'padding-top', '4px', 'Progress track should use 4px top padding')

assert.match(
  playBar,
  /import\s+PlayerControlBtns\s+from\s+['"]\.\.\/PlayBar\/ControlBtns\.vue['"]/,
  'Play bar should import the compact player controls',
)
const footerLeftTemplate = playBar.match(/<div\b(?=[^>]*:class="\$style\.footerLeft")[^>]*>([\s\S]*?)<\/div>\s*<div\b(?=[^>]*:class="\$style\.footerCenter")[^>]*>/)
assert(footerLeftTemplate, 'Play bar should contain a footerLeft template block before footerCenter')
const footerLeftBlock = footerLeftTemplate[1]
assert.match(footerLeftBlock, /\{\{\s*musicInfo\.name\s*\|\|\s*'LX Music'\s*\}\}/, 'Footer metadata should render the track name fallback')
assert.match(footerLeftBlock, /\{\{\s*musicInfo\.singer\s*\|\|\s*statusText\s*\}\}/, 'Footer metadata should render the singer or status fallback')
const favoriteControls = footerLeftBlock.match(/<player-control-btns\b[\s\S]*?\/>/)
assert(favoriteControls, 'Footer metadata should contain compact player controls')
assert.match(favoriteControls[0], /(?:^|\s)show-favorite(?=\s|\/?>)/, 'Footer player controls should show favorite')
assert.match(favoriteControls[0], /:show-add-to\s*=\s*['"]false['"]/, 'Footer player controls should hide add-to')
assert.match(favoriteControls[0], /:show-lyric\s*=\s*['"]false['"]/, 'Footer player controls should hide lyric')
assert.match(favoriteControls[0], /:show-volume\s*=\s*['"]false['"]/, 'Footer player controls should hide volume')
assert.match(favoriteControls[0], /:show-play-mode\s*=\s*['"]false['"]/, 'Footer player controls should hide play mode')
assert.match(favoriteControls[0], /(?:^|\s)compact(?=\s|\/?>)/, 'Footer player controls should use compact layout')
assert(!/\$style\.(?:status|time)\b/.test(playBar), 'Play bar should not retain separate status or time bindings')

const footerLeft = getDirectDeclarations(getRule(playBarStyle, '.footerLeft'))
expectDeclaration(footerLeft, 'flex-direction', 'row', 'Footer metadata should use a horizontal layout')
expectDeclaration(footerLeft, 'align-items', 'center', 'Footer metadata should be vertically centered')

const trackInfo = getDirectDeclarations(getRule(playBarStyle, '.trackInfo'))
expectDeclaration(trackInfo, 'min-width', '0', 'Track information should be allowed to shrink')
expectDeclaration(trackInfo, 'overflow', 'hidden', 'Track information should hide overflow')

assert.match(
  playBar,
  /const\s+progressPosition\s*=\s*computed\(\s*\(\s*\)\s*=>\s*`\$\{\s*Math\.min\(\s*Math\.max\(\s*progress\.value\s*\|\|\s*0\s*,\s*0\s*\)\s*,\s*1\s*\)\s*\*\s*100\s*\}%`\s*\)/,
  'Progress position should clamp progress.value to 0 through 1 and format it as a percentage',
)
const progressTrackTemplate = playBar.match(/<div\b(?=[^>]*:class="\$style\.progressTrack")(?=[^>]*:style="\{\s*'--progress-position'\s*:\s*progressPosition\s*\}")[^>]*>([\s\S]*?)<\/div>\s*<div\b(?=[^>]*:class="\$style\.footerLeft")[^>]*>/)
assert(progressTrackTemplate, 'Progress track should bind its CSS position before the footer metadata block')
const progressTrackBlock = progressTrackTemplate[1]
assert.match(progressTrackBlock, /:class="\$style\.progressMarker"/, 'Progress track should render its marker')
const progressTooltipElement = progressTrackBlock.match(
  /<span\b(?=[^>]*:class="\$style\.progressTooltip")[^>]*>\s*\{\{\s*nowPlayTimeStr\s*\}\}\s*\/\s*\{\{\s*maxPlayTimeStr\s*\}\}\s*<\/span>/,
)
assert(progressTooltipElement, 'Progress tooltip should contain current and total time')
assert.match(progressTooltipElement[0], /(?:^|\s)aria-hidden\s*=\s*["']true["'](?=\s|\/?>)/, 'Progress tooltip should remain hidden from assistive technology')
const accessibleProgressTime = progressTrackBlock.match(
  /<span\b(?=[^>]*:class="\$style\.progressTime")[^>]*>\s*\{\{\s*nowPlayTimeStr\s*\}\}\s*\/\s*\{\{\s*maxPlayTimeStr\s*\}\}\s*<\/span>/,
)
assert(accessibleProgressTime, 'Progress track should expose current and total time to assistive technology')
assert.doesNotMatch(accessibleProgressTime[0], /(?:^|\s)aria-hidden(?=\s|=|\/?>)/, 'Accessible progress time should not be hidden from assistive technology')
assert.doesNotMatch(accessibleProgressTime[0], /(?:^|\s)aria-live(?=\s|=|\/?>)/, 'Accessible progress time should not announce every playback update')

const progressMarker = getDirectDeclarations(getRule(playBarStyle, '.progressMarker'))
expectDeclaration(
  progressMarker,
  'left',
  'clamp(4px, var(--progress-position), calc(100% - 4px))',
  'Progress marker should stay fully visible at the zero and completion endpoints',
)
expectDeclaration(progressMarker, 'pointer-events', 'none', 'Progress marker should not intercept pointer input')

const progressTooltip = getDirectDeclarations(getRule(playBarStyle, '.progressTooltip'))
expectDeclaration(progressTooltip, 'left', 'clamp(50px, var(--progress-position), calc(100% - 50px))', 'Progress tooltip should remain within the track')
expectDeclaration(progressTooltip, 'opacity', '0', 'Progress tooltip should start hidden')
expectDeclaration(progressTooltip, 'pointer-events', 'none', 'Progress tooltip should not intercept pointer input')

const progressTime = getDirectDeclarations(getRule(playBarStyle, '.progressTime'))
expectDeclaration(progressTime, 'position', 'absolute', 'Accessible progress time should not participate in footer layout')
expectDeclaration(progressTime, 'width', '1px', 'Accessible progress time should use the standard visually-hidden width')
expectDeclaration(progressTime, 'height', '1px', 'Accessible progress time should use the standard visually-hidden height')
expectDeclaration(progressTime, 'padding', '0', 'Accessible progress time should not add layout padding')
expectDeclaration(progressTime, 'margin', '-1px', 'Accessible progress time should use the standard visually-hidden margin')
expectDeclaration(progressTime, 'overflow', 'hidden', 'Accessible progress time should remain visually clipped')
expectDeclaration(progressTime, 'clip', 'rect(0, 0, 0, 0)', 'Accessible progress time should use the standard visually-hidden clip')
expectDeclaration(progressTime, 'white-space', 'nowrap', 'Accessible progress time should remain on one clipped line')
expectDeclaration(progressTime, 'border', '0', 'Accessible progress time should not render a border')
expectDeclaration(progressTime, 'pointer-events', 'none', 'Accessible progress time should not intercept seeking')

const progressTrackHoverTooltip = getDirectDeclarations(getRule(playBarStyle, '.progressTrack:hover .progressTooltip'))
expectDeclaration(progressTrackHoverTooltip, 'visibility', 'visible', 'Progress tooltip should become visible on hover')
expectDeclaration(progressTrackHoverTooltip, 'opacity', '1', 'Progress tooltip should become opaque on hover')

const partyBtn = getDirectDeclarations(getRule(playBarStyle, '.partyBtn'))
expectDeclaration(partyBtn, 'min-height', '30px', 'Party button should be 30px high')
expectDeclaration(partyBtn, 'padding', '6px 10px', 'Party button should use compact padding')

const playBtn = getDirectDeclarations(getRule(playBarStyle, '.playBtn'))
expectDeclaration(playBtn, 'width', '32px', 'Playback buttons should be 32px wide')
expectDeclaration(playBtn, 'height', '32px', 'Playback buttons should be 32px high')
expectDeclaration(playBtn, 'padding', '6px', 'Playback buttons should use compact padding')

const playBtnPrimary = getDirectDeclarations(getRule(playBarStyle, '.playBtnPrimary'))
expectDeclaration(playBtnPrimary, 'width', '42px', 'Primary play button should be 42px wide')
expectDeclaration(playBtnPrimary, 'height', '42px', 'Primary play button should be 42px high')
expectDeclaration(playBtnPrimary, 'padding', '11px', 'Primary play button should use compact padding')

const narrowPlayBar = getRule(playBarStyle, '@media (max-width: 900px)')
const narrowPlayBtn = getDirectDeclarations(getRule(narrowPlayBar, '.playBtn'))
const narrowPlayBtnPrimary = getDirectDeclarations(getRule(narrowPlayBar, '.playBtnPrimary'))
expectDeclaration(narrowPlayBtn, 'width', '30px', 'Narrow playback buttons should be 30px wide')
expectDeclaration(narrowPlayBtn, 'height', '30px', 'Narrow playback buttons should be 30px high')
expectDeclaration(narrowPlayBtnPrimary, 'width', '38px', 'Narrow primary play button should be 38px wide')
expectDeclaration(narrowPlayBtnPrimary, 'height', '38px', 'Narrow primary play button should be 38px high')

assert.match(playBar, /@click="playPrev\(\)"/, 'Previous control should remain available')
assert.match(playBar, /@click="togglePlay"/, 'Play and pause control should remain available')
assert.match(playBar, /xlink:href="#icon-pause"/, 'Pause state icon should remain available')
assert.match(playBar, /xlink:href="#icon-play"/, 'Play state icon should remain available')
assert.match(playBar, /@click="playNext\(\)"/, 'Next control should remain available')
assert.match(playBar, /isShowPlayQueue\s*=\s*!isShowPlayQueue/, 'Queue control should remain available')
assert.match(playBar, /<control-btns\s*\/>/, 'Additional player controls should remain available')
assert.match(playBar, /@click="party\.isShowModal\s*=\s*true"/, 'Party control should remain available')

console.log('play detail refinement tests passed')
