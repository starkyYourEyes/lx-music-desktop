const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { createTestStorageRoot } = require('./test-storage-root.js')

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value != null && typeof value == 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const phase3Marker = () => {
  const detailsJson = canonical({
    version: 1,
    checks: [
      { name: 'credentials', version: 1, state: 'complete', evidenceSha256: 'a'.repeat(64) },
      { name: 'account-profile', version: 1, state: 'complete', evidenceSha256: 'b'.repeat(64) },
      { name: 'phase2-storage', version: 1, state: 'complete', evidenceSha256: 'c'.repeat(64) },
      { name: 'playback-activity', version: 1, state: 'complete', evidenceSha256: 'd'.repeat(64) },
      { name: 'quarantine', version: 1, state: 'complete', evidenceSha256: 'e'.repeat(64) },
      { name: 'playback-writer', version: 1, state: 'complete', evidenceSha256: 'f'.repeat(64) },
      { name: 'playback-reader', version: 1, state: 'complete', evidenceSha256: '0'.repeat(64) },
    ],
  })
  return {
    name: 'legacy_data_v1.cross_artifact_complete',
    sourceSha256: crypto.createHash('sha256').update(detailsJson).digest('hex'),
    completedAtMs: 1,
    detailsJson,
  }
}

const createPhase4DurableFixture = ({ layout }) => {
  if (layout != 'installed' && layout != 'portable') throw new Error('Phase 4 fixture layout is invalid')
  const owned = createTestStorageRoot(`phase4-${layout}`)
  const portableRoot = layout == 'portable' ? path.join(owned.path, 'portable') : null
  const storageRoot = portableRoot ?? owned.path
  fs.mkdirSync(storageRoot, { recursive: true })
  const profileRoot = path.join(storageRoot, 'profile')
  const cacheRoot = path.join(storageRoot, 'cache')
  const runtimeRoot = path.join(storageRoot, 'runtime')
  const sessionDataRoot = path.join(runtimeRoot, 'session-data')
  const backupsRoot = path.join(storageRoot, 'backups')
  return {
    layout,
    root: owned.path,
    ownershipMarkerPath: owned.ownershipMarkerPath,
    cleanup: owned.cleanup,
    portableRoot,
    legacyProfileRoot: portableRoot == null ? null : path.join(portableRoot, 'userData', 'LxDatas'),
    profileRoot,
    cacheRoot,
    cachePath: path.join(cacheRoot, 'cache.db'),
    runtimeRoot,
    sessionDataRoot,
    backupsRoot,
  }
}

const durableFilePaths = (fixture, profileRoot = fixture.profileRoot) => ({
  'profile/settings.json': path.join(profileRoot, 'settings.json'),
  'profile/vault.bin': path.join(profileRoot, 'vault.bin'),
  'profile/themes/phase4-theme.png': path.join(profileRoot, 'themes', 'phase4-theme.png'),
  'profile/user-api/phase4.js': path.join(profileRoot, 'user-api', 'phase4.js'),
  'profile/downloads/completed.flac': path.join(profileRoot, 'downloads', 'completed.flac'),
  'profile/downloads/partial.flac.part': path.join(profileRoot, 'downloads', 'partial.flac.part'),
  'backups/manual-export.backup': path.join(fixture.backupsRoot, 'manual-export.backup'),
  'runtime/session-data/Cookies': path.join(fixture.sessionDataRoot, 'Cookies'),
  'runtime/session-data/Local Storage/leveldb/000003.log': path.join(
    fixture.sessionDataRoot, 'Local Storage', 'leveldb', '000003.log',
  ),
})

const durableFileContents = Object.freeze({
  'profile/settings.json': Buffer.from('{"theme":"phase4","volume":0.75}\n'),
  'profile/vault.bin': Buffer.from('8f4a0001ffeeddcc7761756c742d63697068657274657874', 'hex'),
  'profile/themes/phase4-theme.png': Buffer.from('89504e470d0a1a0a7068617365342d7468656d65', 'hex'),
  'profile/user-api/phase4.js': Buffer.from('module.exports = { name: "phase4-user-api" }\n'),
  'profile/downloads/completed.flac': Buffer.from('664c6143000000227068617365342d636f6d706c657465', 'hex'),
  'profile/downloads/partial.flac.part': Buffer.from('664c6143000000227061727469616c', 'hex'),
  'backups/manual-export.backup': Buffer.from('phase4-manual-backup\0durable'),
  'runtime/session-data/Cookies': Buffer.from('fake-cookie-db\0phase4'),
  'runtime/session-data/Local Storage/leveldb/000003.log': Buffer.from('fake-local-storage\0phase4'),
})

const seedDurableFiles = (fixture, { profileRoot = fixture.profileRoot } = {}) => {
  const files = durableFilePaths(fixture, profileRoot)
  for (const [name, filePath] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, durableFileContents[name], { flag: 'wx' })
  }
  return files
}

const putPhase3Marker = db => {
  const marker = phase3Marker()
  db.prepare(`
    INSERT INTO migration_markers(name, source_sha256, completed_at_ms, details_json)
    VALUES (?, ?, ?, ?)
  `).run(marker.name, marker.sourceSha256, marker.completedAtMs, marker.detailsJson)
}

