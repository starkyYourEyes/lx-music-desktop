const crypto = require('node:crypto')

// eslint-disable-next-line no-control-regex
const INVALID_FILE_NAME_CHAR_RXP = /[<>:"/\\|?*\u0000-\u001f]/g

const trimDots = value => value.replace(/^\.+/, '').replace(/\.+$/, '')

const sanitizeFileNamePart = value => {
  const text = String(value ?? '')
    .replace(INVALID_FILE_NAME_CHAR_RXP, '')
    .replace(/\s+/g, ' ')
    .trim()
  return trimDots(text) || 'Unknown'
}

const normalizeWebDAVSubDir = value => {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map(part => trimDots(part.trim()))
    .filter(Boolean)
    .join('/')
}

const normalizeExt = ext => {
  const value = String(ext ?? '').trim().replace(/^\./, '').toLocaleLowerCase()
  return value || 'mp3'
}

const getPathHash = filePath => {
  return crypto.createHash('sha1').update(String(filePath ?? '')).digest('hex').slice(0, 8)
}

const createLocalMusicWebDAVFileName = ({ name, singer, ext, filePath }) => {
  const safeName = sanitizeFileNamePart(name)
  const safeSinger = sanitizeFileNamePart(singer)
  const baseName = singer ? `${safeSinger} - ${safeName}` : safeName
  return `${baseName} [${getPathHash(filePath)}].${normalizeExt(ext)}`
}

const createLocalMusicWebDAVPath = ({ dir, name, singer, ext, filePath }) => {
  const fileName = createLocalMusicWebDAVFileName({ name, singer, ext, filePath })
  const normalizedDir = normalizeWebDAVSubDir(dir)
  return normalizedDir ? `${normalizedDir}/${fileName}` : fileName
}

module.exports = {
  normalizeWebDAVSubDir,
  createLocalMusicWebDAVFileName,
  createLocalMusicWebDAVPath,
}
