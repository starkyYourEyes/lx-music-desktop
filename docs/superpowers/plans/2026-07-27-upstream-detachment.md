# Upstream Detachment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove runtime, release, metadata, dependency, and support-link coupling to `lyswhut/lx-music-desktop` while preserving the LX Music display brand, legal attribution, installed-user data, and legacy backup imports.

**Architecture:** Put the new technical identity in one CommonJS module that can be consumed by Node build scripts and TypeScript application code. Keep compatibility code isolated in a user-data migration module and a backup-format module, replace `message2call` with a narrowly scoped in-repository RPC transport, and use static audit tests to prevent old runtime identifiers or upstream endpoints from returning. Remove application auto-update as a complete vertical feature instead of leaving dormant IPC, store, UI, or dependency fragments.

**Tech Stack:** Electron 37, Vue 3, TypeScript/JavaScript, CommonJS build scripts, Node 22 `node:test`, npm, electron-builder, GitHub Actions, PowerShell.

---

## Execution Constraints

- Execute in an isolated worktree created with `superpowers:using-git-worktrees`; do not implement directly on the user's working branch.
- Preserve the visible product name `LX Music`, current icons, `LX.*` TypeScript namespaces, `global.lx`, `window.lx`, `lxlyric`, and `lxlrc` contracts.
- Do not register or parse `lxmusic://`; do not accept old sync identities.
- Never delete, rename, or overwrite the installed user's legacy `lx-music-desktop` data directory.
- Keep `LICENSE`, every file under `licenses/`, all branches, commits, tags, old user data, and the updated `node_modules/` directory.
- Do not rewrite Git history and do not push.
- Do not remove `build/`, `dist/`, `.codegraph/`, or worktrees until every verification command in Task 10 has passed.

## File Map

### New focused modules

- `src/common/projectIdentity.js`: current technical identity and repository URLs, sourced from `package.json` where practical.
- `src/common/projectIdentity.d.ts`: typed contract for application imports.
- `src/main/migration/legacyUserData.js`: installed-user data migration and portable-path resolution; the old data-directory name is isolated here.
- `src/main/migration/legacyUserData.d.ts`: migration result and dependency-injection types.
- `src/common/backupFormats.js`: new backup names, legacy import extensions, and export-path normalization.
- `src/common/backupFormats.d.ts`: typed backup-format contract.
- `src/common/utils/syncRpc.js`: JSON-only RPC transport with grouped FIFO queues.
- `src/common/utils/syncRpc.d.ts`: remote-proxy and options types.
- `UPSTREAM.md`: explicit v2.12.1 base-project attribution.

### New tests

- `scripts/test-project-identity.js`: exact identity values plus build/runtime wiring.
- `scripts/test-legacy-user-data-migration.js`: copy, no-overwrite, failure cleanup, boundary, and portable cases.
- `scripts/test-backup-formats.js`: new export names and dual-extension imports.
- `scripts/test-sync-rpc.js`: bidirectional RPC contract and queue behavior.
- `scripts/test-updater-removal.js`: complete deletion of application-update code.
- `scripts/test-upstream-detachment.js`: repository-wide allowlisted static audit and dependency checks.

### Deleted feature and legacy files

- `src/main/modules/winMain/autoUpdate.ts`
- `src/renderer/core/useApp/useUpdate.ts`
- `src/renderer/components/layout/UpdateModal.vue`
- `src/renderer/components/layout/ChangeLogModal.vue`
- `src/renderer/utils/update.js`
- `.github/workflows/publish-version-info.yml`
- `FAQ.md`
- `CHANGELOG.md`
- every tracked file under `publish/`

---

### Task 1: Centralize Project Identity and Packaging Metadata

**Files:**
- Create: `src/common/projectIdentity.js`
- Create: `src/common/projectIdentity.d.ts`
- Create: `scripts/test-project-identity.js`
- Modify: `package.json`
- Modify: `build-config/build-pack.js`
- Modify: `build-config/packaged-app.test.js`

- [ ] **Step 1: Write the failing identity test**

Create `scripts/test-project-identity.js` with exact-value and centralization assertions:

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const pkg = require('../package.json')
const { PROJECT_IDENTITY } = require('../src/common/projectIdentity')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('project identity contains the approved values', () => {
  assert.deepEqual(PROJECT_IDENTITY, {
    packageName: 'starky-lx-music-desktop',
    displayName: 'LX Music',
    appId: 'com.starkyyoureyes.lxmusic.desktop',
    productName: 'starky-lx-music-desktop',
    userDataDirName: 'starky-lx-music-desktop',
    protocolScheme: 'starkylx',
    protocolPrefix: 'starkylx://',
    protocolName: 'starky-lx-music-protocol',
    syncDesktopId: 'starky_lx_music_desktop',
    syncMobileId: 'starky_lx_music_mobile',
    syncAuthPrefix: 'starky-lx-music auth::',
    syncConnectMessage: 'starky-lx-music connect',
    requestUserAgent: 'starky-lx-music request',
    userApiPartition: 'starky-lx-user-api',
    tempDirectoryName: 'starky_lx_music_temp',
    defaultWebdavUrl: 'https://dav.jianguoyun.com/dav/starky-lx-music',
    backupExtension: 'slxmc',
    allDataBackupName: 'starky_datas_v2.slxmc',
    settingBackupName: 'starky_setting_v2.slxmc',
    playlistBackupName: 'starky_list.slxmc',
    authorName: 'starkyYourEyes',
    repositoryUrl: 'https://github.com/starkyYourEyes/lx-music-desktop',
    repositoryOwner: 'starkyYourEyes',
    repositoryName: 'lx-music-desktop',
    issuesUrl: 'https://github.com/starkyYourEyes/lx-music-desktop/issues',
    releasesUrl: 'https://github.com/starkyYourEyes/lx-music-desktop/releases',
  })
})

test('package metadata is the identity source for package author and repository', () => {
  assert.equal(pkg.name, PROJECT_IDENTITY.packageName)
  assert.equal(pkg.author.name, PROJECT_IDENTITY.authorName)
  assert.equal(pkg.repository.url, `${PROJECT_IDENTITY.repositoryUrl}.git`)
  assert.equal(pkg.bugs.url, PROJECT_IDENTITY.issuesUrl)
  assert.equal(pkg.homepage, `${PROJECT_IDENTITY.repositoryUrl}#readme`)
})

