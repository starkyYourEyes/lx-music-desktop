import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SchemaMigration } from './types'

export const KUGOU_ACCOUNT_PROFILES_SOURCE = `
ALTER TABLE account_profiles RENAME TO account_profiles_previous;
CREATE TABLE account_profiles (
  provider TEXT PRIMARY KEY CHECK(provider IN ('netease', 'qq_music', 'kugou')),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);
INSERT INTO account_profiles (provider, profile_json, updated_at_ms)
SELECT provider, profile_json, updated_at_ms FROM account_profiles_previous;
DROP TABLE account_profiles_previous;`

const verifyKugouConstraint = (db: Database.Database): void => {
  const insert = db.prepare(`
    INSERT INTO account_profiles (provider, profile_json, updated_at_ms)
    VALUES ('kugou', '{"userId":"migration-check","nickname":"K","avatarUrl":""}', 0)
  `)
  db.transaction(() => {
    insert.run()
    db.prepare('DELETE FROM account_profiles WHERE provider = \'kugou\'').run()
  })()
}

export const migration9: SchemaMigration = {
  version: 9,
  name: 'kugou_account_profiles',
  checksum: createHash('sha256').update(KUGOU_ACCOUNT_PROFILES_SOURCE).digest('hex'),
  up(db) {
    db.exec(KUGOU_ACCOUNT_PROFILES_SOURCE)
  },
  verify(db) {
    verifyKugouConstraint(db)
  },
}

export default migration9
