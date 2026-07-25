const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const readSource = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

const assertInOrder = (source, snippets, label) => {
  let previousIndex = -1
  for (const snippet of snippets) {
    const index = source.indexOf(snippet, previousIndex + 1)
    assert.notEqual(index, -1, `${label} is missing ${snippet}`)
    assert.ok(index > previousIndex, `${label} has ${snippet} out of order`)
    previousIndex = index
  }
}

const extractBracedBlock = (source, marker, label = marker) => {
  const markerIndex = source.indexOf(marker)
  assert.notEqual(markerIndex, -1, `Missing ${label}`)
  const openIndex = source.indexOf('{', markerIndex + marker.length)
  assert.notEqual(openIndex, -1, `Missing opening brace for ${label}`)

  let depth = 0
  for (let index = openIndex; index < source.length; index++) {
    if (source[index] == '{') depth++
    else if (source[index] == '}' && --depth == 0) {
      return source.substring(markerIndex, index + 1)
    }
  }
  assert.fail(`Missing closing brace for ${label}`)
}

const extractBetween = (source, startMarker, endMarker, label) => {
  const startIndex = source.indexOf(startMarker)
  assert.notEqual(startIndex, -1, `Missing ${label} start`)
  const endIndex = source.indexOf(endMarker, startIndex + startMarker.length)
  assert.notEqual(endIndex, -1, `Missing ${label} end`)
  return source.substring(startIndex, endIndex)
}

const ipcNames = readSource('src/common/ipcNames.ts')
const mainHandler = readSource('src/main/modules/winMain/rendererEvent/userApi.ts')
const rendererIpc = readSource('src/renderer/utils/ipc.ts')
const userApiModal = readSource('src/renderer/views/Setting/components/UserApiModal.vue')
const baseCheckbox = readSource('src/renderer/components/base/Checkbox.vue')
const locales = ['zh-cn', 'zh-tw', 'en-us'].map(locale => ({
  locale,
  messages: JSON.parse(readSource(`src/lang/${locale}.json`)),
}))
const template = extractBetween(userApiModal, '<template', '</template>', 'template')
const checkboxTemplate = extractBetween(baseCheckbox, '<template', '</template>', 'checkbox template')
const style = extractBetween(userApiModal, '<style', '</style>', 'style')
const githubTestMethod = extractBracedBlock(
  userApiModal,
  'async handleGitHubTest()',
  'GitHub test handler',
)
const githubImportMethod = extractBracedBlock(
  userApiModal,
  'async handleGitHubImport()',
  'GitHub import handler',
)
const removeMethod = extractBracedBlock(userApiModal, 'async handleRemove(api)', 'remove handler')
const apiGroupsMethod = extractBracedBlock(userApiModal, 'apiGroups()', 'API groups computed')
const closeMethod = extractBracedBlock(userApiModal, 'handleClose()', 'close handler')
const changeAlertMethod = extractBracedBlock(userApiModal, 'handleChangeAllowUpdateAlert(api, enable)', 'update alert handler')
const modelValueWatcher = extractBracedBlock(userApiModal, 'modelValue(show)', 'modelValue watcher')
const beforeUnmountHook = extractBracedBlock(userApiModal, 'beforeUnmount()', 'beforeUnmount hook')
const checkboxToggleMethod = extractBracedBlock(baseCheckbox, 'handleToggle(event)', 'checkbox toggle handler')
const groupTemplate = extractBetween(
  template,
  'section(v-for="group in apiGroups"',
  'div(v-else :class="$style.content")',
  'group template',
)
const footerTemplate = extractBetween(
  template,
  'div(:class="$style.footer")',
  'UserApiOnlineImportModal',
  'footer template',
)

assert.match(
  ipcNames,
  /replace_user_api_from_github:\s*'replace_user_api_from_github'/,
)
assert.match(
  mainHandler,
  /mainHandle<LX\.UserApi\.GitHubImportItem\[\],\s*LX\.UserApi\.UserApiInfo\[\]>/,
)
assert.match(mainHandler, /replaceApisFromGitHub\(items\)/)
assert.match(rendererIpc, /export const replaceUserApisFromGitHub/)
assert.match(
  rendererIpc,
  /rendererInvoke<LX\.UserApi\.GitHubImportItem\[\],\s*LX\.UserApi\.UserApiInfo\[\]>/,
)
assert.match(
  rendererIpc,
  /WIN_MAIN_RENDERER_EVENT_NAME\.replace_user_api_from_github/,
)

