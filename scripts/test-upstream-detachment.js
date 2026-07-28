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
    linkFragments: [
      '<span class="hover underline" @click="openUrl(projectIdentity.repositoryUrl + \'#readme\')">GitHub</span>',
    ],
  },
  {
    file: 'src/renderer/views/Setting/components/UserApiModal.vue',
    linkFragments: [
      'span.hover.underline(:aria-label="projectIdentity.repositoryUrl + \'#readme\'" @click="handleOpenUrl(projectIdentity.repositoryUrl + \'#readme\')") 项目说明',
    ],
  },
  {
    file: 'src/renderer/views/Setting/components/SettingSync/index.vue',
    linkFragments: [
      'button(class="help-btn" :aria-label="$t(\'setting__sync_tip\')" @click="openUrl(projectIdentity.repositoryUrl + \'#readme\')")',
    ],
  },
  {
    file: 'src/renderer/views/Setting/components/SettingOpenAPI.vue',
    linkFragments: [
      'strong.hover.underline(:aria-label="projectIdentity.repositoryUrl + \'#readme\'" @click="openUrl(projectIdentity.repositoryUrl + \'#readme\')") {{ $t(\'setting__open_api_tip_link\') }}',
    ],
  },
  {
    file: 'src/renderer/views/songList/List/components/OpenListModal.vue',
    linkFragments: [
      '<span class="hover underline" :aria-label="projectIdentity.repositoryUrl + \'#readme\'" @click="openUrl(projectIdentity.repositoryUrl + \'#readme\')" >项目说明</span>',
    ],
  },
]

const assertRuntimeSupportMapping = ({ file, linkFragments }, source) => {
  const normalizedSource = normalizeMarkup(source)
  assert.match(source, /\bPROJECT_IDENTITY\b/, `${file}: shared identity import`)
  assert.match(source, /\bprojectIdentity\b/, `${file}: template identity binding`)
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
