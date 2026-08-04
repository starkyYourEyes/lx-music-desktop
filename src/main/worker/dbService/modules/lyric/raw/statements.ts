import type Database from 'better-sqlite3'

export const selectRawRows = (db: Database.Database, provider: string, sourceTrackId: string) => db.prepare(`
  SELECT lyric_type AS lyricType, text FROM raw_lyrics
  WHERE provider = ? AND source_track_id = ? ORDER BY lyric_type
`).all(provider, sourceTrackId) as Array<{ lyricType: 'lyric' | 'tlyric' | 'rlyric' | 'lxlyric', text: string }>

export const selectRawProviderRows = (db: Database.Database, provider: string) => db.prepare(`
  SELECT source_track_id AS sourceTrackId, lyric_type AS lyricType, text FROM raw_lyrics
  WHERE provider = ?
`).all(provider) as Array<{ sourceTrackId: string, lyricType: 'lyric' | 'tlyric' | 'rlyric' | 'lxlyric', text: string }>

export const selectRawCounts = (db: Database.Database, provider?: string) => {
  const where = provider == null ? '' : 'WHERE provider = ?'
  const rows = db.prepare(`SELECT count(*) AS rows FROM raw_lyrics ${where}`).get(...(provider == null ? [] : [provider])) as { rows: number }
  const groups = db.prepare(`SELECT count(*) AS ownerGroups, coalesce(sum(byte_size), 0) AS bytes FROM raw_lyric_groups ${where}`).get(...(provider == null ? [] : [provider])) as { ownerGroups: number, bytes: number }
  return { rows: rows.rows, ownerGroups: groups.ownerGroups, bytes: groups.bytes }
}