const seedDurableDatabase = db => db.transaction(() => {
  db.prepare(`
    INSERT INTO my_list(id, name, source, sourceListId, position, locationUpdateTime)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('phase4-list', 'Phase 4 playlist', 'local', 'source-list-1', 0, 1700000000000)
  db.prepare(`
    INSERT INTO my_list_music_info(id, listId, name, singer, source, interval, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('phase4-track', 'phase4-list', 'Fixture song', 'Fixture singer', 'tx', '03:21', '{"albumName":"Fixture album"}')
  db.prepare(`
    INSERT INTO my_list_music_info_order(listId, musicInfoId, "order") VALUES (?, ?, ?)
  `).run('phase4-list', 'phase4-track', 0)

  const lyricInsert = db.prepare('INSERT INTO lyric(id, source, type, text) VALUES (?, ?, ?, ?)')
  lyricInsert.run('phase4-track', 'edited', 'lyric', Buffer.from('[00:00.00]Playlist edited').toString('base64'))
  lyricInsert.run('phase4-track', 'edited', 'tlyric', Buffer.from('[00:00.00]Translated').toString('base64'))
  lyricInsert.run('phase4-track', 'raw', 'lyric', Buffer.from('[00:00.00]Raw lyric').toString('base64'))
  lyricInsert.run('phase4-track', 'raw', 'tlyric', Buffer.from('[00:00.00]Raw translation').toString('base64'))

  const downloadInsert = db.prepare(`
    INSERT INTO download_list(
      id, isComplate, status, statusText, progress_downloaded, progress_total,
      url, quality, ext, fileName, filePath, musicInfo, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  downloadInsert.run(
    'phase4-complete', 1, 'completed', 'Completed', 4096, 4096,
    'https://media.invalid/complete', 'flac', 'flac', 'completed.flac', 'downloads/completed.flac',
    '{"id":"phase4-complete","source":"tx","name":"Complete","singer":"Fixture"}', 0,
  )
  downloadInsert.run(
    'phase4-partial', 0, 'paused', 'Paused', 1024, 8192,
    'https://media.invalid/partial', 'flac', 'flac', 'partial.flac', 'downloads/partial.flac.part',
    '{"id":"phase4-partial","source":"tx","name":"Partial","singer":"Fixture"}', 1,
  )
  db.prepare(`
    INSERT INTO local_state(key, version, value_json, updated_at_ms) VALUES (?, ?, ?, ?)
  `).run('view_prev_state', 1, '{"route":"/song-list"}', 1700000000001)
  db.prepare(`
    INSERT INTO playlist_metadata(
      playlist_id, is_auto_update, update_time_ms, profile_json, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?)
  `).run('phase4-list', 1, 1700000000002, '{"name":"Phase 4 profile"}', 1700000000003)
  db.prepare(`
    INSERT INTO search_history(term, recency_seq, last_used_at_ms, use_count) VALUES (?, ?, ?, ?)
  `).run('phase4 search', 1, 1700000000004, 3)
})()

const snapshotDurableDatabase = db => ({
  quickCheck: db.pragma('quick_check', { simple: true }),
  foreignKeyFailures: db.pragma('foreign_key_check'),
  myList: db.prepare(`
    SELECT id, name, source, sourceListId, position, locationUpdateTime
    FROM my_list ORDER BY id
  `).all(),
  musicInfo: db.prepare(`
    SELECT id, listId, name, singer, source, interval, meta
    FROM my_list_music_info ORDER BY listId, id
  `).all(),
  musicOrder: db.prepare(`
    SELECT listId, musicInfoId, "order" FROM my_list_music_info_order ORDER BY listId, "order"
  `).all(),
  editedLyrics: db.prepare(`
    SELECT id, source, type, text FROM lyric WHERE source = 'edited' ORDER BY id, type
  `).all(),
  downloadList: db.prepare(`
    SELECT id, isComplate, status, statusText, progress_downloaded, progress_total,
      url, quality, ext, fileName, filePath, musicInfo, position
    FROM download_list ORDER BY position
  `).all(),
  localState: db.prepare(`
    SELECT key, version, value_json AS valueJson, updated_at_ms AS updatedAtMs FROM local_state ORDER BY key
  `).all(),
  playlistMetadata: db.prepare(`
    SELECT playlist_id AS playlistId, is_auto_update AS isAutoUpdate,
      update_time_ms AS updateTimeMs, profile_json AS profileJson, updated_at_ms AS updatedAtMs
    FROM playlist_metadata ORDER BY playlist_id
  `).all(),
  searchHistory: db.prepare(`
    SELECT term, recency_seq AS recencySeq, last_used_at_ms AS lastUsedAtMs, use_count AS useCount
    FROM search_history ORDER BY recency_seq
  `).all(),
})

const snapshotDurableFixture = (fixture, db) => ({
  database: snapshotDurableDatabase(db),
  files: Object.fromEntries(Object.entries(durableFilePaths(fixture)).map(([name, filePath]) => [
    name,
    fs.readFileSync(filePath).toString('base64'),
  ])),
})

const assertFixturePathsOwned = fixture => {
  const root = fs.realpathSync(fixture.root)
  const paths = [
    fixture.ownershipMarkerPath,
    fixture.portableRoot,
    fixture.legacyProfileRoot,
    fixture.profileRoot,
    fixture.cacheRoot,
    fixture.cachePath,
    fixture.runtimeRoot,
    fixture.sessionDataRoot,
    fixture.backupsRoot,
    ...Object.values(durableFilePaths(fixture)),
  ].filter(Boolean)
  for (const candidate of paths) {
    const relative = path.relative(root, path.resolve(candidate))
    if (relative == '' || relative == '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Phase 4 fixture path escaped its owned root: ${candidate}`)
    }
    if (fs.existsSync(candidate)) {
      const real = fs.realpathSync(candidate)
      const realRelative = path.relative(root, real)
      if (realRelative == '' || realRelative == '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        throw new Error(`Phase 4 fixture real path escaped its owned root: ${candidate}`)
      }
    }
  }
}

module.exports = {
  assertFixturePathsOwned,
  createPhase4DurableFixture,
  putPhase3Marker,
  seedDurableDatabase,
  seedDurableFiles,
  snapshotDurableFixture,
}
