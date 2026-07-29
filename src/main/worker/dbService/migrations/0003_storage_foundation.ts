import { createHash } from 'node:crypto'
import type { SchemaMigration } from './types'

export const STORAGE_FOUNDATION_SOURCE = `CREATE TABLE migration_markers (
  name TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
  completed_at_ms INTEGER NOT NULL CHECK(completed_at_ms >= 0),
  details_json TEXT NOT NULL CHECK(json_valid(details_json))
);`

export const migration3: SchemaMigration = {
  version: 3,
  name: 'storage_foundation',
  checksum: createHash('sha256').update(STORAGE_FOUNDATION_SOURCE).digest('hex'),
  up(db) {
    db.exec(STORAGE_FOUNDATION_SOURCE)
  },
}

export default migration3
