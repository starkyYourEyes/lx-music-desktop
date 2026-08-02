import { getAppDB } from '../../../db'

const edited = 'edited'

export const queryEditedRows = (id: string): LX.DBService.Lyricnfo[] => getAppDB().prepare(`
  SELECT type, text, source FROM lyric WHERE id = ? AND source = '${edited}'
`).all(id) as LX.DBService.Lyricnfo[]

export const insertEditedRows = (rows: LX.DBService.Lyricnfo[]): void => {
  const db = getAppDB()
  const insert = db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (@id, @type, @text, '${edited}')`)
  db.transaction(() => { for (const row of rows) insert.run(row) })()
}

export const updateEditedRows = (rows: LX.DBService.Lyricnfo[]): void => {
  const db = getAppDB()
  const update = db.prepare(`UPDATE lyric SET text = @text WHERE id = @id AND type = @type AND source = '${edited}'`)
  db.transaction(() => { for (const row of rows) update.run(row) })()
}

export const deleteEditedRows = (ids: string[]): void => {
  const remove = getAppDB().prepare(`DELETE FROM lyric WHERE id = ? AND source = '${edited}'`)
  getAppDB().transaction(() => { for (const id of ids) remove.run(id) })()
}

export const clearEditedRows = (): void => { getAppDB().prepare(`DELETE FROM lyric WHERE source = '${edited}'`).run() }
export const countEditedRows = (): number => (getAppDB().prepare(`SELECT count(*) AS count FROM lyric WHERE source = '${edited}'`).get() as { count: number }).count
