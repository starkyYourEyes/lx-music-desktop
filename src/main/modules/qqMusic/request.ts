import crypto from 'node:crypto'

const SIGN_PREFIX = 'CJBPACrRuNy7'
const SIGN_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

export const createQQMusicRequestSign = (body: string): string => {
  let randomPart = ''
  const length = crypto.randomInt(10, 17)
  for (let index = 0; index < length; index++) {
    randomPart += SIGN_CHARS[crypto.randomInt(SIGN_CHARS.length)]
  }
  const hash = crypto.createHash('md5').update(`${SIGN_PREFIX}${body}`).digest('hex')
  return `zza${randomPart}${hash}`
}

export const createQQMusicFallbackGuid = (uin: string): string => {
  return crypto.createHash('md5').update(`lx-music-qq-guid:${uin}`).digest('hex')
}

export const createQQMusicFallbackUid = (uin: string): string => {
  const hash = crypto.createHash('sha256').update(`lx-music-qq-uid:${uin}`).digest('hex')
  return String(Number.parseInt(hash.slice(0, 12), 16) % 10_000_000_000).padStart(10, '0')
}
