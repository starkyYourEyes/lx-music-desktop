const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const root = path.resolve(__dirname, '..')

const auth = loadTsModule(path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'))

const browserAuth = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/browserAuth.ts'),
  {
    electron: {
      BrowserWindow: class {},
      session: {},
    },
    './auth': auth,
    '@main/utils/sessionProxy': {
      configureSessionProxy: async() => {},
    },
    '@main/utils/webContentsNavigationGuard': {
      registerWebContentsNavigationGuard: () => () => {},
    },
  },
)

assert.strictEqual(
  browserAuth.isQQMusicLoginNavigationAllowed('https://graph.qq.com/oauth2.0/show?code=hidden'),
  true,
)
assert.strictEqual(
  browserAuth.isQQMusicLoginNavigationAllowed('https://graph.qq.com/oauth2.0/authorize'),
  true,
)
assert.strictEqual(
  browserAuth.isQQMusicLoginNavigationAllowed('https://graph.qq.com/oauth2.0/login_jump'),
  true,
)
assert.strictEqual(
  browserAuth.isQQMusicLoginNavigationAllowed('https://ssl.ptlogin2.graph.qq.com/check_sig'),
  true,
)
assert.strictEqual(
  browserAuth.isQQMusicLoginNavigationAllowed('https://xui.ptlogin2.qq.com/cgi-bin/xlogin'),
  true,
)
assert.strictEqual(
  browserAuth.isQQMusicLoginNavigationAllowed('https://y.qq.com/portal/wx_redirect.html?code=hidden'),
  true,
)

for (const value of [
  'http://graph.qq.com/oauth2.0/show',
  'https://user:pass@graph.qq.com/oauth2.0/show',
  'https://graph.qq.com:444/oauth2.0/show',
  'https://graph.qq.com.evil.example/oauth2.0/show',
  'https://evil.example/oauth2.0/authorize',
  'not-a-url',
]) {
  assert.strictEqual(browserAuth.isQQMusicLoginNavigationAllowed(value), false, value)
}

assert.deepStrictEqual(
  browserAuth.getQQMusicQrCaptureRect(
    { x: 20.2, y: 57.8, width: 407, height: 331 },
    { x: 160.1, y: 90.5, width: 86.6, height: 86.6 },
  ),
  { x: 180, y: 148, width: 87, height: 87 },
)
assert.strictEqual(
  browserAuth.getQQMusicQrCaptureRect(
    { x: 0, y: 0, width: 407, height: 331 },
    { x: 0, y: 0, width: 0, height: 87 },
  ),
  null,
)

assert.strictEqual(browserAuth.getQQMusicBrowserCookie([
  { name: 'uin', value: 'o123', domain: '.qq.com' },
  { name: 'p_skey', value: 'p=value', domain: 'graph.qq.com' },
  { name: 'qqmusic_key', value: 'music=value', domain: '.y.qq.com' },
  { name: 'evil', value: 'ignore', domain: 'notqq.com' },
  { name: 'empty', value: '', domain: '.qq.com' },
]), 'uin=o123; p_skey=p=value; qqmusic_key=music=value')

const authorizeUrl = new URL(browserAuth.createQQMusicAuthorizeUrl('opaque-state'))
assert.strictEqual(authorizeUrl.origin + authorizeUrl.pathname, 'https://graph.qq.com/oauth2.0/show')
assert.strictEqual(authorizeUrl.searchParams.get('which'), 'Login')
assert.strictEqual(authorizeUrl.searchParams.get('display'), 'pc')
assert.strictEqual(authorizeUrl.searchParams.get('client_id'), '100497308')
assert.strictEqual(authorizeUrl.searchParams.get('response_type'), 'code')
assert.strictEqual(authorizeUrl.searchParams.get('state'), 'opaque-state')
assert.strictEqual(
  authorizeUrl.searchParams.get('redirect_uri'),
  'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/',
)

const appSource = fs.readFileSync(path.join(root, 'src/main/app.ts'), 'utf8')
const browserAuthSource = fs.readFileSync(path.join(root, 'src/main/modules/qqMusic/browserAuth.ts'), 'utf8')
const navigationHandler = /contents\.on\('will-navigate',[\s\S]*?\n\s*}\)/.exec(appSource)?.[0]
assert(navigationHandler, 'Expected a global will-navigate handler')
assert.doesNotMatch(
  navigationHandler,
  /NODE_ENV\s*!==\s*'production'\)\s*\{[^{}]*\breturn\b[^{}]*\}/,
  'Development navigation should not bypass the URL allowlist',
)
assert.match(appSource, /getWebContentsNavigationDecision/)
assert(
  navigationHandler.indexOf('getWebContentsNavigationDecision') < navigationHandler.indexOf('console.log'),
  'Managed login navigation must be handled before development URL logging',
)
assert.match(browserAuthSource, /contextIsolation:\s*true/)
assert.match(browserAuthSource, /nodeIntegration:\s*false/)
assert.match(browserAuthSource, /sandbox:\s*true/)
assert.match(browserAuthSource, /setPermissionRequestHandler/)
assert.match(browserAuthSource, /setPermissionCheckHandler/)
assert.match(browserAuthSource, /registerWebContentsNavigationGuard/)
assert.match(browserAuthSource, /unregisterNavigationGuard\(\)/)
assert.match(browserAuthSource, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/)
assert.doesNotMatch(
  browserAuthSource,
  /setUserAgent|BROWSER_USER_AGENT/,
  'QQ OAuth must keep Chromium UA and Client Hints internally consistent',
)
assert.strictEqual(
  browserAuth.isExpectedAllowedNavigationAbort(
    { code: 'ERR_ABORTED', errno: -3 },
    true,
  ),
  true,
)
assert.strictEqual(
  browserAuth.isExpectedAllowedNavigationAbort(
    { code: 'ERR_ABORTED', errno: -3 },
    false,
  ),
  false,
)
assert.match(browserAuthSource, /configureSessionProxy/)
assert.match(browserAuthSource, /deadlineAt/)
assert.doesNotMatch(browserAuthSource, /await\s+withTimeout\(win\.loadURL/)
assert.equal(
  browserAuth.isQQMusicPortalLanding('https://y.qq.com/?from=oauth'),
  true,
)
assert.equal(
  browserAuth.isQQMusicPortalLanding('https://y.qq.com.evil.example/'),
  false,
)
assert.match(browserAuthSource, /did-fail-load/)
assert.match(browserAuthSource, /partition-cleanup-timed-out/)
assert.match(browserAuthSource, /signal\.addEventListener\('abort'/)
assert.doesNotMatch(
  browserAuthSource,
  /onDiagnostic\(\{[\s\S]{0,240}\b(?:validatedURL|errorDescription|authorizeUrl|partition|target|value)\s*(?::|,|\})[\s\S]{0,240}\}\)/,
)

console.log('QQ Music browser auth helper tests passed')