assert.match(
  userApiModal,
  /import\s*{[^}]*getGitHubUserApiSnapshot[^}]*downloadGitHubUserApiSnapshot[^}]*}\s*from\s*['"]@renderer\/utils\/githubUserApi['"]/s,
)
assert.match(
  userApiModal,
  /import\s*{[^}]*replaceUserApisFromGitHub[^}]*}\s*from\s*['"]@renderer\/utils\/ipc['"]/s,
)
for (const [label, method] of [
  ['GitHub test handler', githubTestMethod],
  ['GitHub import handler', githubImportMethod],
]) {
  assert.match(method, /if\s*\(this\.githubAction\)\s*return/, label + ' has no action guard')
  assert.match(method, /const\s+viewGeneration\s*=\s*this\.githubViewGeneration/)
  assert.match(
    method,
    /catch\s*\(err\)\s*{\s*if\s*\(!this\.isGitHubViewCurrent\(viewGeneration\)\)\s*return/,
    label + ' does not suppress stale errors',
  )
  assert.match(
    method,
    /finally\s*{\s*if\s*\(this\.githubAction\s*==\s*action\)\s*this\.githubAction\s*=\s*['"]{2}/,
    label + ' can clear another action',
  )
}
assertInOrder(modelValueWatcher, [
  'this.githubViewGeneration++',
  'if (!show) return',
], 'modal view generation')
assert.match(
  beforeUnmountHook,
  /^beforeUnmount\(\)\s*{\s*this\.githubViewGeneration\+\+\s*}$/,
  'beforeUnmount must only invalidate the current GitHub view generation',
)
assertInOrder(checkboxToggleMethod, [
  'if (this.disabled) return',
  'event.lx_handled = true',
], 'disabled checkbox keyboard guard')
assert.match(
  checkboxTemplate,
  /:tabindex="disabled \? -1 : 0"/,
  'disabled checkbox custom control must leave the keyboard tab order',
)
assertInOrder(githubTestMethod, [
  'const viewGeneration = this.githubViewGeneration',
  'getGitHubUserApiSnapshot()',
  'if (!this.isGitHubViewCurrent(viewGeneration)) return',
  "this.githubStatus = this.$t('user_api__github_test_success'",
], 'GitHub connection test lifecycle')
assertInOrder(githubImportMethod, [
  'const viewGeneration = this.githubViewGeneration',
  'getGitHubUserApiSnapshot()',
  'if (!this.isGitHubViewCurrent(viewGeneration)) return',
  'this.$dialog.confirm',
  'if (!this.isGitHubViewCurrent(viewGeneration)) return',
  'if (!confirmed)',
  "this.githubStatus = ''",
  'return',
  'const oldCustomIds = new Set(this.apiList.map(api => api.id))',
  'downloadGitHubUserApiSnapshot(snapshot)',
  'if (!this.isGitHubViewCurrent(viewGeneration)) return',
  'replaceUserApisFromGitHub(items)',
], 'GitHub import flow')
assertInOrder(githubImportMethod, [
  'const oldCustomIds = new Set(this.apiList.map(api => api.id))',
  'const items = await downloadGitHubUserApiSnapshot(snapshot)',
  'const apiList = await replaceUserApisFromGitHub(items)',
  'userApi.list = apiList',
  "const selectedId = appSetting['common.apiSource']",
  'if (oldCustomIds.has(selectedId) && !apiList.some(api => api.id == selectedId))',
  'const fallback = apiSourceInfo.find(api => !api.disabled) ?? apiList[0]',
  "updateSetting({ 'common.apiSource': fallback?.id ?? '' })",
  'if (!this.isGitHubViewCurrent(viewGeneration)) return',
  "this.githubStatus = this.$t('user_api__github_import_success'",
], 'live selected custom source preservation')
assert.doesNotMatch(githubImportMethod, /\bpreviousId\b|\bpreviousWasCustom\b/)
assert.match(githubImportMethod, /confirmButtonText:\s*this\.\$t\('confirm_button_text'\)/)
assert.doesNotMatch(githubImportMethod, /confirmButtonText:\s*this\.\$t\('ok'\)/)
assert.match(template, /material-modal\([^\r\n]*:close-btn="!githubAction"/)

assert.match(template, /material-modal\([^\r\n]*:bg-close="!githubAction"/)
assertInOrder(closeMethod, [
  'if (this.githubAction) return',
  "this.$emit('update:modelValue', false)",
], 'modal close guard')

assert.match(userApiModal, /async\s+handleRemove\(api\)/)
assert.doesNotMatch(removeMethod, /this\.apiList\s*\[\s*index\s*\]/)
assertInOrder(removeMethod, [
  'if (this.githubAction) return',
  "if (appSetting['common.apiSource'] == api.id)",
  'apiSourceInfo.find(api => !api.disabled)',
  'userApi.list.find(item => item.id != api.id)',
  "updateSetting({ 'common.apiSource': backApi?.id ?? '' })",
  'removeUserApi([api.id])',
], 'custom source removal')
assert.match(groupTemplate, /@click\.stop="handleRemove\(api\)"/)
assert.match(groupTemplate, /base-btn\([^\r\n]*:disabled="!!githubAction"[^\r\n]*@click\.stop="handleRemove\(api\)"/)
assert.match(groupTemplate, /base-checkbox\([^\r\n]*:disabled="!!githubAction"/)
assertInOrder(changeAlertMethod, [
  'if (this.githubAction) return',
  'setAllowShowUserApiUpdateAlert(api.id, enable)',
], 'update alert guard')

assertInOrder(apiGroupsMethod, [
  'for (const api of this.apiList)',
  "const name = api.remote?.group ?? ''",
  "const key = name ? 'remote:' + name : 'local:'",
  'if (!groups.has(key)) groups.set(key, { key, name, apis: [] })',
  'groups.get(key).apis.push(api)',
  'return [...groups.values()]',
], 'API grouping')
assert.doesNotMatch(apiGroupsMethod, /\.sort\s*\(/)
assert.notEqual('local:', 'remote:' + 'local')
assert.match(groupTemplate, /section\(v-for="group in apiGroups"/)
assert.match(groupTemplate, /:key="group\.key"/)
assert.doesNotMatch(groupTemplate, /:key="group\.name \|\| 'local'"/)
assert.match(groupTemplate, /span\(:class="\$style\.groupCount"\) {{ group\.apis\.length }}/)
assert.match(groupTemplate, /ul\(v-show="!collapsedGroups\.has\(group\.key\)"\)/)
assert.match(groupTemplate, /li\(v-for="api in group\.apis"/)
assert.match(groupTemplate, /group\.name \|\| \$t\('user_api__github_local_group'\)/)
assert.match(groupTemplate, /:aria-expanded="!collapsedGroups\.has\(group\.key\)"/)
assert.match(groupTemplate, /#icon-down/)

assertInOrder(footerTemplate, [
  '@click="handleGitHubTest"',
  '@click="handleGitHubImport"',
  '@click="isShowOnlineImportModal = true"',
  '@click="handleImport"',
], 'footer actions')
const footerButtonLines = footerTemplate
  .split(/\r?\n/)
  .filter(line => line.trimStart().startsWith('base-btn('))
assert.equal(footerButtonLines.length, 4, 'Footer must contain four action buttons')
for (const line of footerButtonLines) {
  assert.match(line, /:disabled="!!githubAction"/, 'Footer action is not guarded')
}
assert.match(
  template,
  /role="status"\s+aria-live="polite"|aria-live="polite"\s+role="status"/,
)

const footerCss = extractBracedBlock(style, '.footer', 'footer CSS')
assert.match(footerCss, /display:\s*grid\s*;/)
assert.match(footerCss, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*;/)
assert.match(footerCss, /gap:\s*10px\s*;/)
const responsiveCss = extractBracedBlock(
  style,
  '@media (max-width: 420px)',
  'responsive footer CSS',
)
assert.match(responsiveCss, /\.footer\s*{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/)
const groupHeaderCss = extractBracedBlock(style, '.groupHeader', 'group header CSS')
assert.match(groupHeaderCss, /width:\s*100%\s*;/)
assert.match(groupHeaderCss, /min-width:\s*0\s*;/)
const groupIconCss = extractBracedBlock(style, '.groupIcon', 'group icon CSS')
assert.match(groupIconCss, /width:\s*16px\s*;/)
assert.match(groupIconCss, /height:\s*16px\s*;/)
assert.match(groupIconCss, /\.collapsed\s*{[\s\S]*transform:\s*rotate\(-90deg\)\s*;/)
const statusCss = extractBracedBlock(style, '.githubStatus', 'GitHub status CSS')
assert.match(statusCss, /min-width:\s*0\s*;/)
assert.match(statusCss, /overflow-wrap:\s*anywhere\s*;/)
const footerButtonCss = extractBracedBlock(style, '.footerBtn', 'footer button CSS')
assert.match(footerButtonCss, /min-width:\s*0\s*;/)
assert.match(footerButtonCss, /white-space:\s*normal\s*;/)
assert.match(footerButtonCss, /overflow-wrap:\s*anywhere\s*;/)

assert.doesNotMatch(userApiModal, /this\.userApi\.list\.length\s*>\s*20/)

const translationKeys = [
  'user_api__github_test',
  'user_api__github_testing',
  'user_api__github_import',
  'user_api__github_importing',
  'user_api__github_local_group',
  'user_api__github_test_success',
  'user_api__github_import_confirm',
  'user_api__github_import_success',
  'user_api__github_error_rate_limit',
  'user_api__github_error_http',
  'user_api__github_error_tree',
  'user_api__github_error_version',
  'user_api__github_error_scripts',
  'user_api__github_error_limit',
  'user_api__github_error_invalid_script',
  'user_api__github_error_generic',
]

const expectedTranslations = {
  'zh-cn': [
    '\u6d4b\u8bd5\u4ed3\u5e93\u8fde\u63a5',
    '\u6d4b\u8bd5\u4e2d...',
    '\u83b7\u53d6\u6700\u65b0\u97f3\u6e90',
    '\u83b7\u53d6\u4e2d...',
    '\u672c\u5730\u5bfc\u5165',
    '\u4ed3\u5e93\u8fde\u63a5\u6210\u529f\uff1a{version}\uff0c{count} \u4e2a\u97f3\u6e90\uff0c\u63d0\u4ea4 {commit}',
    '\u5c06\u6e05\u7a7a\u73b0\u6709 {localCount} \u4e2a\u81ea\u5b9a\u4e49\u6e90\uff0c\u5e76\u5bfc\u5165 {version} \u7684 {remoteCount} \u4e2a\u97f3\u6e90\u3002\u662f\u5426\u7ee7\u7eed\uff1f',
    '\u5df2\u5bfc\u5165 {version} \u7684 {count} \u4e2a\u97f3\u6e90',
    'GitHub \u8bf7\u6c42\u6b21\u6570\u5df2\u8fbe\u4e0a\u9650\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5',
    'GitHub \u8bf7\u6c42\u5931\u8d25\uff1a{message}',
    '\u4ed3\u5e93\u76ee\u5f55\u6570\u636e\u65e0\u6548\u6216\u4e0d\u5b8c\u6574',
    '\u4ed3\u5e93\u4e2d\u6ca1\u6709\u53ef\u7528\u7684\u7248\u672c\u76ee\u5f55',
    '\u6700\u65b0\u7248\u672c\u76ee\u5f55\u4e2d\u6ca1\u6709 JS \u97f3\u6e90',
    '\u8fdc\u7a0b\u97f3\u6e90\u6570\u91cf\u6216\u5927\u5c0f\u8d85\u8fc7\u5b89\u5168\u9650\u5236',
    '\u8fdc\u7a0b\u97f3\u6e90\u811a\u672c\u65e0\u6548\uff1a{message}',
    '\u83b7\u53d6 GitHub \u97f3\u6e90\u5931\u8d25\uff1a{message}',
  ],
  'zh-tw': [
    '\u6e2c\u8a66\u5009\u5eab\u9023\u7dda',
    '\u6e2c\u8a66\u4e2d...',
    '\u53d6\u5f97\u6700\u65b0\u97f3\u6e90',
    '\u53d6\u5f97\u4e2d...',
    '\u672c\u6a5f\u532f\u5165',
    '\u5009\u5eab\u9023\u7dda\u6210\u529f\uff1a{version}\uff0c{count} \u500b\u97f3\u6e90\uff0c\u63d0\u4ea4 {commit}',
    '\u5c07\u6e05\u7a7a\u73fe\u6709 {localCount} \u500b\u81ea\u8a02\u4f86\u6e90\uff0c\u4e26\u532f\u5165 {version} \u7684 {remoteCount} \u500b\u97f3\u6e90\u3002\u662f\u5426\u7e7c\u7e8c\uff1f',
    '\u5df2\u532f\u5165 {version} \u7684 {count} \u500b\u97f3\u6e90',
    'GitHub \u8acb\u6c42\u6b21\u6578\u5df2\u9054\u4e0a\u9650\uff0c\u8acb\u7a0d\u5f8c\u91cd\u8a66',
    'GitHub \u8acb\u6c42\u5931\u6557\uff1a{message}',
    '\u5009\u5eab\u76ee\u9304\u8cc7\u6599\u7121\u6548\u6216\u4e0d\u5b8c\u6574',
    '\u5009\u5eab\u4e2d\u6c92\u6709\u53ef\u7528\u7684\u7248\u672c\u76ee\u9304',
    '\u6700\u65b0\u7248\u672c\u76ee\u9304\u4e2d\u6c92\u6709 JS \u97f3\u6e90',
    '\u9060\u7aef\u97f3\u6e90\u6578\u91cf\u6216\u5927\u5c0f\u8d85\u904e\u5b89\u5168\u9650\u5236',
    '\u9060\u7aef\u97f3\u6e90\u8173\u672c\u7121\u6548\uff1a{message}',
    '\u53d6\u5f97 GitHub \u97f3\u6e90\u5931\u6557\uff1a{message}',
  ],
  'en-us': [
    'Test Repository',
    'Testing...',
    'Get Latest Sources',
    'Getting Sources...',
    'Local Imports',
    'Repository connected: {version}, {count} sources, commit {commit}',
    'Replace all {localCount} custom sources with {remoteCount} sources from {version}?',
    'Imported {count} sources from {version}',
    'GitHub rate limit reached. Try again later.',
    'GitHub request failed: {message}',
    'Repository tree data is invalid or incomplete.',
    'No version directory was found.',
    'The latest version has no JavaScript sources.',
    'The remote source batch exceeds the size or count limit.',
    'Invalid remote source script: {message}',
    'Failed to get GitHub sources: {message}',
  ],
}

for (const { locale, messages } of locales) {
  for (const key of translationKeys) {
    assert.equal(
      typeof messages[key],
      'string',
      `${locale} is missing ${key}`,
    )
    assert.ok(messages[key].trim(), `${locale} has an empty ${key}`)
    if (locale != 'en-us') {
      assert.match(messages[key], /[^\u0000-\u007f]/, `${locale} has corrupted ${key}`)
    }
  }
}

for (const { locale, messages } of locales) {
  assert.equal(expectedTranslations[locale].length, translationKeys.length)
  for (const [index, key] of translationKeys.entries()) {
    assert.equal(messages[key], expectedTranslations[locale][index], locale + ' has unexpected ' + key)
    assert.doesNotMatch(messages[key], /\uFFFD/, locale + ' has replacement characters in ' + key)
    assert.doesNotMatch(messages[key], /\?{2,}/, locale + ' has repeated question marks in ' + key)
  }
}

console.log('GitHub user API IPC wiring tests passed')
