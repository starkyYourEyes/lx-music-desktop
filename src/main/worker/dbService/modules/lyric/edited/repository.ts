import { clearEditedRows, countEditedRows, deleteEditedRows, insertEditedRows, queryEditedRows, updateEditedRows } from './statements'

const keys = ['lyric', 'tlyric', 'rlyric', 'lxlyric'] as const

const decode = (rows: LX.DBService.Lyricnfo[]): LX.Music.LyricInfo => {
  const value: LX.Music.LyricInfo = { lyric: '' }
  for (const row of rows) {
    const text = Buffer.from(row.text ?? '', 'base64').toString('utf8')
    if (row.type == 'lyric') value.lyric = text
    else value[row.type] = text
  }
  return value
}

const encode = (id: string, lyrics: LX.Music.LyricInfo): LX.DBService.Lyricnfo[] => keys
  .filter(key => lyrics[key] != null)
  .map(key => ({ id, type: key, text: Buffer.from(lyrics[key]!).toString('base64'), source: 'edited' })) as LX.DBService.Lyricnfo[]

export const getEditedLyric = (id: string): LX.Music.LyricInfo => decode(queryEditedRows(id))
export const editedLyricAdd = (id: string, lyrics: LX.Music.LyricInfo): void => { insertEditedRows(encode(id, lyrics)) }
export const editedLyricRemove = (ids: string[]): void => { deleteEditedRows(ids) }
export const editedLyricUpdate = (id: string, lyrics: LX.Music.LyricInfo): void => { updateEditedRows(encode(id, lyrics)) }
export const editedLyricClear = (): void => { clearEditedRows() }
export const editedLyricCount = (): number => countEditedRows()
export const editedLyricUpdateAddAndUpdate = (id: string, lyrics: LX.Music.LyricInfo): void => {
  if (queryEditedRows(id).length) editedLyricUpdate(id, lyrics)
  else editedLyricAdd(id, lyrics)
}
