const NodeID3 = require('node-id3')
const path = require('path')
const fs = require('fs')
const download = require('./downloader')
const extReg = /^(\.(?:jpe?g|png)).*$/

const handleWriteMeta = (meta, filePath) => {
  if (meta.lyrics) {
    meta.unsynchronisedLyrics = {
      language: 'zho',
      text: meta.lyrics,
    }
    delete meta.lyrics
  }
  const result = NodeID3.write(meta, filePath)
  if (result instanceof Error) throw result
  if (!result) throw new Error('Could not write MP3 metadata')
}

module.exports = (filePath, meta, proxy) => {
  if (!meta.APIC) return handleWriteMeta(meta, filePath)
  if (!/^http/.test(meta.APIC)) {
    delete meta.APIC
    return handleWriteMeta(meta, filePath)
  }
  let ext = path.extname(meta.APIC)
  let picPath = filePath.replace(/\.mp3$/, '') + (ext ? ext.replace(extReg, '$1') : '.jpg')

  let picUrl = meta.APIC
  if (picUrl.includes('music.126.net')) picUrl += `${picUrl.includes('?') ? '&' : '?'}param=500y500`
  return download(picUrl, picPath, proxy).then(async success => {
    if (success) {
      meta.APIC = picPath
      try {
        handleWriteMeta(meta, filePath)
      } finally {
        await fs.promises.unlink(picPath)
      }
    } else {
      delete meta.APIC
      handleWriteMeta(meta, filePath)
    }
  })
}
