const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const {
  getWebContentsNavigationDecision,
  registerWebContentsNavigationGuard,
} = loadTsModule(path.join(__dirname, '../src/main/utils/webContentsNavigationGuard.ts'))

const contents = {}
assert.strictEqual(getWebContentsNavigationDecision(contents, 'https://graph.qq.com/oauth2.0/show'), undefined)

const unregister = registerWebContentsNavigationGuard(contents, value => {
  return value == 'https://graph.qq.com/oauth2.0/show'
})
assert.strictEqual(getWebContentsNavigationDecision(contents, 'https://graph.qq.com/oauth2.0/show'), true)
assert.strictEqual(getWebContentsNavigationDecision(contents, 'https://evil.example/'), false)

unregister()
assert.strictEqual(getWebContentsNavigationDecision(contents, 'https://graph.qq.com/oauth2.0/show'), undefined)
unregister()

console.log('WebContents navigation guard tests passed')
