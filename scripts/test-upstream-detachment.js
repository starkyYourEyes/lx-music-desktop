const assert = require('node:assert/strict')
const fs = require('node:fs')
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

const walkTextFiles = directory => {
  const ignored = new Set(['.git', '.claude', '.codegraph', '.worktrees', 'build', 'dist', 'node_modules'])
  const files = []
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) visit(fullPath)
      else {
        const buffer = fs.readFileSync(fullPath)
        if (!buffer.includes(0)) {
          files.push({
            path: path.relative(root, fullPath).replace(/\\/g, '/'),
            text: buffer.toString('utf8'),
          })
        }
      }
    }
  }
  visit(directory)
  return files
}

const upstreamRecordAllowed = [
  /^LICENSE$/,
  /^licenses\//,
  /^README\.md$/,
  /^UPSTREAM\.md$/,
  /^docs\/superpowers\/(?:specs|plans)\//,
  /^doc\/MOBILE_PORTING_CHANGES\.md$/,
  /^scripts\/test-(?:upstream-detachment|legacy-user-data-migration|project-identity)\.js$/,
  /^src\/main\/migration\/legacyUserData\.js$/,
]
const upstreamIdentityPattern = /lyswhut|github\.com\/lyswhut|lyswhut\.github\.io/i
const findUpstreamRecordViolations = files => files.filter(file =>
  upstreamIdentityPattern.test(file.text) &&
  !upstreamRecordAllowed.some(pattern => pattern.test(file.path)),
)

const runtimeIdentifierPatterns = [
  /cn\.toside\.music\.desktop/,
  /(?<!starky-)lx-music-protocol/,
  /\blxmusic:\/\//,
  /\blx_music_(?:desktop|mobile)\b/,
  /(?<!starky-)\blx-user-api\b/,
  /(?<!starky-)\blx-music request\b/,
  /\blxmusic_temp\b/,
  /lx-music-desktop-version-info/,
  /gitee\.com\/lyswhut/,
  /cdn\.stsky\.cn\/lx-music/,
]
const findRuntimeIdentifierViolations = files => {
  const violations = []
  for (const file of files) {
    for (const pattern of runtimeIdentifierPatterns) {
      if (pattern.test(file.text)) violations.push(`${file.path}: ${pattern}`)
    }
  }
  return violations
}

const legacyBackupAllowed = [
  /^src\/common\/backupFormats\.js$/,
  /^scripts\/test-(?:backup-formats|upstream-detachment)\.js$/,
  /^README\.md$/,
  /^docs\/superpowers\/(?:specs|plans)\//,
]
const legacyBackupPattern = /\.lxmc\b/
const findLegacyBackupViolations = files => files.filter(file =>
  legacyBackupPattern.test(file.text) &&
  !legacyBackupAllowed.some(pattern => pattern.test(file.path)),
)

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
const createRemovedSourceCorpus = files => files
  .filter(file =>
    !/^docs\/superpowers\//.test(file.path) &&
    !removedSourceGuardTests.has(file.path),
  )
  .map(file => file.text)
  .join('\n')

test('upstream author and URL appear only in attribution and migration records', () => {
  const violations = findUpstreamRecordViolations(walkTextFiles(root))
  assert.deepEqual(violations.map(file => file.path), [])
})

test('old runtime identifiers are isolated from production configuration', () => {
  const productionRoots = ['src', 'build-config', '.github']
  const production = productionRoots.flatMap(relativePath => walkTextFiles(path.join(root, relativePath)))
    .filter(file => file.path != 'src/main/migration/legacyUserData.js')
  const violations = findRuntimeIdentifierViolations(production)
  assert.deepEqual(violations, [])
})

test('legacy backup extension is isolated to compatibility code and records', () => {
  const violations = findLegacyBackupViolations(walkTextFiles(root))
  assert.deepEqual(violations.map(file => file.path), [])
})

test('removed updater and release sources cannot be reintroduced', () => {
  const allText = createRemovedSourceCorpus(walkTextFiles(root))
  for (const pattern of removedSourcePatterns) assert.doesNotMatch(allText, pattern)
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

  const removedSourceCorpus = createRemovedSourceCorpus([{
    path: 'package.json',
    text: 'electron-updater',
  }])
  assert.match(removedSourceCorpus, removedSourcePatterns[0])
})
