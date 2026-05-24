import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import crypto from 'node:crypto'
import { URL } from 'node:url'
import type { Readable } from 'node:stream'
import { request } from 'undici'
import { detect } from 'jschardet'
import iconv from 'iconv-lite'
import { decodeKrc } from '@common/utils/lyricUtils/kg'
import { formatPlayTime } from '@common/utils/common'
import type { IAudioMetadata, IComment } from 'music-metadata/lib/type'

const AUDIO_EXTS = new Set(['mp3', 'flac', 'ogg', 'oga', 'wav', 'm4a'])
const LYRIC_EXTS = new Set(['lrc'])
const KRC_EXTS = new Set(['krc'])
const PIC_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp'])

interface WebDAVEntry {
  url: string
  path: string
  isDirectory: boolean
  size?: number
  etag?: string
  lastModified?: string
}

interface WebDAVTokenInfo {
  musicInfo: LX.Music.MusicInfoWebDAV
  config: LX.Music.WebDAVConfig
  expiresAt: number
}

interface ParsedWebDAVMusicMeta {
  title: string | null
  artist: string | null
  album: string | null
  albumArtist: string | null
  year: number | null
  genre: string[] | null
  interval: string | null
  hasEmbeddedPic: boolean
  lyric: string | null
}

let httpServer: http.Server | null = null
let serverPort = 0
const tokens = new Map<string, WebDAVTokenInfo>()

const normalizeDirUrl = (url: string) => url.endsWith('/') ? url : `${url}/`

const getConfiguredWebDAV = (): LX.Music.WebDAVConfig => ({
  url: global.lx.appSetting['webdav.url'],
  username: global.lx.appSetting['webdav.username'],
  password: global.lx.appSetting['webdav.password'],
})

const assertConfig = (config: LX.Music.WebDAVConfig) => {
  if (!config.url || !config.username || !config.password) throw new Error('WebDAV config is incomplete')
}

const getAuthHeader = (config: LX.Music.WebDAVConfig) => {
  return `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`
}

const encodePathname = (pathname: string) => {
  return pathname
    .split('/')
    .map(part => encodeURIComponent(decodeURIComponent(part)))
    .join('/')
}

