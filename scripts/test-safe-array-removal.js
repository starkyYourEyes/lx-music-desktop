const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const commonPath = path.join(root, 'src/common/utils/common.ts')
const { arrRemove } = loadTsModule(commonPath)

const values = ['first', 'last']
assert.strictEqual(arrRemove(values, 'missing'), false)
assert.deepStrictEqual(values, ['first', 'last'])
assert.strictEqual(arrRemove(values, 'first'), true)
assert.deepStrictEqual(values, ['last'])

const vulnerableFiles = [
  'src/main/modules/sync/client/client.ts',
  'src/main/modules/sync/server/server/server.ts',
  'src/renderer-lyric/core/mainWindowChannel.ts',
  'src/main/modules/sync/server/modules/list/snapshotDataManage.ts',
  'src/main/modules/sync/server/modules/dislike/snapshotDataManage.ts',
  'src/main/modules/sync/server/modules/list/manage.ts',
  'src/main/modules/sync/server/modules/dislike/manage.ts',
  'src/main/modules/sync/server/modules/list/sync/sync.ts',
]

for (const relativePath of vulnerableFiles) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
  assert.doesNotMatch(
    source,
    /\.splice\([^\r\n]*(?:indexOf|findIndex)\(/,
    `${relativePath} should not splice with an unchecked lookup result`,
  )
}

const arrRemoveMock = (array, item) => {
  const index = array.indexOf(item)
  if (index < 0) return false
  array.splice(index, 1)
  return true
}
const snapshotMocks = {
  '@common/utils/common': { throttle: () => () => {}, arrRemove: arrRemoveMock },
  '../../../log': { __esModule: true, default: { info() {}, warn() {}, error() {} } },
  '../../user/data': { getUserConfig: () => ({ maxSnapshotNum: 10 }) },
  '../../../../../../common/constants_sync': {
    File: {
      listDir: 'list',
      listSnapshotDir: 'snapshots',
      listSnapshotInfoJSON: 'snapshot-info.json',
      dislikeDir: 'dislike',
      dislikeSnapshotDir: 'snapshots',
      dislikeSnapshotInfoJSON: 'snapshot-info.json',
    },
  },
  '../../utils': { checkAndCreateDirSync() {} },
}

const testSnapshotManager = async(relativePath) => {
  const { SnapshotDataManage } = loadTsModule(path.join(root, relativePath), snapshotMocks)
  const manager = new SnapshotDataManage({
    userDir: path.join(root, '__missing_snapshot_test_dir__'),
    userName: 'test',
  })
  manager.snapshotInfo = {
    latest: null,
    time: 0,
    list: [],
    clients: {
      stale: { snapshotKey: 'missing', lastSyncDate: 0 },
    },
  }
  manager.clientSnapshotKeys = ['other']

  await manager.updateDeviceSnapshotKey('stale', 'new')
  assert.deepStrictEqual(manager.clientSnapshotKeys, ['other', 'new'])

  manager.snapshotInfo.clients.stale.snapshotKey = 'missing-again'
  manager.removeSnapshotInfo('stale')
  assert.deepStrictEqual(manager.clientSnapshotKeys, ['other', 'new'])
}

const run = async() => {
  await testSnapshotManager('src/main/modules/sync/server/modules/list/snapshotDataManage.ts')
  await testSnapshotManager('src/main/modules/sync/server/modules/dislike/snapshotDataManage.ts')
}

run().then(() => {
  console.log('safe array removal tests passed')
}).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
