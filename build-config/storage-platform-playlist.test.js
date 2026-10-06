/* eslint-disable n/no-deprecated-api */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const typescript = require('typescript')

const previousLoader = require.extensions['.ts']
require.extensions['.ts'] = (mod, filename) => {
  mod._compile(typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText, filename)
}
const { parsePlaylistMetadataCommand } = require('../src/common/storage/stateValidation.ts')
require.extensions['.ts'] = previousLoader

const command = profile => ({
  version: 1,
  action: 'upsert',
  playlistId: 'platform:netease:42:created:100',
  value: { updateTime: 0, isAutoUpdate: false, profile },
  updatedAtMs: 100,
})
const managedProfile = {
  managed: true,
  provider: 'netease',
  kind: 'created',
  accountKey: '42',
  coverUrl: 'https://example.com/cover.jpg',
  lastSyncAt: 100,
}

test('accepts and preserves platform playlist metadata at the real storage boundary', () => {
  for (const provider of ['netease', 'qq_music', 'kugou']) {
    for (const kind of ['created', 'collected']) {
      const input = command({ ...managedProfile, provider, kind })
      const parsed = parsePlaylistMetadataCommand(input)
      assert.deepEqual(parsed, input)
      assert.notEqual(parsed.value.profile, input.value.profile)
    }
  }
})

test('accepts playlists without cover images and existing local playlist profiles', () => {
  const { coverUrl, ...withoutCover } = managedProfile
  for (const profile of [withoutCover, { ...managedProfile, coverUrl: '' }, {}, { description: '', group: 'mine', createdAt: 0 }]) {
    assert.deepEqual(parsePlaylistMetadataCommand(command(profile)), command(profile))
  }
})

test('rejects invalid platform metadata and unrelated fields', () => {
  for (const update of [
    { provider: 'unknown' }, { kind: 'unknown' }, { managed: 'true' },
    { accountKey: '' }, { accountKey: 42 }, { accountKey: 'x'.repeat(257) },
    { lastSyncAt: -1 }, { lastSyncAt: NaN }, { lastSyncAt: 1.5 },
    { cookie: 'not-allowed' }, { coverUrl: 42 },
  ]) {
    assert.throws(() => parsePlaylistMetadataCommand(command({ ...managedProfile, ...update })), /Invalid/)
  }
  for (const field of ['provider', 'kind', 'accountKey']) {
    const profile = { ...managedProfile }
    delete profile[field]
    assert.throws(() => parsePlaylistMetadataCommand(command(profile)), /Invalid/)
  }
})