const buildChildUrl = (baseUrl: string, href: string) => {
  const base = new URL(normalizeDirUrl(baseUrl))
  if (/^https?:\/\//i.test(href)) return href
  if (href.startsWith('/')) {
    base.pathname = encodePathname(href)
    base.search = ''
    base.hash = ''
    return base.toString()
  }
  return new URL(encodePathname(href), base).toString()
}

const getRelativePath = (rootUrl: string, childUrl: string) => {
  const root = new URL(normalizeDirUrl(rootUrl))
  const child = new URL(childUrl)
  let rootPath = decodeURIComponent(root.pathname)
  let childPath = decodeURIComponent(child.pathname)
  if (!rootPath.endsWith('/')) rootPath += '/'
  if (childPath.startsWith(rootPath)) childPath = childPath.slice(rootPath.length)
  return childPath.replace(/^\/+/, '')
}

const getFileName = (path: string) => {
  const name = path.split('/').filter(Boolean).at(-1) ?? path
  return decodeURIComponent(name)
}

const getExt = (fileName: string) => {
  const ext = /\.([^.]+)$/.exec(fileName)?.[1] ?? ''
  return ext.toLocaleLowerCase()
}

const stripExt = (fileName: string) => fileName.replace(/\.[^.]*$/, '')

const getBasePath = (filePath: string) => {
  const index = filePath.lastIndexOf('.')
  return (index < 0 ? filePath : filePath.slice(0, index)).toLocaleLowerCase()
}

const parseSongName = (fileName: string) => {
  const name = stripExt(fileName)
  const result = /^(.+?)\s+-\s+(.+)$/.exec(name)
  if (!result) return { name, singer: '' }
  return {
    name: result[2].trim() || name,
    singer: result[1].trim(),
  }
}

const normalizeTagText = (text?: string | null) => {
  const value = text?.trim()
  if (!value) return null
  return value
}

const formatArtists = (metadata: IAudioMetadata) => {
  if (metadata.common.artists?.length) {
    const artists = metadata.common.artists.map(a => a.trim()).filter(Boolean)
    if (artists.length) return artists.join('、')
  }
  return normalizeTagText(metadata.common.artist)
}

const getEmbeddedLyric = (metadata: IAudioMetadata) => {
  for (const lyricInfo of metadata.common.lyrics ?? []) {
    const lyric = typeof lyricInfo == 'string' ? lyricInfo : lyricInfo.text
    if (lyric && lyric.length > 10) return lyric
  }

  for (const info of Object.values(metadata.native)) {
    for (const tag of info) {
      switch (tag.id) {
        case 'LYRICS': {
          const value = typeof tag.value == 'string' ? tag.value : (tag as IComment).text
          if (value && value.length > 10) return value
          break
        }
        case 'USLT': {
          const value = tag.value as IComment
          if (value.text && value.text.length > 10) return value.text
          break
        }
      }
    }
  }

  return null
}

const parseWebDAVMusicMeta = async(entry: WebDAVEntry, config: LX.Music.WebDAVConfig): Promise<ParsedWebDAVMusicMeta | null> => {
  try {
    const resp = await request(entry.url, {
      method: 'GET',
      headers: {
        Authorization: getAuthHeader(config),
      },
    })
    if (resp.statusCode < 200 || resp.statusCode >= 300) return null

    const { parseStream } = await import('music-metadata')
    const metadata = await parseStream(resp.body as unknown as Readable, {
      mimeType: resp.headers['content-type']?.toString(),
      path: entry.path,
      size: entry.size,
    }, {
      duration: true,
    })

    return {
      title: normalizeTagText(metadata.common.title),
      artist: formatArtists(metadata),
      album: normalizeTagText(metadata.common.album),
      albumArtist: normalizeTagText(metadata.common.albumartist),
      year: metadata.common.year ?? null,
      genre: metadata.common.genre?.length ? metadata.common.genre : null,
      interval: metadata.format.duration ? formatPlayTime(metadata.format.duration) : null,
      hasEmbeddedPic: !!metadata.common.picture?.length,
      lyric: getEmbeddedLyric(metadata),
    }
  } catch (err) {
    console.log(err)
    return null
  }
}

const parsePropfindResponse = (xml: string, rootUrl: string): WebDAVEntry[] => {
  const entries: WebDAVEntry[] = []
  const responseReg = /<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/gi
  const tagValue = (block: string, tag: string) => {
    const reg = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i')
    return reg.exec(block)?.[1]?.trim()
  }

  for (const [response] of xml.matchAll(responseReg)) {
    const href = tagValue(response, 'href')
    if (!href) continue
    const url = buildChildUrl(rootUrl, href)
    const path = getRelativePath(rootUrl, url)
    if (!path) continue
    const isDirectory = /<(?:\w+:)?collection\b/i.test(response)
    const sizeRaw = tagValue(response, 'getcontentlength')
    const size = sizeRaw ? Number(sizeRaw) : undefined
    entries.push({
      url,
      path,
      isDirectory,
      size: Number.isFinite(size) ? size : undefined,
      etag: tagValue(response, 'getetag'),
      lastModified: tagValue(response, 'getlastmodified'),
    })
  }
  return entries
}

const propfind = async(url: string, config: LX.Music.WebDAVConfig) => {
  const resp = await request(normalizeDirUrl(url), {
    method: 'PROPFIND',
    headers: {
      Authorization: getAuthHeader(config),
      Depth: '1',
    },
    body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>',
  })
  if (resp.statusCode < 200 || resp.statusCode >= 300) throw new Error(`WebDAV PROPFIND failed: ${resp.statusCode}`)
  return resp.body.text()
}

const scanMusics = async(rootUrl: string, config: LX.Music.WebDAVConfig) => {
  const queue = [normalizeDirUrl(rootUrl)]
  const musics: LX.Music.MusicInfoWebDAV[] = []
  const visited = new Set<string>()
  const files: WebDAVEntry[] = []

  while (queue.length) {
    const currentUrl = queue.shift()!
    if (visited.has(currentUrl)) continue
    visited.add(currentUrl)
    const xml = await propfind(currentUrl, config)
    const entries = parsePropfindResponse(xml, rootUrl)
    for (const entry of entries) {
      if (entry.isDirectory) {
        queue.push(normalizeDirUrl(entry.url))
        continue
      }
      files.push(entry)
    }
  }

  const sidecars = new Map<string, {
    lyricPath?: string
    krcPath?: string
    picPath?: string
  }>()
  for (const entry of files) {
    const fileName = getFileName(entry.path)
    const ext = getExt(fileName)
    if (!LYRIC_EXTS.has(ext) && !KRC_EXTS.has(ext) && !PIC_EXTS.has(ext)) continue
    const key = getBasePath(entry.path)
    const info = sidecars.get(key) ?? {}
    if (LYRIC_EXTS.has(ext)) info.lyricPath = entry.path
    else if (KRC_EXTS.has(ext)) info.krcPath = entry.path
    else if (info.picPath == null || ext == 'jpg' || ext == 'jpeg') info.picPath = entry.path
    sidecars.set(key, info)
  }

  for (const entry of files) {
    const fileName = getFileName(entry.path)
    const ext = getExt(fileName)
    if (!AUDIO_EXTS.has(ext)) continue
    const sidecar = sidecars.get(getBasePath(entry.path))
    const fileInfo = parseSongName(fileName)
    const parsedMeta = await parseWebDAVMusicMeta(entry, config)
    const name = parsedMeta?.title ?? fileInfo.name
    const singer = parsedMeta?.artist ?? fileInfo.singer
    const albumName = parsedMeta?.album ?? ''
    const id = `webdav_${crypto.createHash('sha1').update(`${normalizeDirUrl(rootUrl)}\n${entry.path}`).digest('hex')}`
    musics.push({
      id,
      name,
      singer,
      source: 'webdav',
      interval: parsedMeta?.interval ?? null,
      meta: {
        songId: entry.path,
        albumName,
        picUrl: parsedMeta?.hasEmbeddedPic ? `webdav:${entry.path}#embedded-cover` : (sidecar?.picPath ? `webdav:${sidecar.picPath}` : null),
        url: normalizeDirUrl(rootUrl),
        path: entry.path,
        fileName,
        ext,
        title: parsedMeta?.title ?? null,
        artist: parsedMeta?.artist ?? null,
        album: parsedMeta?.album ?? null,
        albumArtist: parsedMeta?.albumArtist ?? null,
        year: parsedMeta?.year ?? null,
        genre: parsedMeta?.genre ?? null,
        hasEmbeddedPic: parsedMeta?.hasEmbeddedPic ?? false,
        embeddedLyric: parsedMeta?.lyric ?? null,
        lyricPath: sidecar?.lyricPath ?? null,
        krcPath: sidecar?.krcPath ?? null,
        picPath: sidecar?.picPath ?? null,
        size: entry.size,
        etag: entry.etag,
        lastModified: entry.lastModified,
      },
    })
  }

  return musics
}

const getWebDAVFileUrl = (musicInfo: LX.Music.MusicInfoWebDAV, filePath: string) => {
  return new URL(encodePathname(filePath), normalizeDirUrl(musicInfo.meta.url)).toString()
}

const requestWebDAVFile = async(musicInfo: LX.Music.MusicInfoWebDAV, filePath: string) => {
  const config = getConfiguredWebDAV()
  assertConfig(config)
  const resp = await request(getWebDAVFileUrl(musicInfo, filePath), {
    method: 'GET',
    headers: {
      Authorization: getAuthHeader(config),
    },
  })
  if (resp.statusCode < 200 || resp.statusCode >= 300) throw new Error(`WebDAV GET failed: ${resp.statusCode}`)
  return resp
}

const readWebDAVText = async(musicInfo: LX.Music.MusicInfoWebDAV, filePath: string) => {
  const resp = await requestWebDAVFile(musicInfo, filePath)
  const buffer = Buffer.from(await resp.body.arrayBuffer())
  const { confidence, encoding } = detect(buffer)
  if (encoding && confidence > 0.8 && iconv.encodingExists(encoding)) return iconv.decode(buffer, encoding)
  return buffer.toString('utf-8')
}

const sendPlain = (res: ServerResponse, statusCode: number, message: string) => {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(message)
}

const streamWebDAVMusic = async(req: IncomingMessage, res: ServerResponse, token: string) => {
  const info = tokens.get(token)
  if (!info || info.expiresAt < Date.now()) {
    tokens.delete(token)
    sendPlain(res, 404, 'WebDAV stream expired')
    return
  }

  const targetUrl = new URL(encodePathname(info.musicInfo.meta.path), normalizeDirUrl(info.musicInfo.meta.url)).toString()
  const headers: Record<string, string> = {
    Authorization: getAuthHeader(info.config),
  }
  if (req.headers.range) headers.Range = req.headers.range

  const upstream = await request(targetUrl, { method: 'GET', headers }).catch(err => {
    console.log(err)
    return null
  })
  if (!upstream) {
    sendPlain(res, 502, 'WebDAV stream failed')
    return
  }
  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    sendPlain(res, upstream.statusCode, `WebDAV stream failed: ${upstream.statusCode}`)
    return
  }

  const audioExt = info.musicInfo.meta.ext ? info.musicInfo.meta.ext : 'mpeg'
  const responseHeaders: Record<string, string | number> = {
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Content-Type': upstream.headers['content-type']?.toString() ?? `audio/${audioExt}`,
  }
  for (const key of ['content-length', 'content-range', 'last-modified', 'etag']) {
    const val = upstream.headers[key]
    if (val != null) responseHeaders[key] = Array.isArray(val) ? val.join(', ') : val.toString()
  }
  res.writeHead(upstream.statusCode, responseHeaders)
  upstream.body.pipe(res)
}

