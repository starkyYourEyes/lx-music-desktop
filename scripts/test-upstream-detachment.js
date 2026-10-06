const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const pkg = require('../package.json')
const lockText = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const normalizeMarkup = source => source.replace(/\s+/g, ' ').trim()
const legacySupportUrlRxp = /lyswhut\.github|github\.com\/lyswhut|lxmusic\.toside\.cn/

const runtimeSupportMappings = [
  {
    file: 'src/renderer/views/Setting/components/SettingAbout.vue',
    importFragment: 'import { PROJECT_IDENTITY } from \'@common/projectIdentity\'',
    bindingFragment: 'projectIdentity: PROJECT_IDENTITY',
    linkFragments: [
      'span.hover.underline(:aria-label="$t(\'setting__click_open\')" @click="openUrl(projectIdentity.repositoryUrl + \'#readme\')") {{ projectIdentity.repositoryUrl }}',
      'span.hover.underline(:aria-label="$t(\'setting__click_open\')" @click="openUrl(projectIdentity.releasesUrl)") GitHub Releases',
      'span.hover.underline(:aria-label="$t(\'setting__click_open\')" @click="openUrl(projectIdentity.repositoryUrl + \'#readme\')") 项目说明',
      'span.hover.underline(:aria-label="$t(\'setting__click_open\')" @click="openUrl(projectIdentity.issuesUrl)") 提交&nbsp;Issue',
      'strong.hover.underline(:aria-label="$t(\'setting__click_open\')" @click="openUrl(projectIdentity.repositoryUrl + \'#许可证与来源\')") 这里',
      'strong {{ projectIdentity.authorName }}',
    ],
  },
  {
    file: 'src/renderer/components/layout/PactModal.vue',
    importFragment: 'import { PROJECT_IDENTITY } from \'@common/projectIdentity\'',
    bindingFragment: 'projectIdentity: PROJECT_IDENTITY',
    linkFragments: [
      '<span class="hover underline" @click="openUrl(projectIdentity.repositoryUrl + \'#readme\')">GitHub</span>',
    ],
  },
  {
    file: 'src/renderer/views/Setting/components/UserApiModal.vue',
    importFragment: 'import { PROJECT_IDENTITY } from \'@common/projectIdentity\'',
    bindingFragment: 'projectIdentity: PROJECT_IDENTITY',
    linkFragments: [
      'span.hover.underline(:aria-label="projectIdentity.repositoryUrl + \'#readme\'" @click="handleOpenUrl(projectIdentity.repositoryUrl + \'#readme\')") 项目说明',
    ],
  },
  {
    file: 'src/renderer/views/Setting/components/SettingSync/index.vue',
    importFragment: 'import { PROJECT_IDENTITY } from \'@common/projectIdentity\'',
    bindingFragment: 'projectIdentity: PROJECT_IDENTITY',
    linkFragments: [
      'button(class="help-btn" :aria-label="$t(\'setting__sync_tip\')" @click="openUrl(projectIdentity.repositoryUrl + \'#readme\')")',
    ],
  },
  {
    file: 'src/renderer/views/Setting/components/SettingOpenAPI.vue',
    importFragment: 'import { PROJECT_IDENTITY } from \'@common/projectIdentity\'',
    bindingFragment: 'projectIdentity: PROJECT_IDENTITY',
    linkFragments: [
      'strong.hover.underline(:aria-label="projectIdentity.repositoryUrl + \'#readme\'" @click="openUrl(projectIdentity.repositoryUrl + \'#readme\')") {{ $t(\'setting__open_api_tip_link\') }}',
    ],
  },
  {
    file: 'src/renderer/views/songList/List/components/OpenListModal.vue',
    importFragment: 'import { PROJECT_IDENTITY } from \'@common/projectIdentity\'',
    bindingFragment: 'const projectIdentity = PROJECT_IDENTITY',
    linkFragments: [
      '<span class="hover underline" :aria-label="projectIdentity.repositoryUrl + \'#readme\'" @click="openUrl(projectIdentity.repositoryUrl + \'#readme\')" >项目说明</span>',
    ],
  },
]

