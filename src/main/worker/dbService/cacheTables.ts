export const CACHE_SCHEMA_SOURCE = `CREATE TABLE cache_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at_ms INTEGER NOT NULL CHECK(applied_at_ms >= 0)
);

CREATE TABLE raw_lyric_groups (
  provider TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  last_accessed_at_ms INTEGER NOT NULL CHECK(last_accessed_at_ms >= created_at_ms),
  PRIMARY KEY(provider, source_track_id)
);

CREATE TABLE raw_lyrics (
  provider TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  lyric_type TEXT NOT NULL CHECK(lyric_type IN ('lyric','tlyric','rlyric','lxlyric')),
  text TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  PRIMARY KEY(provider, source_track_id, lyric_type),
  FOREIGN KEY(provider, source_track_id)
    REFERENCES raw_lyric_groups(provider, source_track_id) ON DELETE CASCADE
);

CREATE TABLE music_urls (
  provider TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  quality TEXT NOT NULL,
  url TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  last_accessed_at_ms INTEGER NOT NULL CHECK(last_accessed_at_ms >= created_at_ms),
  PRIMARY KEY(provider, account_scope, source_track_id, quality)
);

CREATE TABLE other_source_groups (
  original_provider TEXT NOT NULL,
  original_track_id TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  last_accessed_at_ms INTEGER NOT NULL CHECK(last_accessed_at_ms >= created_at_ms),
  PRIMARY KEY(original_provider, original_track_id)
);

CREATE TABLE other_sources (
  original_provider TEXT NOT NULL,
  original_track_id TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK(rank >= 0),
  candidate_provider TEXT NOT NULL,
  candidate_track_id TEXT NOT NULL,
  candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  PRIMARY KEY(original_provider, original_track_id, rank),
  UNIQUE(original_provider, original_track_id, candidate_provider, candidate_track_id),
  FOREIGN KEY(original_provider, original_track_id)
    REFERENCES other_source_groups(original_provider, original_track_id) ON DELETE CASCADE
);

CREATE INDEX raw_lyric_groups_lru
ON raw_lyric_groups(last_accessed_at_ms, created_at_ms, provider COLLATE BINARY, source_track_id COLLATE BINARY);

CREATE INDEX music_urls_expiry
ON music_urls(expires_at_ms, provider COLLATE BINARY, account_scope COLLATE BINARY,
  source_track_id COLLATE BINARY, quality COLLATE BINARY);

CREATE INDEX music_urls_lru
ON music_urls(last_accessed_at_ms, created_at_ms, provider COLLATE BINARY,
  account_scope COLLATE BINARY, source_track_id COLLATE BINARY, quality COLLATE BINARY);

CREATE INDEX other_source_groups_expiry
ON other_source_groups(expires_at_ms, original_provider COLLATE BINARY, original_track_id COLLATE BINARY);

CREATE INDEX other_source_groups_lru
ON other_source_groups(last_accessed_at_ms, created_at_ms,
  original_provider COLLATE BINARY, original_track_id COLLATE BINARY);`

export default CACHE_SCHEMA_SOURCE