const ensureServer = async() => {
  if (httpServer) return
  await new Promise<void>((resolve, reject) => {
    httpServer = http.createServer((req, res) => {
      const match = /^\/webdav\/stream\/([^/?#]+)/.exec(req.url ?? '')
      if (!match) {
        sendPlain(res, 404, 'Not found')
        return
      }
      void streamWebDAVMusic(req, res, match[1])
    })
    httpServer.on('error', reject)
    httpServer.on('listening', () => {
      const address = httpServer?.address()
      if (!address || typeof address == 'string') {
        reject(new Error('invalid webdav proxy address'))
        return
      }
      serverPort = address.port
      resolve()
    })
    httpServer.listen(0, '127.0.0.1')
  })
}

export const testWebDAV = async(config: LX.Music.WebDAVConfig) => {
  assertConfig(config)
  await propfind(config.url, config)
  return true
}

export const listWebDAVMusics = async(params?: LX.Music.WebDAVListMusicParams) => {
  const settingConfig = getConfiguredWebDAV()
  const config: LX.Music.WebDAVConfig = {
    url: params?.url ?? settingConfig.url,
    username: params?.username ?? settingConfig.username,
    password: params?.password ?? settingConfig.password,
  }
  assertConfig(config)
  return scanMusics(config.url, config)
}

export const getWebDAVMusicUrl = async(musicInfo: LX.Music.MusicInfoWebDAV) => {
  const config = getConfiguredWebDAV()
  assertConfig(config)
  await ensureServer()
  const token = crypto.randomBytes(18).toString('hex')
  tokens.set(token, {
    musicInfo,
    config,
    expiresAt: Date.now() + 3 * 60 * 60 * 1000,
  })
  return `http://127.0.0.1:${serverPort}/webdav/stream/${token}`
}

export const getWebDAVMusicPic = async(musicInfo: LX.Music.MusicInfoWebDAV) => {
  if (musicInfo.meta.hasEmbeddedPic == true || musicInfo.meta.picUrl?.endsWith('#embedded-cover') == true) {
    const resp = await requestWebDAVFile(musicInfo, musicInfo.meta.path)
    const { parseStream, selectCover } = await import('music-metadata')
    const metadata = await parseStream(resp.body as unknown as Readable, {
      mimeType: resp.headers['content-type']?.toString(),
      path: musicInfo.meta.path,
      size: musicInfo.meta.size,
    })
    const picture = selectCover(metadata.common.picture)
    if (picture) return `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}`
  }
  if (!musicInfo.meta.picPath) return ''
  const resp = await requestWebDAVFile(musicInfo, musicInfo.meta.picPath)
  const picExt = getExt(musicInfo.meta.picPath)
  const imageExt = picExt || 'jpeg'
  const contentType = resp.headers['content-type']?.toString() ?? `image/${imageExt}`
  const buffer = Buffer.from(await resp.body.arrayBuffer())
  return `data:${contentType};base64,${buffer.toString('base64')}`
}

export const getWebDAVMusicLyric = async(musicInfo: LX.Music.MusicInfoWebDAV): Promise<LX.Music.LyricInfo | null> => {
  if (musicInfo.meta.lyricPath) {
    const lyric = await readWebDAVText(musicInfo, musicInfo.meta.lyricPath)
    if (lyric.trim()) return { lyric }
  }
  if (musicInfo.meta.krcPath) {
    const resp = await requestWebDAVFile(musicInfo, musicInfo.meta.krcPath)
    const buffer = Buffer.from(await resp.body.arrayBuffer())
    return decodeKrc(buffer)
  }
  if (musicInfo.meta.embeddedLyric) return { lyric: musicInfo.meta.embeddedLyric }
  return null
}