const assertRuntimeSupportMapping = ({ file, importFragment, bindingFragment, linkFragments }, source) => {
  const normalizedSource = normalizeMarkup(source)
  assert.ok(normalizedSource.includes(importFragment), `${file}: ${importFragment}`)
  assert.ok(normalizedSource.includes(bindingFragment), `${file}: ${bindingFragment}`)
  assert.doesNotMatch(source, legacySupportUrlRxp, `${file}: legacy support URL`)
  for (const fragment of linkFragments) {
    assert.ok(normalizedSource.includes(fragment), `${file}: ${fragment}`)
  }
}

const extractOptionsBlock = (source, startMarker, endMarker) => {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const start = normalizedSource.indexOf(startMarker)
  assert.notEqual(start, -1, `missing options start marker: ${startMarker}`)
  const end = normalizedSource.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing options end marker: ${endMarker}`)
  return normalizedSource.slice(start, end)
}

test('direct dependencies use approved official npm releases', () => {
  assert.equal(pkg.devDependencies['electron-devtools-installer'], '^4.0.0')
  assert.equal(pkg.devDependencies['eslint-formatter-friendly'], '^7.0.0')
  assert.equal(pkg.devDependencies.spinnies, '^0.5.1')
  assert.equal(pkg.devDependencies['webpack-hot-middleware'], '^2.26.1')
  assert.equal(pkg.dependencies.needle, '^3.5.0')
  assert.equal(Object.hasOwn(pkg.dependencies, 'message2call'), false)
  assert.doesNotMatch(lockText, /github(?:\.com)?:lyswhut|github\.com\/lyswhut/i)
})

test('renderer needle wrapper preserves fork proxy and parsing behavior', () => {
  const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/utils/request.js'), 'utf8')
  const rendererOptions = extractOptionsBlock(
    rendererSource,
    'return request(url, {\n    ...options,',
    '\n  }, (err, resp, body) => {',
  )
  assert.match(rendererOptions, /\.\.\.options,[\s\S]*use_proxy_from_env_var:\s*false/)
  assert.match(rendererOptions, /\.\.\.options,[\s\S]*parse:\s*false/)
})

test('user API preload needle wrapper preserves fork proxy and parsing behavior', () => {
  const preloadSource = fs.readFileSync(path.join(root, 'src/main/modules/userApi/renderer/preload.js'), 'utf8')
  const preloadOptions = extractOptionsBlock(
    preloadSource,
    'let options = {',
    '\n      }\n      let data',
  )
  assert.match(preloadOptions, /use_proxy_from_env_var:\s*false/)
  assert.match(preloadOptions, /parse:\s*false/)
})

test('legacy release and documentation files are removed', () => {
  for (const relativePath of [
    'FAQ.md',
    'CHANGELOG.md',
    'publish',
    '.github/workflows/publish-version-info.yml',
  ]) assert.equal(fs.existsSync(path.join(root, relativePath)), false, relativePath)
})

test('current support and release entry points target this repository', () => {
  const currentUrl = 'https://github.com/starkyYourEyes/lx-music-desktop'
  const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')
  assert.match(read('README.md'), new RegExp(escapeRegExp(currentUrl)))
  assert.match(read('UPSTREAM.md'), /lyswhut\/lx-music-desktop/)
  for (const file of ['.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/feature.yml']) {
    const source = read(file)
    assert.match(source, /starkyYourEyes\/lx-music-desktop/)
    assert.doesNotMatch(source, /lyswhut\.github|github\.com\/lyswhut/)
  }

  for (const mapping of runtimeSupportMappings) {
    assertRuntimeSupportMapping(mapping, read(mapping.file))
  }

  const supportCopy = [
    {
      file: 'src/renderer/views/Setting/components/SettingAbout.vue',
      labels: ['软件的项目说明可转至', '阅读项目说明后'],
      staleLabels: ['软件的常见问题可转至', '阅读常见问题后'],
    },
    {
      file: 'src/renderer/views/Setting/components/UserApiModal.vue',
      labels: [') 项目说明'],
      staleLabels: [') FAQ'],
    },
    {
      file: 'src/renderer/views/songList/List/components/OpenListModal.vue',
      labels: ['>项目说明</span>'],
      staleLabels: ['>FAQ</span>'],
    },
    {
      file: '.github/ISSUE_TEMPLATE/bug.yml',
      labels: ['description: 报告一个错误（Bug），请先查看项目说明及搜索 Issue 列表中有无你要提的问题。'],
      staleLabels: ['description: 报告一个错误（Bug），请先查看常见问题及搜索 Issue 列表中有无你要提的问题。'],
    },
    {
      file: '.github/ISSUE_TEMPLATE/feature.yml',
      labels: ['description: 为这个项目提出一个想法，请先查看项目说明及搜索 Issue 列表中有无你要提的问题。'],
      staleLabels: ['description: 为这个项目提出一个想法，请先查看常见问题及搜索 Issue 列表中有无你要提的问题。'],
    },
  ]

  for (const { file, labels, staleLabels } of supportCopy) {
    const source = read(file)
    for (const label of labels) {
      assert.ok(source.includes(label), `${file}: ${label}`)
    }
    for (const staleLabel of staleLabels) {
      assert.ok(!source.includes(staleLabel), `${file}: stale copy: ${staleLabel}`)
    }
  }
})

test('runtime support audit rejects a legacy UserApi aria target', () => {
  const mapping = runtimeSupportMappings.find(({ file }) => file.endsWith('/UserApiModal.vue'))
  const source = fs.readFileSync(path.join(root, mapping.file), 'utf8')
  const currentAria = ':aria-label="projectIdentity.repositoryUrl + \'#readme\'"'
  const legacyAria = 'aria-label="https://lxmusic.toside.cn/desktop/custom-source"'
  const adversarialSource = source.replace(currentAria, legacyAria)
  assert.notEqual(adversarialSource, source, 'UserApi aria probe must alter the in-memory source')
  assert.throws(
    () => assertRuntimeSupportMapping(mapping, adversarialSource),
    /UserApiModal\.vue: legacy support URL/,
  )
})

test('runtime support audit rejects a missing SettingAbout identity binding', () => {
  const mapping = runtimeSupportMappings.find(({ file }) => file.endsWith('/SettingAbout.vue'))
  const source = fs.readFileSync(path.join(root, mapping.file), 'utf8')
  const binding = 'projectIdentity: PROJECT_IDENTITY,'
  const adversarialSource = source.replace(binding, '')
  assert.notEqual(adversarialSource, source, 'SettingAbout binding probe must alter the in-memory source')
  assert.throws(
    () => assertRuntimeSupportMapping(mapping, adversarialSource),
    /SettingAbout\.vue: projectIdentity: PROJECT_IDENTITY/,
  )
})

const compareStrings = (left, right) => left < right ? -1 : left > right ? 1 : 0
const compareTextFilePaths = (left, right) => compareStrings(left.path, right.path)

const listTrackedTextFiles = repositoryPath => {
  const trackedPaths = execFileSync('git', ['ls-files', '-z'], {
    cwd: repositoryPath,
    encoding: 'utf8',
  }).split('\0').filter(Boolean).sort(compareStrings)
  const files = []
  for (const trackedPath of trackedPaths) {
    const fullPath = path.join(repositoryPath, trackedPath)
    let stats
    try {
      stats = fs.lstatSync(fullPath)
    } catch (error) {
      if (error.code == 'ENOENT') continue
      throw error
    }
    if (!stats.isFile() && !stats.isSymbolicLink()) continue
    const buffer = stats.isSymbolicLink()
      ? Buffer.from(fs.readlinkSync(fullPath))
      : fs.readFileSync(fullPath)
    if (!buffer.includes(0)) {
      files.push({
        path: trackedPath.replace(/\\/g, '/'),
        text: buffer.toString('utf8'),
      })
    }
  }
  return files.sort(compareTextFilePaths)
}

const upstreamRecordAllowed = [
  /^LICENSE$/,
  /^licenses\//,
  /^UPSTREAM\.md$/,
  /^docs\/superpowers\/(?:specs|plans)\//,
  /^doc\/MOBILE_PORTING_CHANGES\.md$/,
  /^scripts\/test-(?:upstream-detachment|legacy-user-data-migration|project-identity)\.js$/,
  /^src\/main\/migration\/legacyUserData\.js$/,
]
const upstreamIdentityPattern = /lyswhut|github\.com\/lyswhut|lyswhut\.github\.io/i
const readmeAttributionHeading = '## 许可证与来源'
const readmeAttributionLink = '[lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop)'
const hasOnlyIntendedReadmeAttribution = text => {
  const sectionIndex = text.indexOf(readmeAttributionHeading)
  const attributionIndex = text.indexOf(readmeAttributionLink)
  if (sectionIndex < 0 || attributionIndex < sectionIndex + readmeAttributionHeading.length) return false

  const nextSectionIndex = text.indexOf('\n## ', sectionIndex + readmeAttributionHeading.length)
  if (nextSectionIndex >= 0 && attributionIndex >= nextSectionIndex) return false

  const withoutAttribution = text.slice(0, attributionIndex) +
    text.slice(attributionIndex + readmeAttributionLink.length)
  return !upstreamIdentityPattern.test(withoutAttribution)
}
const findUpstreamRecordViolations = files => files.filter(file => {
  if (file.path === 'docs/blog/lx-music-desktop-introduction/article.md') {
    const attribution = '项目基于 [LX Music Desktop](https://github.com/lyswhut/lx-music-desktop) v2.12.1'
    return upstreamIdentityPattern.test(file.text.replace(attribution, ''))
  }
  if (file.path === 'README.md') return !hasOnlyIntendedReadmeAttribution(file.text)
  return upstreamIdentityPattern.test(file.text) &&
    !upstreamRecordAllowed.some(pattern => pattern.test(file.path))
}).sort(compareTextFilePaths)

const runtimeIdentifierPatterns = [
  /cn\.toside\.music\.desktop/,
  /(?<!starky-)lx-music-protocol/,
  /\blxmusic:\/\//,
  /\blx_music_(?:desktop|mobile)\b/,
  /(?<!starky-)\blx-user-api\b/,
  /(?<!starky-)\blx-music request\b/,
  /(?<!starky-)\blx-music auth::/,
  /(?<!starky-)\blx-music connect\b/,
  /\blxmusic_temp\b/,
  /\/dav\/lx-music\b/,
  /lx-music-desktop-version-info/,
  /gitee\.com\/lyswhut/,
  /cdn\.stsky\.cn\/lx-music/,
]
const runtimeIdentifierAllowed = [
  /^src\/common\/syncProtocol\.js$/,
]
const findRuntimeIdentifierViolations = files => {
  const violations = []
  for (const file of [...files].sort(compareTextFilePaths)) {
    if (runtimeIdentifierAllowed.some(pattern => pattern.test(file.path))) continue
    for (const pattern of runtimeIdentifierPatterns) {
      if (pattern.test(file.text)) violations.push(`${file.path}: ${pattern}`)
    }
  }
  return violations.sort(compareStrings)
}

test('legacy sync identifiers are allowlisted only in the compatibility module', () => {
  const violations = findRuntimeIdentifierViolations([
    {
      path: 'src/common/syncProtocol.js',
      text: 'lx_music_desktop\nlx_music_mobile\nlx-music auth::\nlx-music connect',
    },
    {
      path: 'src/main/stray.ts',
      text: 'lx_music_desktop',
    },
  ])
  assert.deepEqual(violations, [
    'src/main/stray.ts: /\\blx_music_(?:desktop|mobile)\\b/',
  ])
})

const legacyBackupAllowed = [
  /^src\/common\/backupFormats\.js$/,
  /^scripts\/test-(?:backup-formats|upstream-detachment)\.js$/,
  /^README\.md$/,
  /^build-config\/my-list-group-flows\.test\.js$/,
  /^docs\/superpowers\/(?:specs|plans)\//,
]
const legacyBackupPattern = /\blxmc\b/i
const findLegacyBackupViolations = files => files.filter(file =>
  legacyBackupPattern.test(file.path === '.gitignore' ? file.text.replace(/^\*\.lxmc\r?$/m, '') : file.text) &&
  !legacyBackupAllowed.some(pattern => pattern.test(file.path)),
).sort(compareTextFilePaths)

const removedSourceGuardTests = new Set([
  'scripts/test-updater-removal.js',
  'scripts/test-upstream-detachment.js',
])
const removedSourcePatterns = [
  /electron-updater/,
  /github:lyswhut/,
  /git\+ssh:\/\/git@github\.com\/lyswhut/,
  /lx-music-desktop-version-info/,
]
const findRemovedSourceViolations = files => {
  const violations = []
  for (const file of [...files].sort(compareTextFilePaths)) {
    if (/^docs\/superpowers\//.test(file.path) || removedSourceGuardTests.has(file.path)) continue
    for (const pattern of removedSourcePatterns) {
      if (pattern.test(file.text)) violations.push(`${file.path}: ${pattern}`)
    }
  }
  return violations.sort(compareStrings)
}

test('repository audit ignores untracked scratch while scanning tracked production files', t => {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'starky-audit-test-'))
  t.after(() => fs.rmSync(repositoryPath, { recursive: true, force: true }))
  fs.mkdirSync(path.join(repositoryPath, 'src'))
  fs.mkdirSync(path.join(repositoryPath, 'scratch'))
  fs.writeFileSync(path.join(repositoryPath, '.gitignore'), 'scratch/\n')
  fs.writeFileSync(path.join(repositoryPath, 'src', 'tracked.js'), 'cn.toside.music.desktop\n')
  fs.writeFileSync(path.join(repositoryPath, 'scratch', 'notes.txt'), 'https://github.com/lyswhut/lx-music-desktop\n')
  execFileSync('git', ['init', '--quiet'], { cwd: repositoryPath })
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '.gitignore', 'src/tracked.js'], { cwd: repositoryPath })

  const files = listTrackedTextFiles(repositoryPath)

  assert.deepEqual(files.map(file => file.path), ['.gitignore', 'src/tracked.js'])
  assert.deepEqual(
    findRuntimeIdentifierViolations(files),
    ['src/tracked.js: /cn\\.toside\\.music\\.desktop/'],
  )
})

test('upstream author and URL appear only in attribution and migration records', () => {
  const files = listTrackedTextFiles(root)
  const readme = files.find(file => file.path === 'README.md')
  assert.ok(readme, 'README.md must be present')
  assert.equal(hasOnlyIntendedReadmeAttribution(readme.text), true)
  const readmeWithoutAttribution = readme.text.replace(readmeAttributionLink, '')
  assert.notEqual(readmeWithoutAttribution, readme.text, 'README attribution probe must alter the in-memory source')
  assert.deepEqual(
    findUpstreamRecordViolations([{ path: readme.path, text: readmeWithoutAttribution }])
      .map(file => file.path),
    ['README.md'],
  )

  const violations = findUpstreamRecordViolations(files)
  assert.deepEqual(violations.map(file => file.path), [])
})

test('old runtime identifiers are isolated from production configuration', () => {
  const productionRoots = ['src/', 'build-config/', '.github/']
  const production = listTrackedTextFiles(root)
    .filter(file => productionRoots.some(relativePath => file.path.startsWith(relativePath)))
    .filter(file => file.path != 'src/main/migration/legacyUserData.js')
  const violations = findRuntimeIdentifierViolations(production)
  assert.deepEqual(violations, [])
})

test('legacy backup extension is isolated to compatibility code and records', () => {
  const violations = findLegacyBackupViolations(listTrackedTextFiles(root))
  assert.deepEqual(violations.map(file => file.path), [])
})

test('removed updater and release sources cannot be reintroduced', () => {
  const violations = findRemovedSourceViolations(listTrackedTextFiles(root))
  assert.deepEqual(violations, [])
})

test('tracked repository text files are returned in deterministic order', () => {
  const paths = listTrackedTextFiles(root).map(file => file.path)
  assert.deepEqual(paths, [...paths].sort(compareStrings))
})

test('repository audits reject adversarial detached values', () => {
  const productionPath = 'src/adversarial-probe.js'

  const upstreamViolations = findUpstreamRecordViolations([{
    path: productionPath,
    text: 'https://github.com/lyswhut/lx-music-desktop',
  }])
  assert.deepEqual(upstreamViolations.map(file => file.path), [productionPath])

  const runtimeViolations = findRuntimeIdentifierViolations([{
    path: productionPath,
    text: 'cn.toside.music.desktop',
  }])
  assert.equal(runtimeViolations.length, 1)
  assert.match(runtimeViolations[0], /src\/adversarial-probe\.js/)

  const backupViolations = findLegacyBackupViolations([{
    path: productionPath,
    text: 'backup.lxmc',
  }])
  assert.deepEqual(backupViolations.map(file => file.path), [productionPath])
})

test('legacy backup audit rejects bare and uppercase tokens without matching the new extension', () => {
  const productionPath = 'src/adversarial-probe.js'
  const legacyResults = [
    'picker accepts lxmc',
    'backup.LXMC',
  ].map(text => findLegacyBackupViolations([{
    path: productionPath,
    text,
  }]).map(file => file.path))
  assert.deepEqual(legacyResults, [[productionPath], [productionPath]])

  const approvedResults = findLegacyBackupViolations([{
    path: productionPath,
    text: 'backup.slxmc',
  }])
  assert.deepEqual(approvedResults, [])
})

test('runtime audit rejects the complete old identity contract without matching current values', () => {
  const productionPath = 'src/adversarial-probe.js'
  const results = [
    'lx-music auth::',
    'lx-music connect',
    'https://dav.jianguoyun.com/dav/lx-music',
    'starky-lx-music auth::',
    'starky-lx-music connect',
    'https://dav.jianguoyun.com/dav/starky-lx-music',
  ].map(text => findRuntimeIdentifierViolations([{
    path: productionPath,
    text,
  }]).length)
  assert.deepEqual(results, [1, 1, 1, 0, 0, 0])
})

test('README attribution does not allow an extra operational upstream link', () => {
  const adversarialReadme = [
    '## 许可证与来源',
    `本项目基于 ${readmeAttributionLink}。`,
    '',
    'Releases: https://github.com/lyswhut/lx-music-desktop/releases',
  ].join('\n')
  const violations = findUpstreamRecordViolations([{
    path: 'README.md',
    text: adversarialReadme,
  }])
  assert.deepEqual(violations.map(file => file.path), ['README.md'])
})

test('removed-source diagnostics identify the violating file and pattern', () => {
  const violations = findRemovedSourceViolations([{
    path: 'package.json',
    text: 'electron-updater',
  }])
  assert.deepEqual(violations, ['package.json: /electron-updater/'])
})

test('narrow attribution and backup ignore allowances still reject extra operational tokens', () => {
  const blog = 'docs/blog/lx-music-desktop-introduction/article.md'
  const attribution = '项目基于 [LX Music Desktop](https://github.com/lyswhut/lx-music-desktop) v2.12.1'
  assert.deepEqual(findUpstreamRecordViolations([{ path: blog, text: attribution }]), [])
  assert.deepEqual(findUpstreamRecordViolations([{ path: blog, text: attribution + '\nhttps://github.com/lyswhut/releases' }]).map(file => file.path), [blog])
  assert.deepEqual(findLegacyBackupViolations([{ path: '.gitignore', text: '*.lxmc\n' }]), [])
  assert.deepEqual(findLegacyBackupViolations([{ path: '.gitignore', text: '*.lxmc\nstray.lxmc' }]).map(file => file.path), ['.gitignore'])
})