test('electron builder consumes the shared identity', () => {
  const source = read('build-config/build-pack.js')
  assert.match(source, /require\('\.\.\/src\/common\/projectIdentity'\)/)
  for (const oldValue of [
    'cn.toside.music.desktop',
    "productName: 'lx-music-desktop'",
    "name: 'lx-music-protocol'",
    "'lxmusic'",
    "owner: 'lyswhut'",
  ]) assert.doesNotMatch(source, new RegExp(oldValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})
```

- [ ] **Step 2: Run the identity test and verify the red state**

Run: `node --test scripts/test-project-identity.js`

Expected: FAIL with `Cannot find module '../src/common/projectIdentity'`.

- [ ] **Step 3: Add the shared identity module and declaration**

Create `src/common/projectIdentity.js`:

```js
const packageJson = require('../../package.json')

const normalizeRepositoryUrl = repository => {
  const rawUrl = typeof repository == 'string' ? repository : repository.url
  return rawUrl.replace(/^git\+/, '').replace(/\.git$/, '')
}

const repositoryUrl = normalizeRepositoryUrl(packageJson.repository)
const repositoryPath = new URL(repositoryUrl).pathname.replace(/^\//, '').split('/')
const authorName = typeof packageJson.author == 'string' ? packageJson.author : packageJson.author.name

const PROJECT_IDENTITY = Object.freeze({
  packageName: packageJson.name,
  displayName: 'LX Music',
  appId: 'com.starkyyoureyes.lxmusic.desktop',
  productName: packageJson.name,
  userDataDirName: 'starky-lx-music-desktop',
  protocolScheme: 'starkylx',
  protocolPrefix: 'starkylx://',
  protocolName: 'starky-lx-music-protocol',
  syncDesktopId: 'starky_lx_music_desktop',
  syncMobileId: 'starky_lx_music_mobile',
  syncAuthPrefix: 'starky-lx-music auth::',
  syncConnectMessage: 'starky-lx-music connect',
  requestUserAgent: 'starky-lx-music request',
  userApiPartition: 'starky-lx-user-api',
  tempDirectoryName: 'starky_lx_music_temp',
  defaultWebdavUrl: 'https://dav.jianguoyun.com/dav/starky-lx-music',
  backupExtension: 'slxmc',
  allDataBackupName: 'starky_datas_v2.slxmc',
  settingBackupName: 'starky_setting_v2.slxmc',
  playlistBackupName: 'starky_list.slxmc',
  authorName,
  repositoryUrl,
  repositoryOwner: repositoryPath[0],
  repositoryName: repositoryPath[1],
  issuesUrl: `${repositoryUrl}/issues`,
  releasesUrl: `${repositoryUrl}/releases`,
})

module.exports = { PROJECT_IDENTITY }
```

Create `src/common/projectIdentity.d.ts`:

```ts
export interface ProjectIdentity {
  readonly packageName: string
  readonly displayName: string
  readonly appId: string
  readonly productName: string
  readonly userDataDirName: string
  readonly protocolScheme: string
  readonly protocolPrefix: string
  readonly protocolName: string
  readonly syncDesktopId: string
  readonly syncMobileId: string
  readonly syncAuthPrefix: string
  readonly syncConnectMessage: string
  readonly requestUserAgent: string
  readonly userApiPartition: string
  readonly tempDirectoryName: string
  readonly defaultWebdavUrl: string
  readonly backupExtension: string
  readonly allDataBackupName: string
  readonly settingBackupName: string
  readonly playlistBackupName: string
  readonly authorName: string
  readonly repositoryUrl: string
  readonly repositoryOwner: string
  readonly repositoryName: string
  readonly issuesUrl: string
  readonly releasesUrl: string
}

export const PROJECT_IDENTITY: Readonly<ProjectIdentity>
```

- [ ] **Step 4: Update package metadata**

Change only these `package.json` fields; retain the existing version, display-name plist entries, scripts other than the later legacy `publish` removal, and unrelated dependencies:

```json
{
  "name": "starky-lx-music-desktop",
  "repository": {
    "type": "git",
    "url": "https://github.com/starkyYourEyes/lx-music-desktop.git"
  },
  "author": {
    "name": "starkyYourEyes"
  },
  "bugs": {
    "url": "https://github.com/starkyYourEyes/lx-music-desktop/issues"
  },
  "homepage": "https://github.com/starkyYourEyes/lx-music-desktop#readme"
}
```

- [ ] **Step 5: Wire electron-builder to the shared identity**

At the top of `build-config/build-pack.js`, add:

```js
const { PROJECT_IDENTITY } = require('../src/common/projectIdentity')
```

Replace the corresponding identity-bearing properties in the existing configuration with these exact values:

```js
appId: PROJECT_IDENTITY.appId,
productName: PROJECT_IDENTITY.productName,
protocols: {
  name: PROJECT_IDENTITY.protocolName,
  schemes: [PROJECT_IDENTITY.protocolScheme],
},
publish: [{
  provider: 'github',
  owner: PROJECT_IDENTITY.repositoryOwner,
  repo: PROJECT_IDENTITY.repositoryName,
}],
```

In `winOptions.win`, set:

```js
legalTrademarks: PROJECT_IDENTITY.authorName,
```

In `linuxOptions.linux`, set `maintainer` and replace the full desktop entry with:

```js
maintainer: PROJECT_IDENTITY.authorName,
desktop: {
  entry: {
    Name: PROJECT_IDENTITY.displayName,
    'Name[zh_CN]': PROJECT_IDENTITY.displayName,
    'Name[zh_TW]': PROJECT_IDENTITY.displayName,
    Encoding: 'UTF-8',
    MimeType: `x-scheme-handler/${PROJECT_IDENTITY.protocolScheme}`,
    StartupNotify: 'false',
  },
},
```

Keep the existing artifact templates; their `${productName}` prefix now resolves to `starky-lx-music-desktop`.

- [ ] **Step 6: Update the packaged-app manifest assertion**

In `build-config/packaged-app.test.js`, change the manifest assertion to:

```js
assert.equal(manifest.name, 'starky-lx-music-desktop')
```

- [ ] **Step 7: Run the identity test and a syntax check**

Run:

```powershell
node --test scripts/test-project-identity.js
node --check src/common/projectIdentity.js
node --check build-config/build-pack.js
```

Expected: all tests PASS and both syntax checks exit 0.

- [ ] **Step 8: Commit the identity boundary**

```powershell
git add package.json build-config/build-pack.js build-config/packaged-app.test.js src/common/projectIdentity.js src/common/projectIdentity.d.ts scripts/test-project-identity.js
git commit -m "refactor: establish independent project identity"
```

---

### Task 2: Migrate Installed User Data Without Touching the Legacy Directory

**Files:**
- Create: `src/main/migration/legacyUserData.js`
- Create: `src/main/migration/legacyUserData.d.ts`
- Create: `scripts/test-legacy-user-data-migration.js`
- Modify: `src/main/app.ts:128-144`

- [ ] **Step 1: Write failing migration tests**

Create `scripts/test-legacy-user-data-migration.js`:

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  MIGRATION_MARKER_FILE,
  getPortableUserDataPaths,
  migrateLegacyUserData,
} = require('../src/main/migration/legacyUserData')

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'starky-user-data-test-'))
const silentLogger = { info() {}, warn() {}, error() {} }

test('copies legacy data atomically and leaves the source unchanged', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(path.join(legacyPath, 'LxDatas'), { recursive: true })
  fs.writeFileSync(path.join(legacyPath, 'LxDatas', 'config.json'), 'legacy')

  const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'migrated')
  assert.equal(fs.readFileSync(path.join(result.userDataPath, 'LxDatas', 'config.json'), 'utf8'), 'legacy')
  assert.equal(fs.readFileSync(path.join(legacyPath, 'LxDatas', 'config.json'), 'utf8'), 'legacy')
  assert.equal(fs.existsSync(path.join(result.userDataPath, MIGRATION_MARKER_FILE)), true)
})

test('does not copy or overwrite when the new directory already exists', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  fs.mkdirSync(legacyPath)
  fs.mkdirSync(currentPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'old')
  fs.writeFileSync(path.join(currentPath, 'value'), 'new')

  const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'current-exists')
  assert.equal(fs.readFileSync(path.join(currentPath, 'value'), 'utf8'), 'new')
  assert.equal(fs.readFileSync(path.join(legacyPath, 'value'), 'utf8'), 'old')
})

test('creates an empty current directory when no legacy data exists', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'legacy-missing')
  assert.equal(fs.existsSync(result.userDataPath), true)
})

test('cleans only its temporary directory after a copy failure', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'old')
  const fsApi = { ...fs, cpSync() { throw new Error('copy failed') } }

  const result = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(fs.readFileSync(path.join(legacyPath, 'value'), 'utf8'), 'old')
  assert.equal(fs.existsSync(result.tempPath), false)
  assert.equal(fs.existsSync(result.userDataPath), true)
})

test('refuses a user-data name that escapes appData', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  assert.throws(() => migrateLegacyUserData({
    appDataPath,
    currentDirName: '..',
    logger: silentLogger,
  }), /direct child/)
})

test('portable mode resolves package-local paths without invoking migration', () => {
  const result = getPortableUserDataPaths({
    platform: 'win32',
    executablePath: 'D:\\Apps\\LX Music\\LX Music.exe',
    pathExists: candidate => candidate.endsWith('portable'),
  })
  assert.deepEqual(result, {
    appDataPath: path.win32.normalize('D:\\Apps\\LX Music\\portable'),
    userDataPath: path.win32.normalize('D:\\Apps\\LX Music\\portable\\userData'),
  })
  assert.equal(getPortableUserDataPaths({
    platform: 'linux',
    executablePath: '/opt/lx/LX Music',
    pathExists: () => true,
  }), null)
})
```

- [ ] **Step 2: Run the migration tests and verify the red state**

Run: `node --test scripts/test-legacy-user-data-migration.js`

Expected: FAIL with `Cannot find module '../src/main/migration/legacyUserData'`.

- [ ] **Step 3: Implement the migration helper**

Create `src/main/migration/legacyUserData.js`:

```js
const fs = require('node:fs')
const path = require('node:path')
const { PROJECT_IDENTITY } = require('../../common/projectIdentity')

const LEGACY_USER_DATA_DIR_NAME = 'lx-music-desktop'
const MIGRATION_MARKER_FILE = '.legacy-user-data-migration.json'
const TEMP_SUFFIX = '.migration-tmp'

const assertDirectChild = (rootPath, candidatePath) => {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(candidatePath)
  if (path.dirname(candidate) != root || candidate == root) {
    throw new Error(`Migration path must be a direct child of appData: ${candidate}`)
  }
}

const ensureDirectory = (fsApi, directoryPath) => {
  if (!fsApi.existsSync(directoryPath)) fsApi.mkdirSync(directoryPath, { recursive: true })
}

const getPortableUserDataPaths = ({ platform, executablePath, pathExists = fs.existsSync }) => {
  if (platform != 'win32') return null
  const appDataPath = path.win32.join(path.win32.dirname(executablePath), 'portable')
  if (!pathExists(appDataPath)) return null
  return {
    appDataPath,
    userDataPath: path.win32.join(appDataPath, 'userData'),
  }
}

const migrateLegacyUserData = ({
  appDataPath,
  currentDirName = PROJECT_IDENTITY.userDataDirName,
  fsApi = fs,
  logger = console,
}) => {
  const rootPath = path.resolve(appDataPath)
  const legacyPath = path.join(rootPath, LEGACY_USER_DATA_DIR_NAME)
  const userDataPath = path.join(rootPath, currentDirName)
  const tempPath = `${userDataPath}${TEMP_SUFFIX}`

  assertDirectChild(rootPath, legacyPath)
  assertDirectChild(rootPath, userDataPath)
  assertDirectChild(rootPath, tempPath)

  if (fsApi.existsSync(userDataPath)) {
    return { status: 'current-exists', legacyPath, userDataPath, tempPath }
  }
  if (!fsApi.existsSync(legacyPath)) {
    ensureDirectory(fsApi, userDataPath)
    return { status: 'legacy-missing', legacyPath, userDataPath, tempPath }
  }

  try {
    if (fsApi.existsSync(tempPath)) fsApi.rmSync(tempPath, { recursive: true, force: true })
    fsApi.cpSync(legacyPath, tempPath, { recursive: true, force: false, errorOnExist: true })

    const legacyEntries = fsApi.readdirSync(legacyPath)
    const copiedEntries = new Set(fsApi.readdirSync(tempPath))
    for (const entry of legacyEntries) {
      if (!copiedEntries.has(entry)) throw new Error(`Migration verification failed: ${entry}`)
    }

    fsApi.renameSync(tempPath, userDataPath)
    fsApi.writeFileSync(path.join(userDataPath, MIGRATION_MARKER_FILE), JSON.stringify({
      sourceDirectory: LEGACY_USER_DATA_DIR_NAME,
      completedAt: new Date().toISOString(),
    }, null, 2))
    logger.info(`Migrated user data to ${userDataPath}`)
    return { status: 'migrated', legacyPath, userDataPath, tempPath }
  } catch (error) {
    logger.error('Legacy user-data migration failed', error)
    if (fsApi.existsSync(tempPath)) fsApi.rmSync(tempPath, { recursive: true, force: true })
    ensureDirectory(fsApi, userDataPath)
    return { status: 'failed', legacyPath, userDataPath, tempPath, error }
  }
}

module.exports = {
  LEGACY_USER_DATA_DIR_NAME,
  MIGRATION_MARKER_FILE,
  getPortableUserDataPaths,
  migrateLegacyUserData,
}
```

Create `src/main/migration/legacyUserData.d.ts`:

```ts
import type fs from 'node:fs'

export type MigrationStatus = 'migrated' | 'current-exists' | 'legacy-missing' | 'failed'

export interface MigrationResult {
  status: MigrationStatus
  legacyPath: string
  userDataPath: string
  tempPath: string
  error?: unknown
}

export const LEGACY_USER_DATA_DIR_NAME: string
export const MIGRATION_MARKER_FILE: string

export const getPortableUserDataPaths: (options: {
  platform: NodeJS.Platform
  executablePath: string
  pathExists?: (candidate: string) => boolean
}) => { appDataPath: string, userDataPath: string } | null

export const migrateLegacyUserData: (options: {
  appDataPath: string
  currentDirName?: string
  fsApi?: typeof fs
  logger?: Pick<Console, 'info' | 'error'>
}) => MigrationResult
```

- [ ] **Step 4: Integrate migration into `setUserDataPath()`**

Add imports to `src/main/app.ts`:

```ts
import { getPortableUserDataPaths, migrateLegacyUserData } from './migration/legacyUserData'
```

Replace `setUserDataPath()` with:

```ts
export const setUserDataPath = () => {
  const portablePaths = getPortableUserDataPaths({
    platform: process.platform,
    executablePath: app.getPath('exe'),
  })

  if (portablePaths) {
    app.setPath('appData', portablePaths.appDataPath)
    if (!existsSync(portablePaths.userDataPath)) mkdirSync(portablePaths.userDataPath, { recursive: true })
    app.setPath('userData', portablePaths.userDataPath)
  } else {
    const migration = migrateLegacyUserData({ appDataPath: app.getPath('appData'), logger: log })
    app.setPath('userData', migration.userDataPath)
  }

  const userDataPath = app.getPath('userData')
  global.lxOldDataPath = userDataPath
  global.lxDataPath = path.join(userDataPath, 'LxDatas')
  if (!existsSync(global.lxDataPath)) mkdirSync(global.lxDataPath, { recursive: true })
}
```

This preserves the current portable layout and runs installed migration before `initAppSetting()` opens databases or settings.

- [ ] **Step 5: Run migration tests and lint the touched application file**

Run:

```powershell
node --test scripts/test-legacy-user-data-migration.js
npx eslint -f node_modules/eslint-formatter-friendly src/main/app.ts
```

Expected: all six migration tests PASS and ESLint exits 0.

- [ ] **Step 6: Commit the migration**

```powershell
git add src/main/migration/legacyUserData.js src/main/migration/legacyUserData.d.ts src/main/app.ts scripts/test-legacy-user-data-migration.js
git commit -m "feat: migrate legacy installed user data"
```

---

### Task 3: Switch Deep-Link, Sync, Request, Session, Temp, and WebDAV Identities

**Files:**
- Modify: `scripts/test-project-identity.js`
- Modify: `src/common/constants.ts`
- Modify: `src/common/constants_sync.ts`
- Modify: `src/common/defaultSetting.ts`
- Modify: `src/main/app.ts`
- Modify: `src/main/modules/sync/client/auth.ts`
- Modify: `src/main/modules/sync/server/server/auth.ts`
- Modify: `src/main/modules/userApi/main.ts`
- Modify: `src/renderer/core/useApp/useDeeplink/index.ts`
- Modify: `src/renderer/utils/musicSdk/options.js`
- Modify: `src/renderer/views/Setting/components/SettingOther.vue`
- Modify: `src/renderer/worker/main/music.ts`

- [ ] **Step 1: Extend the identity test with runtime wiring assertions**

Append to `scripts/test-project-identity.js`:

```js
test('runtime identifiers are consumed from the shared identity', () => {
  const expectedImports = [
    'src/common/constants.ts',
    'src/common/constants_sync.ts',
    'src/main/app.ts',
    'src/main/modules/sync/client/auth.ts',
    'src/main/modules/sync/server/server/auth.ts',
    'src/main/modules/userApi/main.ts',
    'src/renderer/core/useApp/useDeeplink/index.ts',
    'src/renderer/utils/musicSdk/options.js',
    'src/renderer/worker/main/music.ts',
  ]
  for (const relativePath of expectedImports) {
    assert.match(read(relativePath), /projectIdentity/, relativePath)
  }

  const productionSources = expectedImports.map(read).join('\n')
  for (const oldPattern of [
    /\blxmusic:\/\//,
    /(?<!starky_)\blx_music_desktop\b/,
    /(?<!starky_)\blx_music_mobile\b/,
    /(?<!starky-)\blx-music auth::/,
    /(?<!starky-)\blx-music connect\b/,
    /(?<!starky-)\blx-user-api\b/,
    /(?<!starky-)\blx-music request\b/,
    /\blxmusic_temp\b/,
  ]) assert.doesNotMatch(productionSources, oldPattern)

  const serverAuth = read('src/main/modules/sync/server/server/auth.ts')
  assert.match(serverAuth, /syncDesktopId/)
  assert.match(serverAuth, /syncMobileId/)
})
```

- [ ] **Step 2: Run the extended test and verify it fails**

Run: `node --test scripts/test-project-identity.js`

Expected: FAIL because the listed runtime files do not yet import `projectIdentity` and still contain old identifiers.

- [ ] **Step 3: Wire deep-link and protocol registration**

In `src/common/constants.ts`:

```ts
import { PROJECT_IDENTITY } from './projectIdentity'

export const URL_SCHEME_RXP = new RegExp(`^${PROJECT_IDENTITY.protocolScheme}:\\/\\/`)
```

In `src/main/app.ts`, replace both `setAsDefaultProtocolClient` calls with `PROJECT_IDENTITY.protocolScheme` after importing `PROJECT_IDENTITY`.

In `src/renderer/core/useApp/useDeeplink/index.ts`, import `PROJECT_IDENTITY` and parse only the new prefix:

```ts
const [type, action, ...paths] = url.replace(PROJECT_IDENTITY.protocolPrefix, '').split('/')
```

- [ ] **Step 4: Wire and harden sync identity checks**

In `src/common/constants_sync.ts`, import `PROJECT_IDENTITY` and set:

```ts
export const SYNC_CODE = {
  authMsg: PROJECT_IDENTITY.syncAuthPrefix,
  msgConnect: PROJECT_IDENTITY.syncConnectMessage,
} as const
```

Change only these two properties; leave `helloMsg`, `idPrefix`, and the existing status/error strings unchanged.

In `src/main/modules/sync/client/auth.ts`, import `PROJECT_IDENTITY` and build the code-auth payload with `PROJECT_IDENTITY.syncDesktopId`.

In `src/main/modules/sync/server/server/auth.ts`, import `PROJECT_IDENTITY` and replace the permissive mobile check with:

```ts
const clientType = data[3]
if (clientType != PROJECT_IDENTITY.syncDesktopId && clientType != PROJECT_IDENTITY.syncMobileId) return null
const isMobile = clientType == PROJECT_IDENTITY.syncMobileId
```

This explicitly rejects old desktop and mobile IDs rather than treating every unknown ID as desktop.

- [ ] **Step 5: Wire the remaining technical identifiers**

Use `PROJECT_IDENTITY` in these exact locations:

```js
// src/renderer/utils/musicSdk/options.js
import { PROJECT_IDENTITY } from '@common/projectIdentity'
export const headers = {
  'User-Agent': PROJECT_IDENTITY.requestUserAgent,
  [bHh]: [bHh],
}
```

```ts
// src/main/modules/userApi/main.ts
const userApiSession = session.fromPartition(PROJECT_IDENTITY.userApiPartition)
```

```ts
// src/renderer/worker/main/music.ts
const tempDir = path.join(os.tmpdir(), PROJECT_IDENTITY.tempDirectoryName)
```

```ts
// src/common/defaultSetting.ts
'webdav.url': PROJECT_IDENTITY.defaultWebdavUrl,
```

In `src/renderer/views/Setting/components/SettingOther.vue`, bind the placeholder instead of hard-coding it:

```pug
input.input.gap-left(type="text" :value="appSetting['webdav.url']" :placeholder="PROJECT_IDENTITY.defaultWebdavUrl" @change="handleWebDAVUrlChange")
```

Import `PROJECT_IDENTITY` in the component script and return it from `setup()`.

- [ ] **Step 6: Run identity tests and focused lint**

Run:

```powershell
node --test scripts/test-project-identity.js
npx eslint -f node_modules/eslint-formatter-friendly src/common/constants.ts src/common/constants_sync.ts src/common/defaultSetting.ts src/main/app.ts src/main/modules/sync/client/auth.ts src/main/modules/sync/server/server/auth.ts src/main/modules/userApi/main.ts src/renderer/core/useApp/useDeeplink/index.ts src/renderer/utils/musicSdk/options.js src/renderer/views/Setting/components/SettingOther.vue src/renderer/worker/main/music.ts
```

Expected: identity tests PASS and ESLint exits 0.

- [ ] **Step 7: Commit the runtime identity switch**

```powershell
git add scripts/test-project-identity.js src/common/constants.ts src/common/constants_sync.ts src/common/defaultSetting.ts src/main/app.ts src/main/modules/sync/client/auth.ts src/main/modules/sync/server/server/auth.ts src/main/modules/userApi/main.ts src/renderer/core/useApp/useDeeplink/index.ts src/renderer/utils/musicSdk/options.js src/renderer/views/Setting/components/SettingOther.vue src/renderer/worker/main/music.ts
git commit -m "refactor: switch runtime protocol identities"
```

---

### Task 4: Export `.slxmc` and Import Both Backup Extensions

**Files:**
- Create: `src/common/backupFormats.js`
- Create: `src/common/backupFormats.d.ts`
- Create: `scripts/test-backup-formats.js`
- Modify: `src/common/utils/nodejs.ts:148-164`
- Modify: `src/renderer/views/Setting/components/SettingBackup.vue`
- Modify: `src/renderer/views/List/MyList/useShare.ts`
- Modify: `src/renderer/worker/main/list.ts:300-350`

- [ ] **Step 1: Write the failing backup-format test**

Create `scripts/test-backup-formats.js`:

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const {
  BACKUP_IMPORT_EXTENSIONS,
  BACKUP_NAMES,
  createPlaylistPartBackupName,
  createListTextName,
  createListCsvName,
  ensureBackupExportPath,
} = require('../src/common/backupFormats')

test('new exports use approved names and extension', () => {
  assert.deepEqual(BACKUP_NAMES, {
    allData: 'starky_datas_v2.slxmc',
    setting: 'starky_setting_v2.slxmc',
    playlist: 'starky_list.slxmc',
    playlistText: 'starky_list_all.txt',
    playlistCsv: 'starky_list_all.csv',
  })
  assert.equal(createPlaylistPartBackupName('Road Trip'), 'starky_list_part_Road Trip.slxmc')
  assert.equal(createListTextName('Road Trip'), 'starky_list_Road Trip.txt')
  assert.equal(createListCsvName('Road Trip'), 'starky_list_Road Trip.csv')
  assert.equal(ensureBackupExportPath('D:/backup/data'), 'D:/backup/data.slxmc')
  assert.equal(ensureBackupExportPath('D:/backup/data.SLXMC'), 'D:/backup/data.SLXMC')
  assert.equal(ensureBackupExportPath('D:/backup/data.lxmc'), 'D:/backup/data.lxmc.slxmc')
})

test('selectors retain JSON and accept new and legacy backup extensions', () => {
  assert.deepEqual(BACKUP_IMPORT_EXTENSIONS, ['json', 'slxmc', 'lxmc'])
})

test('backup UI and worker consume the shared helper', () => {
  for (const relativePath of [
    'src/common/utils/nodejs.ts',
    'src/renderer/views/Setting/components/SettingBackup.vue',
    'src/renderer/views/List/MyList/useShare.ts',
    'src/renderer/worker/main/list.ts',
  ]) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
    assert.match(source, /backupFormats/, relativePath)
    assert.doesNotMatch(source, /defaultPath:\s*['"`]lx_/, relativePath)
  }
})
```

- [ ] **Step 2: Run the backup test and verify the red state**

Run: `node --test scripts/test-backup-formats.js`

Expected: FAIL with `Cannot find module '../src/common/backupFormats'`.

- [ ] **Step 3: Add the backup-format helper and declaration**

Create `src/common/backupFormats.js`:

```js
const { PROJECT_IDENTITY } = require('./projectIdentity')

const LEGACY_BACKUP_EXTENSION = 'lxmc'
const BACKUP_IMPORT_EXTENSIONS = Object.freeze([
  'json',
  PROJECT_IDENTITY.backupExtension,
  LEGACY_BACKUP_EXTENSION,
])
const BACKUP_NAMES = Object.freeze({
  allData: PROJECT_IDENTITY.allDataBackupName,
  setting: PROJECT_IDENTITY.settingBackupName,
  playlist: PROJECT_IDENTITY.playlistBackupName,
  playlistText: 'starky_list_all.txt',
  playlistCsv: 'starky_list_all.csv',
})

const ensureBackupExportPath = filePath => filePath.toLowerCase().endsWith(`.${PROJECT_IDENTITY.backupExtension}`)
  ? filePath
  : `${filePath}.${PROJECT_IDENTITY.backupExtension}`
const createPlaylistPartBackupName = name => `starky_list_part_${name}.${PROJECT_IDENTITY.backupExtension}`
const createListTextName = name => `starky_list_${name}.txt`
const createListCsvName = name => `starky_list_${name}.csv`

module.exports = {
  LEGACY_BACKUP_EXTENSION,
  BACKUP_IMPORT_EXTENSIONS,
  BACKUP_NAMES,
  ensureBackupExportPath,
  createPlaylistPartBackupName,
  createListTextName,
  createListCsvName,
}
```

Create `src/common/backupFormats.d.ts`:

```ts
export const LEGACY_BACKUP_EXTENSION: string
export const BACKUP_IMPORT_EXTENSIONS: readonly string[]
export const BACKUP_NAMES: Readonly<{
  allData: string
  setting: string
  playlist: string
  playlistText: string
  playlistCsv: string
}>
export const ensureBackupExportPath: (filePath: string) => string
export const createPlaylistPartBackupName: (name: string) => string
export const createListTextName: (name: string) => string
export const createListCsvName: (name: string) => string
```

- [ ] **Step 4: Wire exports, selectors, and generated list names**

In `src/common/utils/nodejs.ts`, import `ensureBackupExportPath` and begin `saveLxConfigFile` with:

```ts
path = ensureBackupExportPath(path)
```

Do not branch the read/decompression logic by backup extension; JSON remains text and both compressed extensions use the existing binary path.

In `SettingBackup.vue`, import `BACKUP_IMPORT_EXTENSIONS` and `BACKUP_NAMES`, then use:

```js
{ name: 'Setting', extensions: [...BACKUP_IMPORT_EXTENSIONS] }
{ name: 'Play List', extensions: [...BACKUP_IMPORT_EXTENSIONS] }
defaultPath: BACKUP_NAMES.allData
defaultPath: BACKUP_NAMES.setting
defaultPath: BACKUP_NAMES.playlist
defaultPath: BACKUP_NAMES.playlistText
defaultPath: BACKUP_NAMES.playlistCsv
```

In `useShare.ts`, use `createPlaylistPartBackupName(filterFileName(listInfo.name))` and the same import-extension array.

In `src/renderer/worker/main/list.ts`, replace per-list text and CSV literals with:

```ts
createListTextName(filterFileName(list.name))
createListCsvName(filterFileName(list.name))
```

- [ ] **Step 5: Run backup tests and focused lint**

Run:

```powershell
node --test scripts/test-backup-formats.js
npx eslint -f node_modules/eslint-formatter-friendly src/common/backupFormats.js src/common/utils/nodejs.ts src/renderer/views/Setting/components/SettingBackup.vue src/renderer/views/List/MyList/useShare.ts src/renderer/worker/main/list.ts
```

Expected: all backup tests PASS and ESLint exits 0.

- [ ] **Step 6: Commit backup compatibility**

```powershell
git add src/common/backupFormats.js src/common/backupFormats.d.ts scripts/test-backup-formats.js src/common/utils/nodejs.ts src/renderer/views/Setting/components/SettingBackup.vue src/renderer/views/List/MyList/useShare.ts src/renderer/worker/main/list.ts
git commit -m "feat: introduce independent backup format"
```

---

### Task 5: Replace `message2call` with an Internal Sync RPC

**Files:**
- Create: `src/common/utils/syncRpc.js`
- Create: `src/common/utils/syncRpc.d.ts`
- Create: `scripts/test-sync-rpc.js`
- Modify: `src/main/modules/sync/client/client.ts`
- Modify: `src/main/modules/sync/server/server/server.ts`

- [ ] **Step 1: Write the failing RPC contract tests**

Create `scripts/test-sync-rpc.js`:

```js
const assert = require('node:assert/strict')
const test = require('node:test')
const { createSyncRpc } = require('../src/common/utils/syncRpc')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const createPair = ({ leftFuncs = {}, rightFuncs = {}, timeout = 100 } = {}) => {
  let left
  let right
  const leftSocket = { side: 'left' }
  const rightSocket = { side: 'right' }
  left = createSyncRpc({
    funcsObj: leftFuncs,
    timeout,
    onCallBeforeParams: args => [leftSocket, ...args],
    sendMessage: data => setImmediate(() => right.message(JSON.parse(JSON.stringify(data)))),
  })
  right = createSyncRpc({
    funcsObj: rightFuncs,
    timeout,
    onCallBeforeParams: args => [rightSocket, ...args],
    sendMessage: data => setImmediate(() => left.message(JSON.parse(JSON.stringify(data)))),
  })
  return { left, right, leftSocket, rightSocket }
}

test('returns sync and async nested values through real JSON round trips', async t => {
  const pair = createPair({
    rightFuncs: {
      math: {
        add(socket, left, right) {
          assert.equal(socket, pair.rightSocket)
          return left + right
        },
        async double(socket, value) {
          assert.equal(socket.side, 'right')
          await delay(2)
          return value * 2
        },
      },
    },
  })
  t.after(() => { pair.left.destroy(); pair.right.destroy() })
  assert.equal(await pair.left.remote.math.add(2, 3), 5)
  assert.equal(await pair.left.remote.math.double(4), 8)
})

test('serializes remote errors and rejects unknown or non-function paths', async t => {
  const pair = createPair({
    rightFuncs: {
      value: 1,
      fail() {
        const error = new TypeError('remote failure')
        throw error
      },
    },
  })
  t.after(() => { pair.left.destroy(); pair.right.destroy() })
  await assert.rejects(pair.left.remote.fail(), error => error.name == 'TypeError' && error.message == 'remote failure')
  await assert.rejects(pair.left.remote.missing(), /Unknown RPC path/)
  await assert.rejects(pair.left.remote.value(), /not a function/)
})

test('a timed out queued call releases the next call', async t => {
  let callCount = 0
  const pair = createPair({
    timeout: 25,
    rightFuncs: {
      async work(socket) {
        callCount++
        if (callCount == 1) return new Promise(() => {})
        return 'recovered'
      },
    },
  })
  t.after(() => { pair.left.destroy(); pair.right.destroy() })
  const queue = pair.left.createQueueRemote('list')
  await assert.rejects(queue.work(), /timeout/)
  assert.equal(await queue.work(), 'recovered')
})

test('same-group calls are FIFO while different groups run concurrently', async t => {
  const events = []
  const pair = createPair({
    rightFuncs: {
      async work(socket, name, ms) {
        events.push(`start:${name}`)
        await delay(ms)
        events.push(`end:${name}`)
        return name
      },
    },
  })
  t.after(() => { pair.left.destroy(); pair.right.destroy() })
  const list = pair.left.createQueueRemote('list')
  const dislike = pair.left.createQueueRemote('dislike')
  const calls = [list.work('a', 20), list.work('b', 1), dislike.work('c', 1)]
  assert.deepEqual(await Promise.all(calls), ['a', 'b', 'c'])
  assert.ok(events.indexOf('start:c') < events.indexOf('end:a'))
  assert.ok(events.indexOf('start:b') > events.indexOf('end:a'))
})

test('destroy rejects in-flight, queued, and future calls', async() => {
  const pair = createPair({
    rightFuncs: { wait: () => new Promise(() => {}) },
  })
  const queue = pair.left.createQueueRemote('userApi')
  const inFlight = queue.wait()
  const queued = queue.wait()
  await delay(2)
  pair.left.destroy()
  await assert.rejects(inFlight, /destroyed/)
  await assert.rejects(queued, /destroyed/)
  await assert.rejects(pair.left.remote.wait(), /destroyed/)
  pair.right.destroy()
})
```

- [ ] **Step 2: Run the RPC tests and verify the red state**

Run: `node --test scripts/test-sync-rpc.js`

Expected: FAIL with `Cannot find module '../src/common/utils/syncRpc'`.

- [ ] **Step 3: Implement the JSON RPC transport**

Create `src/common/utils/syncRpc.js`:

```js
const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

const toError = value => value instanceof Error ? value : new Error(String(value))
const serializeError = error => ({
  name: typeof error?.name == 'string' ? error.name : 'Error',
  message: typeof error?.message == 'string' ? error.message : String(error),
})
const deserializeError = value => {
  const error = new Error(typeof value?.message == 'string' ? value.message : 'Remote RPC error')
  error.name = typeof value?.name == 'string' ? value.name : 'Error'
  return error
}

const createSyncRpc = ({
  funcsObj,
  timeout = 30_000,
  sendMessage,
  onCallBeforeParams = args => args,
  onError = () => {},
}) => {
  let destroyed = false
  let nextId = 0
  const pending = new Map()
  const queues = new Map()

  const reportError = (error, path = [], group = null) => {
    try { onError(toError(error), path, group) } catch {}
  }

  const settlePending = (id, handler) => {
    const entry = pending.get(id)
    if (!entry) return false
    pending.delete(id)
    clearTimeout(entry.timer)
    handler(entry)
    return true
  }

  const send = (data, onSendError) => {
    try {
      const result = sendMessage(data)
      if (result && typeof result.then == 'function') {
        void result.catch(error => onSendError(toError(error)))
      }
    } catch (error) {
      onSendError(toError(error))
    }
  }

  const callRemote = (path, args, group) => {
    if (destroyed) return Promise.reject(new Error('Sync RPC destroyed'))
    return new Promise((resolve, reject) => {
      const id = `${Date.now().toString(36)}-${++nextId}`
      const timer = setTimeout(() => {
        settlePending(id, entry => entry.reject(new Error(`Sync RPC timeout: ${path.join('.')}`)))
      }, Math.max(1, timeout))
      pending.set(id, { resolve, reject, timer })
      send({ type: 'call', id, path, args, group }, error => {
        settlePending(id, entry => entry.reject(error))
      })
    })
  }

  const drainQueue = group => {
    const state = queues.get(group)
    if (!state || state.active || destroyed) return
    const job = state.items.shift()
    if (!job) {
      queues.delete(group)
      return
    }
    state.active = true
    void callRemote(job.path, job.args, group).then(job.resolve, job.reject).finally(() => {
      state.active = false
      drainQueue(group)
    })
  }

  const queueRemoteCall = (group, path, args) => {
    if (destroyed) return Promise.reject(new Error('Sync RPC destroyed'))
    return new Promise((resolve, reject) => {
      let state = queues.get(group)
      if (!state) {
        state = { active: false, items: [] }
        queues.set(group, state)
      }
      state.items.push({ path, args, resolve, reject })
      drainQueue(group)
    })
  }

  const createRemote = (path = [], group = null) => new Proxy(() => {}, {
    get(...handlerArgs) {
      const property = handlerArgs[1]
      if (property == 'then' && !path.length) return undefined
      if (typeof property != 'string') return undefined
      return createRemote([...path, property], group)
    },
    apply(...handlerArgs) {
      const args = handlerArgs[2]
      return group == null ? callRemote(path, args, null) : queueRemoteCall(group, path, args)
    },
  })

  const resolveFunction = path => {
    if (!Array.isArray(path) || !path.length || path.some(part => typeof part != 'string' || !part || BLOCKED_PATH_SEGMENTS.has(part))) {
      throw new Error('Unknown RPC path')
    }
    let parent = null
    let target = funcsObj
    for (const part of path) {
      if (target == null || !Object.prototype.hasOwnProperty.call(target, part)) {
        throw new Error(`Unknown RPC path: ${path.join('.')}`)
      }
      parent = target
      target = target[part]
    }
    if (typeof target != 'function') throw new Error(`RPC path is not a function: ${path.join('.')}`)
    return { parent, target }
  }

  const handleCall = async data => {
    const path = Array.isArray(data.path) ? data.path : []
    const group = typeof data.group == 'string' ? data.group : null
    try {
      if (typeof data.id != 'string' || !Array.isArray(data.args)) throw new Error('Invalid RPC call')
      const { parent, target } = resolveFunction(path)
      const args = await onCallBeforeParams(data.args)
      if (!Array.isArray(args)) throw new Error('RPC parameter hook must return an array')
      const result = await target.apply(parent, args)
      send({ type: 'result', id: data.id, data: result }, error => reportError(error, path, group))
    } catch (error) {
      reportError(error, path, group)
      if (typeof data.id == 'string') {
        send({ type: 'error', id: data.id, error: serializeError(error) }, sendError => reportError(sendError, path, group))
      }
    }
  }

  const message = data => {
    if (destroyed || !data || typeof data != 'object') return
    switch (data.type) {
      case 'call':
        void handleCall(data)
        break
      case 'result':
        if (typeof data.id == 'string') settlePending(data.id, entry => entry.resolve(data.data))
        break
      case 'error':
        if (typeof data.id == 'string') settlePending(data.id, entry => entry.reject(deserializeError(data.error)))
        break
    }
  }

  const destroy = () => {
    if (destroyed) return
    destroyed = true
    const error = new Error('Sync RPC destroyed')
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
    for (const state of queues.values()) {
      for (const job of state.items.splice(0)) job.reject(error)
    }
    queues.clear()
  }

  return {
    remote: createRemote(),
    createQueueRemote: group => createRemote([], group),
    message,
    destroy,
  }
}

module.exports = { createSyncRpc }
```

- [ ] **Step 4: Add RPC declarations**

Create `src/common/utils/syncRpc.d.ts`:

```ts
type RemoteValue<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : T extends object
    ? { [K in keyof T]: RemoteValue<T[K]> }
    : never

export interface SyncRpcOptions {
  funcsObj: Record<string, unknown>
  timeout?: number
  sendMessage: (data: Record<string, unknown>) => void | Promise<void>
  onCallBeforeParams?: (rawArgs: unknown[]) => unknown[] | Promise<unknown[]>
  onError?: (error: Error, path: string[], groupName: string | null) => void
}

export interface SyncRpc<TRemote> {
  remote: RemoteValue<TRemote>
  createQueueRemote: <TGroup = TRemote>(groupName: string) => RemoteValue<TGroup>
  message: (data: unknown) => void
  destroy: () => void
}

export const createSyncRpc: <TRemote = Record<string, unknown>>(options: SyncRpcOptions) => SyncRpc<TRemote>
```

- [ ] **Step 5: Switch both WebSocket endpoints to `createSyncRpc`**

In both sync endpoint files, replace:

```ts
import { createMsg2call } from 'message2call'
```

with:

```ts
import { createSyncRpc } from '@common/utils/syncRpc'
```

Rename the local wrapper variables for clarity. Do not edit the existing `funcsObj`, `timeout`, `sendMessage`, `onCallBeforeParams`, or `onError` callback bodies; only change the constructor name, local wrapper name, and calls on that wrapper. The client-side assignments must be:

```ts
client.remote = syncRpc.remote
client.remoteQueueList = syncRpc.createQueueRemote('list')
client.remoteQueueDislike = syncRpc.createQueueRemote('dislike')
client.remoteQueueParty = syncRpc.createQueueRemote('party')
client.remoteQueueUserApi = syncRpc.createQueueRemote('userApi')
// pass decrypted parsed messages to syncRpc.message(data)
// call syncRpc.destroy() on close
```

Use `LX.Sync.ClientSyncActions` and the existing `list`, `dislike`, and `userApi` groups on the server side. Do not alter encryption, WebSocket lifecycle, reconnect, close, or sync-module behavior.

- [ ] **Step 6: Run RPC tests and focused lint**

Run:

```powershell
node --test scripts/test-sync-rpc.js
npx eslint -f node_modules/eslint-formatter-friendly src/common/utils/syncRpc.js src/main/modules/sync/client/client.ts src/main/modules/sync/server/server/server.ts
```

Expected: all five RPC tests PASS and ESLint exits 0.

- [ ] **Step 7: Commit the internal RPC**

```powershell
git add src/common/utils/syncRpc.js src/common/utils/syncRpc.d.ts scripts/test-sync-rpc.js src/main/modules/sync/client/client.ts src/main/modules/sync/server/server/server.ts
git commit -m "refactor: replace sync rpc dependency"
```

---

### Task 6: Replace Forked Dependencies with Official npm Releases

**Files:**
- Create: `scripts/test-upstream-detachment.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/main/index-dev.ts`

- [ ] **Step 1: Add failing dependency assertions**

Create `scripts/test-upstream-detachment.js` with the first audit block:

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const pkg = require('../package.json')
const lockText = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')

test('direct dependencies use approved official npm releases', () => {
  assert.equal(pkg.devDependencies['electron-devtools-installer'], '^4.0.0')
  assert.equal(pkg.devDependencies['eslint-formatter-friendly'], '^7.0.0')
  assert.equal(pkg.devDependencies.spinnies, '^0.5.1')
  assert.equal(pkg.devDependencies['webpack-hot-middleware'], '^2.26.1')
  assert.equal(pkg.dependencies.needle, '^3.5.0')
  assert.equal(Object.hasOwn(pkg.dependencies, 'message2call'), false)
  assert.doesNotMatch(lockText, /github(?:\.com)?:lyswhut|github\.com\/lyswhut/i)
})
```

- [ ] **Step 2: Run the audit and verify the red state**

Run: `node --test scripts/test-upstream-detachment.js`

Expected: FAIL on the first forked dependency version.

- [ ] **Step 3: Install official packages and remove `message2call`**

Run:

```powershell
npm install --save-dev electron-devtools-installer@^4.0.0 eslint-formatter-friendly@^7.0.0 spinnies@^0.5.1 webpack-hot-middleware@^2.26.1
npm install --save needle@^3.5.0
npm uninstall message2call
```

Expected: npm exits 0, updates both package files, and leaves the installed official modules in `node_modules/`.

- [ ] **Step 4: Adapt the official devtools export**

In `src/main/index-dev.ts`, use the v4 named export and returned extension object:

```ts
import { installExtension, VUEJS_DEVTOOLS } from 'electron-devtools-installer'

// In both installation handlers:
installExtension(VUEJS_DEVTOOLS, { session: win.webContents.session })
  .then(extension => {
    console.log(`[main window] Added Extension: ${extension.name}`)
  })
```

Use `[lyric window]` in the lyric handler. The other four official packages retain the CommonJS/default call shapes already used by the project.

- [ ] **Step 5: Run dependency audit and compilation checks**

Run:

```powershell
node --test scripts/test-upstream-detachment.js
npm run build:main
npm run lint
```

Expected: the dependency audit PASSes, the main bundle builds, and lint exits 0.

- [ ] **Step 6: Commit dependency replacement**

```powershell
git add package.json package-lock.json src/main/index-dev.ts scripts/test-upstream-detachment.js
git commit -m "build: replace upstream fork dependencies"
```

---

### Task 7: Remove Application Auto-Update and Changelog UI End to End

**Files:**
- Create: `scripts/test-updater-removal.js`
- Delete: `src/main/modules/winMain/autoUpdate.ts`
- Delete: `src/renderer/core/useApp/useUpdate.ts`
- Delete: `src/renderer/components/layout/UpdateModal.vue`
- Delete: `src/renderer/components/layout/ChangeLogModal.vue`
- Delete: `src/renderer/utils/update.js`
- Modify: `src/main/modules/winMain/index.ts`
- Modify: `src/renderer/core/useApp/index.ts`
- Modify: `src/renderer/App.vue`
- Modify: `src/renderer/components/layout/PactModal.vue`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/renderer/store/index.ts`
- Modify: `src/common/defaultSetting.ts`
- Modify: `src/common/types/app_setting.d.ts`
- Modify: `src/common/types/common.d.ts`
- Modify: `src/common/constants.ts`
- Modify: `src/lang/en-us.json`
- Modify: `src/lang/zh-cn.json`
- Modify: `src/lang/zh-tw.json`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write a failing complete-removal test**

Create `scripts/test-updater-removal.js`:

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const deletedFiles = [
  'src/main/modules/winMain/autoUpdate.ts',
  'src/renderer/core/useApp/useUpdate.ts',
  'src/renderer/components/layout/UpdateModal.vue',
  'src/renderer/components/layout/ChangeLogModal.vue',
  'src/renderer/utils/update.js',
]
const inspectedFiles = [
  'src/main/modules/winMain/index.ts',
  'src/renderer/core/useApp/index.ts',
  'src/renderer/App.vue',
  'src/renderer/components/layout/PactModal.vue',
  'src/renderer/utils/ipc.ts',
  'src/common/ipcNames.ts',
  'src/renderer/store/index.ts',
  'src/common/defaultSetting.ts',
  'src/common/types/app_setting.d.ts',
  'src/common/types/common.d.ts',
  'src/common/constants.ts',
]

test('application updater files and wiring are absent', () => {
  for (const file of deletedFiles) assert.equal(fs.existsSync(path.join(root, file)), false, file)
  const source = inspectedFiles.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n')
  for (const pattern of [
    /electron-updater/,
    /initUpdate/,
    /useUpdate/,
    /checkUpdate/,
    /UpdateModal/,
    /ChangeLogModal/,
    /versionInfo/,
    /isShowChangeLog/,
    /tryAutoUpdate/,
    /showChangeLog/,
    /ignoreVersion/,
    /lastStartInfo/,
    /update_(?:check|available|error|progress|downloaded|not_available)/,
  ]) assert.doesNotMatch(source, pattern)
})

test('application update translations and dependency are absent', () => {
  const pkg = require('../package.json')
  assert.equal(Object.hasOwn(pkg.devDependencies, 'electron-updater'), false)
  for (const locale of ['en-us', 'zh-cn', 'zh-tw']) {
    const messages = JSON.parse(fs.readFileSync(path.join(root, `src/lang/${locale}.json`), 'utf8'))
    const staleKeys = Object.keys(messages).filter(key => key.startsWith('update__') || key.startsWith('setting__update_'))
    assert.deepEqual(staleKeys, [], locale)
  }
})
```

- [ ] **Step 2: Run the updater-removal test and verify the red state**

Run: `node --test scripts/test-updater-removal.js`

Expected: FAIL because all five updater files still exist.

- [ ] **Step 3: Remove the main and renderer update chain**

Delete the five files listed above. Then make these exact call-site changes:

```ts
// src/main/modules/winMain/index.ts
// Remove the autoUpdate import and initUpdate() call; retain initRendererEvent().

// src/renderer/core/useApp/index.ts
// Remove checkUpdate and useUpdate imports, useUpdate(), and the final checkUpdate() call.
// Keep handleListAutoUpdate(); it updates user lists, not the application.

// src/renderer/App.vue
// Remove only <layout-change-log-modal /> and <layout-update-modal />.
```

In `PactModal.vue`, remove `checkUpdate` from the IPC import and change the acceptance dialog to stop after it is acknowledged:

```js
void this.$dialog({
  message: Buffer.from('e69cace8bdafe4bbb6e5ae8ce585a8e5858de8b4b9e4b894e5bc80e6ba90efbc8ce5a682e69e9ce4bda0e698afe88ab1e992b1e8b4ade4b9b0e79a84efbc8ce8afb7e79bb4e68ea5e7bb99e5b7aee8af84efbc810a0a5468697320736f667477617265206973206672656520616e64206f70656e20736f757263652e', 'hex').toString(),
  confirmButtonText: Buffer.from('e5a5bde79a8420284f4b29', 'hex').toString(),
})
```

- [ ] **Step 4: Remove updater IPC, state, settings, data keys, and types**

Apply all of the following mechanical removals:

- From `src/renderer/utils/ipc.ts`, remove the `electron-updater` type import; `checkUpdate`, `downloadUpdate`, `quitUpdate`; all five `onUpdate*` functions; `saveLastStartInfo`, `getLastStartInfo`, `saveIgnoreVersion`, and `getIgnoreVersion`.
- From `src/common/ipcNames.ts`, remove `quit_update`, `update_check`, `update_download_update`, `update_available`, `update_error`, `update_progress`, `update_downloaded`, and `update_not_available`.
- From `src/renderer/store/index.ts`, remove the `ProgressInfo` import, `versionInfo`, and `isShowChangeLog`; retain `process.versions.app = pkg.version` and any unrelated package-version use.
- From `src/common/defaultSetting.ts`, remove `common.tryAutoUpdate` and `common.showChangeLog`.
- From `src/common/types/app_setting.d.ts`, remove the matching two fields and comments.
- From `src/common/types/common.d.ts`, remove `UpdateStatus` and `VersionInfo`.
- From `src/common/constants.ts`, remove `DATA_KEYS.ignoreVersion` and `DATA_KEYS.lastStartInfo`.

- [ ] **Step 5: Remove updater translations and dependency**

Parse each locale JSON and remove keys whose names begin with `update__` or `setting__update_`, preserving valid JSON and every unrelated translation. Then run:

```powershell
npm uninstall electron-updater
```

Expected: `electron-updater` is absent from `package.json`, `package-lock.json`, and `node_modules/`.

- [ ] **Step 6: Run updater-removal tests, lint, and build**

Run:

```powershell
node --test scripts/test-updater-removal.js
npm run lint
npm run build
```

Expected: updater tests PASS, lint exits 0, and all four webpack bundles build successfully.

- [ ] **Step 7: Commit updater removal**

```powershell
git add -A package.json package-lock.json src scripts/test-updater-removal.js
git commit -m "refactor: remove application auto update"
```

---

### Task 8: Rewrite Current Documentation, Support Links, Workflows, and Attribution

**Files:**
- Create: `UPSTREAM.md`
- Rewrite: `README.md`
- Delete: `FAQ.md`
- Delete: `CHANGELOG.md`
- Delete: `.github/workflows/publish-version-info.yml`
- Delete: `publish/changeLog.md`
- Delete: `publish/index.js`
- Delete: `publish/version.json`
- Delete: every tracked file under `publish/utils/`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/ISSUE_TEMPLATE/bug.yml`
- Modify: `.github/ISSUE_TEMPLATE/feature.yml`
- Modify: `.github/workflows/beta-pack.yml`
- Modify: `.vscode/javascript.code-snippets`
- Modify: `.vscode/typescript.code-snippets`
- Modify: `doc/MOBILE_PORTING_CHANGES.md`
- Modify: `docs/superpowers/plans/2026-07-11-play-detail-refinement.md`
- Modify: `docs/superpowers/plans/2026-07-25-play-detail-vinyl-progress.md`
- Modify: `docs/superpowers/plans/2026-07-25-qq-personalized-home.md`
- Modify: `src/renderer/views/Setting/components/SettingAbout.vue`
- Modify: `src/renderer/components/layout/PactModal.vue`
- Modify: `src/renderer/views/Setting/components/UserApiModal.vue`
- Modify: `src/renderer/views/Setting/components/SettingSync/index.vue`
- Modify: `src/renderer/views/Setting/components/SettingOpenAPI.vue`
- Modify: `src/renderer/views/songList/List/components/OpenListModal.vue`
- Modify: `build-config/build-before-pack.js`
- Modify: `src/common/utils/electron.ts`
- Modify: `src/common/utils/lyric-font-player/line-player.js`
- Modify: `src/common/utils/lyricUtils/kg.js`
- Modify: `src/main/app.ts`
- Modify: `src/renderer/event/keyEvent.ts`
- Modify: `src/renderer/utils/musicSdk/mg/utils/mrc.js`
- Modify: `src/renderer/utils/musicSdk/wy/lyric.js`
- Modify: `src/renderer-lyric/components/layout/useDrag.js`
- Modify: `src/renderer-lyric/components/layout/LyricVertical/useLyric.js`

- [ ] **Step 1: Expand the audit with failing documentation and endpoint assertions**

Append to `scripts/test-upstream-detachment.js`:

```js
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
  assert.match(read('README.md'), new RegExp(currentUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(read('UPSTREAM.md'), /lyswhut\/lx-music-desktop/)
  for (const file of ['.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/feature.yml']) {
    const source = read(file)
    assert.match(source, /starkyYourEyes\/lx-music-desktop/)
    assert.doesNotMatch(source, /lyswhut\.github|github\.com\/lyswhut/)
  }
})
```

- [ ] **Step 2: Run the expanded audit and verify it fails**

Run: `node --test scripts/test-upstream-detachment.js`

Expected: FAIL because `FAQ.md`, `CHANGELOG.md`, `publish/`, the workflow, and `UPSTREAM.md` are in the old state.

- [ ] **Step 3: Rewrite README and add explicit attribution**

Replace `README.md` with this project-owned structure and content, retaining the two local screenshots:

```markdown
# LX Music Desktop

本仓库是由 `starkyYourEyes` 维护的 LX Music 桌面定制版。显示名称和现有图标继续使用 LX Music，技术标识、发布目标、数据目录、深链、同步身份与备份扩展名由本仓库独立维护。

## 当前功能

- 本地音乐、在线源、自定义源、歌单与桌面歌词。
- WebDAV 音乐与本地音乐上传。
- 账号推荐、私人 FM、每日推荐和歌单管理。
- 桌面端同步服务与一起听功能。
- Windows、macOS 与 Linux 构建配置。

## 下载与反馈

- Releases: <https://github.com/starkyYourEyes/lx-music-desktop/releases>
- Issues: <https://github.com/starkyYourEyes/lx-music-desktop/issues>

本项目没有内置应用更新检查。请从本仓库 Releases 获取新版本，并在提交问题前搜索现有 Issues。

## 数据与兼容性

- 安装版首次使用新技术标识时，会把旧安装目录中的用户数据复制到新目录；旧目录不会被删除或覆盖。
- 便携版继续使用程序旁的 `portable/userData`。
- 新备份使用 `.slxmc`；导入同时接受 `.slxmc`、旧 `.lxmc` 和已有 JSON 备份。
- 新深链格式为 `starkylx://music/play` 或 `starkylx://music/search/...`，不兼容旧深链。
- 桌面同步只接受当前版本使用的新桌面端和移动端身份。

## 使用入口

- 自定义源：在“设置 -> 基本设置 -> 自定义源”导入本地 JavaScript 源文件或在线源。
- 数据同步：在“设置 -> 数据同步”选择服务端或客户端模式，并按界面显示的地址和认证码连接。
- 开放 API：在“设置 -> 开放 API”启用服务、设置端口，并仅在可信网络中开放局域网访问。
- WebDAV：在“设置 -> 其他”配置地址、用户名和密码。

## 开发

```powershell
npm install
npm run dev
npm run lint
npm run build
npm run pack:dir
```

项目要求 Node.js 22 或更新版本。打包产物写入 `build/`，编译结果写入 `dist/`。

## 界面

![推荐界面](./doc/images/recommendation.png)

![我的列表界面](./doc/images/my_list.png)

## 许可证与来源

代码继续按 [Apache License 2.0](./LICENSE) 发布，应用内补充协议与第三方许可证保留在 [`licenses/`](./licenses/) 目录。

本项目基于 [lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) v2.12.1，感谢原作者及贡献者。基线之后的修改和发布由当前维护者负责，详细说明见 [UPSTREAM.md](./UPSTREAM.md)。
```

Create `UPSTREAM.md`:

```markdown
# Upstream Attribution

This repository is derived from [lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop), using upstream version v2.12.1 as its base.

The upstream project and its contributors retain attribution for the original work. The code remains distributed under Apache License 2.0, together with the supplemental agreements and third-party license files retained in this repository.

Changes made after the v2.12.1 base, current release artifacts, support channels, and maintenance decisions are the responsibility of `starkyYourEyes` and are not releases of the upstream project.
```

- [ ] **Step 4: Delete obsolete release and documentation machinery**

Delete `FAQ.md`, `CHANGELOG.md`, `.github/workflows/publish-version-info.yml`, and all tracked files under `publish/`. Remove only the root package script:

```json
"publish": "node publish"
```

Keep every `publish:<platform>` script because electron-builder still publishes artifacts to the repository that triggered the release workflow. Remove the now-unused parser with:

```powershell
npm uninstall --save-dev changelog-parser
```

- [ ] **Step 5: Point user-facing links to the current repository**

Import `PROJECT_IDENTITY` where a script section can consume it, expose it to templates as `projectIdentity`, and use these mappings:

```text
Repository/help/custom-source/sync/open-API/song-list help -> PROJECT_IDENTITY.repositoryUrl + '#readme'
Issue reporting/search                                -> PROJECT_IDENTITY.issuesUrl
Release downloads                                     -> PROJECT_IDENTITY.releasesUrl
License/online agreement                              -> PROJECT_IDENTITY.repositoryUrl + '#许可证与来源'
```

In `SettingAbout.vue`, change the displayed author to `starkyYourEyes`. In `PactModal.vue`, change only the GitHub target in clause 6.1; retain all agreement language. Update both issue templates to link this README and this repository's issue search.

- [ ] **Step 6: Update workflow artifact names, snippets, and historical artifact references**

In `.github/workflows/beta-pack.yml`, replace every artifact `name: lx-music-desktop-...` prefix with `name: starky-lx-music-desktop-...`; wildcard paths remain valid because builder uses the new product name.

In both `.vscode/*code-snippets`, replace the workspace comment name with `starky-lx-music-desktop`.

In `doc/MOBILE_PORTING_CHANGES.md` and the three listed historical plans, replace build artifact and process examples:

```text
build/lx-music-desktop-...       -> build/starky-lx-music-desktop-...
Get-Process 'lx-music-desktop'   -> Get-Process 'starky-lx-music-desktop'
`lx-music-desktop` process       -> `starky-lx-music-desktop` process
```

Keep the v2.12.1 upstream-baseline sentence in `doc/MOBILE_PORTING_CHANGES.md`; it is historical attribution, not runtime configuration.

- [ ] **Step 7: Replace upstream issue URLs in source comments with local rationale**

Use these comments at the existing code locations, without changing behavior:

```text
build-before-pack.js                  Native SQLite binaries must match Electron ABI and target architecture.
common/utils/electron.ts              Encode percent and hash so local file URLs preserve literal path characters.
line-player.js                        Ignore marker-only lyric lines.
lyricUtils/kg.js                      Decode the provider's KRC payload with its fixed XOR key.
main/app.ts                           Disable spell-check dictionary downloads.
renderer/event/keyEvent.ts            When tray mode is enabled, the minimize hotkey hides the window.
musicSdk/mg/utils/mrc.js              Clamp decoded signed 64-bit lyric timestamps.
musicSdk/wy/lyric.js                  Normalize malformed minute-second-centisecond labels.
renderer-lyric useDrag.js             Windows requires resize to be disabled while moving the lyric window.
LyricVertical/useLyric.js             Windows requires resize to be disabled while moving the lyric window.
```

- [ ] **Step 8: Run documentation audit and JSON/YAML-adjacent checks**

Run:

```powershell
node --test scripts/test-upstream-detachment.js
node -e "for (const f of ['src/lang/en-us.json','src/lang/zh-cn.json','src/lang/zh-tw.json','.vscode/javascript.code-snippets','.vscode/typescript.code-snippets']) JSON.parse(require('fs').readFileSync(f, 'utf8')); console.log('JSON valid')"
npm run lint
```

Expected: the expanded audit PASSes, JSON parsing prints `JSON valid`, and lint exits 0.

- [ ] **Step 9: Commit documentation and attribution**

```powershell
git add -A README.md UPSTREAM.md FAQ.md CHANGELOG.md publish .github .vscode doc docs/superpowers/plans package.json package-lock.json src build-config/build-before-pack.js scripts/test-upstream-detachment.js
git commit -m "docs: establish current project ownership"
```

---

### Task 9: Enforce Repository-Wide Upstream Detachment

**Files:**
- Modify: `scripts/test-upstream-detachment.js`
- Modify: any non-allowlisted tracked text file identified by the audit

- [ ] **Step 1: Add the full allowlisted repository audit**

Append to `scripts/test-upstream-detachment.js`:

```js
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
        if (!buffer.includes(0)) files.push({
          path: path.relative(root, fullPath).replace(/\\/g, '/'),
          text: buffer.toString('utf8'),
        })
      }
    }
  }
  visit(directory)
  return files
}

test('upstream author and URL appear only in attribution and migration records', () => {
  const allowed = [
    /^LICENSE$/,
    /^licenses\//,
    /^README\.md$/,
    /^UPSTREAM\.md$/,
    /^docs\/superpowers\/(?:specs|plans)\//,
    /^doc\/MOBILE_PORTING_CHANGES\.md$/,
    /^scripts\/test-(?:upstream-detachment|legacy-user-data-migration)\.js$/,
    /^src\/main\/migration\/legacyUserData\.js$/,
  ]
  const violations = walkTextFiles(root).filter(file =>
    /lyswhut|github\.com\/lyswhut|lyswhut\.github\.io/i.test(file.text) &&
    !allowed.some(pattern => pattern.test(file.path)),
  )
  assert.deepEqual(violations.map(file => file.path), [])
})

test('old runtime identifiers are isolated from production configuration', () => {
  const productionRoots = ['src', 'build-config', '.github']
  const production = productionRoots.flatMap(relativePath => walkTextFiles(path.join(root, relativePath)))
    .filter(file => file.path != 'src/main/migration/legacyUserData.js')
  const forbidden = [
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
  const violations = []
  for (const file of production) {
    for (const pattern of forbidden) if (pattern.test(file.text)) violations.push(`${file.path}: ${pattern}`)
  }
  assert.deepEqual(violations, [])
})

test('legacy backup extension is isolated to compatibility code and records', () => {
  const allowed = [
    /^src\/common\/backupFormats\.js$/,
    /^scripts\/test-(?:backup-formats|upstream-detachment)\.js$/,
    /^README\.md$/,
    /^docs\/superpowers\/(?:specs|plans)\//,
  ]
  const violations = walkTextFiles(root).filter(file =>
    /\.lxmc\b/.test(file.text) && !allowed.some(pattern => pattern.test(file.path)),
  )
  assert.deepEqual(violations.map(file => file.path), [])
})

test('removed updater and release sources cannot be reintroduced', () => {
  const allText = walkTextFiles(root)
    .filter(file => !/^docs\/superpowers\//.test(file.path))
    .map(file => file.text)
    .join('\n')
  for (const pattern of [
    /electron-updater/,
    /github:lyswhut/,
    /git\+ssh:\/\/git@github\.com\/lyswhut/,
    /lx-music-desktop-version-info/,
  ]) assert.doesNotMatch(allText, pattern)
})
```

- [ ] **Step 2: Run the full audit and inspect every reported path**

Run: `node --test scripts/test-upstream-detachment.js`

Expected: FAIL only if a non-allowlisted coupling point was missed. For each reported path, either replace the old runtime/support value with `PROJECT_IDENTITY`, rewrite a URL-only implementation comment as local rationale, or add the path to the allowlist only when it is one of the explicitly permitted license, attribution, migration, or historical design records.

- [ ] **Step 3: Run direct search commands as an independent cross-check**

Run:

```powershell
rg --pcre2 -n --hidden --glob '!node_modules/**' --glob '!build/**' --glob '!dist/**' --glob '!.git/**' --glob '!.codegraph/**' --glob '!.claude/**' "lyswhut|github:lyswhut|lx-music-desktop-version-info|lxmusic://|(?<!starky_)\blx_music_desktop\b|(?<!starky_)\blx_music_mobile\b|cn\.toside\.music\.desktop|\.lxmc\b"
rg -n "LX\.|global\.lx|window\.lx|lxlyric|lxlrc" src | Select-Object -First 20
```

Expected: the first command reports only allowlisted attribution/migration/design/test locations. The second command still reports internal/API contracts, proving the approved LX naming was not mechanically removed.

- [ ] **Step 4: Run all new focused tests together**

Run:

```powershell
node --test scripts/test-project-identity.js scripts/test-legacy-user-data-migration.js scripts/test-backup-formats.js scripts/test-sync-rpc.js scripts/test-updater-removal.js scripts/test-upstream-detachment.js
```

Expected: all tests PASS with zero failures, cancellations, or skips.

- [ ] **Step 5: Commit the final guardrail fixes**

```powershell
git add scripts/test-upstream-detachment.js
git add -u
git commit -m "test: enforce upstream detachment boundaries"
```

---

### Task 10: Verify, Reconfigure Git Metadata, and Clean Generated State

**Files:**
- Remove after verification only: `build/`
- Remove after verification only: `dist/`
- Remove after verification only: `.codegraph/`
- Remove after verification only: three `.claude/worktrees/agent-*` worktrees that contain no work except untracked `.claude/` cache
- Git metadata: change `origin`, remove `starky`, prune stale worktree records

- [ ] **Step 1: Run every standalone script test**

Run:

```powershell
Get-ChildItem scripts -Filter 'test-*.js' | Sort-Object Name | ForEach-Object {
  node $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "Script test failed: $($_.Name)" }
}
```

Expected: every existing and new script test exits 0.

- [ ] **Step 2: Run lint and production build**

Run:

```powershell
npm run lint
npm run build
npm run test:main-bundle
```

Expected: lint exits 0, all webpack bundles build, and the main-bundle test PASSes.

- [ ] **Step 3: Build and test the unpacked packaged application**

Run:

```powershell
npm run pack:dir
npm run test:packaged-app
```

Expected: electron-builder creates `build/win-unpacked`, the packaged manifest name is `starky-lx-music-desktop`, ASAR integrity checks pass, and the main bundle test PASSes.

- [ ] **Step 4: Re-run focused tests and repository audits after packaging**

Run:

```powershell
node --test scripts/test-project-identity.js scripts/test-legacy-user-data-migration.js scripts/test-backup-formats.js scripts/test-sync-rpc.js scripts/test-updater-removal.js scripts/test-upstream-detachment.js
rg --pcre2 -n --hidden --glob '!node_modules/**' --glob '!build/**' --glob '!dist/**' --glob '!.git/**' --glob '!.codegraph/**' --glob '!.claude/**' "github:lyswhut|lx-music-desktop-version-info|lxmusic://|(?<!starky_)\blx_music_desktop\b|(?<!starky_)\blx_music_mobile\b|cn\.toside\.music\.desktop"
git diff --check
git status --short --branch
```

Expected: tests PASS; search has no non-allowlisted production matches; `git diff --check` is silent; status contains only intentional committed work plus generated ignored directories.

- [ ] **Step 5: Inspect and remove only the three approved Claude worktrees**

First verify each explicit worktree path and its contents:

```powershell
$projectRoot = (Resolve-Path '.').Path
$worktreeRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.claude\worktrees'))
$approvedWorktrees = @(
  'agent-a1efa33a',
  'agent-a9475173',
  'agent-ada340b4'
)
foreach ($name in $approvedWorktrees) {
  $target = [IO.Path]::GetFullPath((Join-Path $worktreeRoot $name))
  if ([IO.Path]::GetDirectoryName($target) -ne $worktreeRoot) { throw "Unsafe worktree path: $target" }
  git -C $target status --short
}
```

Expected: each worktree is clean except optional untracked `.claude/` cache entries. If any path contains a tracked modification or other untracked user file, stop and report it instead of removing that worktree.

After the inspection passes, run:

```powershell
foreach ($name in $approvedWorktrees) {
  $target = [IO.Path]::GetFullPath((Join-Path $worktreeRoot $name))
  git worktree remove --force $target
}
git worktree prune --dry-run
git worktree prune
git worktree list --porcelain
```

Expected: only the primary worktree and any unrelated user worktrees remain; stale `qq-music-login` metadata is pruned if present. No branch or commit is deleted.

- [ ] **Step 6: Point `origin` to the current repository without pushing**

Run:

```powershell
git remote set-url origin https://github.com/starkyYourEyes/lx-music-desktop.git
git remote remove starky
git fetch origin
git branch --set-upstream-to=origin/master master
git remote -v
git branch -vv
```

Expected: `origin` is the only project remote, fetch/push URLs both target `starkyYourEyes/lx-music-desktop`, and `master` tracks `origin/master`. Do not run `git push`.

- [ ] **Step 7: Remove generated directories only after all checks pass**

Run this boundary-checked PowerShell block:

```powershell
$projectRoot = (Resolve-Path '.').Path
foreach ($name in @('build', 'dist', '.codegraph')) {
  $target = [IO.Path]::GetFullPath((Join-Path $projectRoot $name))
  if ([IO.Path]::GetDirectoryName($target) -ne $projectRoot) { throw "Unsafe cleanup path: $target" }
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}
```

Expected: only the three named generated directories are removed. `node_modules/`, user data, source files, branches, commits, and tags remain.

- [ ] **Step 8: Perform the final clean-state review**

Run:

```powershell
@('build', 'dist', '.codegraph') | ForEach-Object {
  if (Test-Path -LiteralPath $_) { throw "Cleanup failed: $_" }
}
if (-not (Test-Path -LiteralPath 'node_modules')) { throw 'node_modules must be retained' }
git status --short --branch
git log --oneline -12
git tag --list | Measure-Object
git worktree list
```

Expected: generated directories are absent, `node_modules/` remains, the worktree is clean, the implementation commits are visible, tags still exist, and no approved user data or Git history was removed.
