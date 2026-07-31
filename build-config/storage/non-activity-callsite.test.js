const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describe, it } = require('node:test')

const readFiles = files => files
  .map(file => fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8'))
  .join('\n')

describe('non-activity renderer callsites', () => {
  it('contains no generic data calls for Phase 2 domains', () => {
    const callers = readFiles([
      'src/renderer/utils/data.ts',
      'src/renderer/store/search/action.ts',
    ])
    const ipc = readFiles(['src/renderer/utils/ipc.ts'])
    const phase2Keys = /DATA_KEYS\.(viewPrevState|listScrollPosition|listPrevSelectId|listUpdateInfo|searchHistoryList|leaderboardSetting|songListSetting|searchSetting)/

    assert.doesNotMatch(
      callers,
      /from ['"]@renderer\/utils\/ipc['"]|from ['"]\.\/ipc['"]/,
    )
    assert.doesNotMatch(ipc, phase2Keys)
  })
})
