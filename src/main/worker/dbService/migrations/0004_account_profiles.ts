import { createHash } from 'node:crypto'
import type { SchemaMigration } from './types'

export const ACCOUNT_PROFILES_SOURCE = `CREATE TABLE account_profiles (
  provider TEXT PRIMARY KEY CHECK(provider IN ('netease', 'qq_music')),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);`

export const migration4: SchemaMigration = {
  version: 4,
  name: 'account_profiles',
  checksum: createHash('sha256').update(ACCOUNT_PROFILES_SOURCE).digest('hex'),
  up(db) {
    db.exec(ACCOUNT_PROFILES_SOURCE)
  },
}

export default migration4
