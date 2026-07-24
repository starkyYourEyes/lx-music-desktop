const normalizeLocalMusicDirs = value => {
  if (!Array.isArray(value)) return []
  return value
    .map(dir => String(dir ?? '').trim())
    .filter(Boolean)
}

const normalizeLocalMusicWebDAVDir = value => {
  const dir = String(value ?? '').trim()
  return dir || 'local-music'
}

module.exports = {
  normalizeLocalMusicDirs,
  normalizeLocalMusicWebDAVDir,
}
