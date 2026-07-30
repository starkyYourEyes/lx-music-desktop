import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { request } from 'undici'
import { detect } from 'jschardet'
import iconv from 'iconv-lite'
import { decodeKrc } from '@common/utils/lyricUtils/kg'
import { formatPlayTime } from '@common/utils/common'
import type { IAudioMetadata, IComment } from 'music-metadata/lib/type'
import {
  normalizeWebDAVSubDir,
  createLocalMusicWebDAVPath,
} from '@common/utils/localMusicWebdav'
import {
  normalizeLocalMusicWebDAVDir,
  normalizeLocalMusicDirs,
} from '@common/utils/localMusicSettings'
import {
  createWebDAVFileUrl,
  normalizeWebDAVRootUrl,
  resolveWebDAVHref,
} from '@common/utils/webdavUrl'
import { assertWebDAVCredential, type WebDAVCredentialPayloadV1 } from '@main/storage/credentials/types'
import type { CredentialVault } from '@main/storage/credentials/credentialVault'

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
  targetUrl: string
  ext: string
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
let serverStartPromise: Promise<void> | null = null
const tokens = new Map<string, WebDAVTokenInfo>()
const TOKEN_TTL = 3 * 60 * 60 * 1000
const MAX_TOKEN_COUNT = 128

const normalizeDirUrl = (url: string) => normalizeWebDAVRootUrl(url)

const webDAVCredentialRef = { kind: 'webdav-basic' } as const

const getCredentialVault = (): CredentialVault => {
  if (global.lx.credentialVault == null) throw new Error('Credential vault has not been initialized')
  return global.lx.credentialVault
}

const maskUsername = (username: string): string => {
  if (username.length == 1) return '*'
  if (username.length == 2) return `${username[0]}*`
  return `${username[0]}***${username.at(-1)}`
}

const isPlainExactRecord = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (value == null || typeof value != 'object' || Array.isArray(value) || Object.getPrototypeOf(value) != Object.prototype) return false
  const actualKeys = Object.keys(value)
  return actualKeys.length == keys.length && actualKeys.every(key => keys.includes(key))
}

const assertWebDAVCredentialInput = (input: unknown): WebDAVCredentialPayloadV1 => {
  if (!isPlainExactRecord(input, ['username', 'password'])) throw new Error('Invalid WebDAV credential input')
  return assertWebDAVCredential({ version: 1, username: input.username, password: input.password })
}

const assertWebDAVTestConfig = (input: unknown): LX.Music.WebDAVConfig => {
  try {
    if (!isPlainExactRecord(input, ['url', 'username', 'password'])) throw new Error()
    if (typeof input.url != 'string' || input.url.length == 0 || Buffer.byteLength(input.url, 'utf8') > 8 * 1024) throw new Error()
    const credential = assertWebDAVCredential({ version: 1, username: input.username, password: input.password })
    normalizeDirUrl(input.url)
    return { url: input.url, username: credential.username, password: credential.password }
  } catch {
    throw new Error('Invalid WebDAV test config')
  }
}

export const createWebDAVCredentialService = (vault: CredentialVault) => ({
  async getCredentialStatus(): Promise<LX.Music.WebDAVCredentialStatus> {
    const credential = vault.read<WebDAVCredentialPayloadV1>(webDAVCredentialRef)
    if (credential.status != 'available' && credential.status != 'memory-only') {
      return { configured: false, usernameHint: null, persistence: 'missing' }
    }
    return {
      configured: true,
      usernameHint: maskUsername(credential.value.username),
      persistence: credential.status == 'available' ? 'encrypted' : 'memory-only',
    }
  },
  async setCredentials(input: LX.Music.WebDAVCredentialInput): Promise<LX.Music.WebDAVCredentialSaveResult> {
    const credential = assertWebDAVCredentialInput(input)
    const result = await vault.write(webDAVCredentialRef, credential)
    if (!await vault.verify(webDAVCredentialRef, credential)) throw new Error('WebDAV credential verification failed')
    return result
  },
  async removeCredentials(): Promise<void> {
    await vault.remove(webDAVCredentialRef)
    if (vault.read(webDAVCredentialRef).status != 'missing') throw new Error('WebDAV credential removal verification failed')
  },
})

export const getWebDAVCredentialStatus = async(): Promise<LX.Music.WebDAVCredentialStatus> =>
  createWebDAVCredentialService(getCredentialVault()).getCredentialStatus()

export const setWebDAVCredentials = async(input: LX.Music.WebDAVCredentialInput): Promise<LX.Music.WebDAVCredentialSaveResult> =>
  createWebDAVCredentialService(getCredentialVault()).setCredentials(input)

export const removeWebDAVCredentials = async(): Promise<void> =>
  createWebDAVCredentialService(getCredentialVault()).removeCredentials()

export const getConfiguredWebDAV = (): LX.Music.WebDAVConfig => {
  const credential = getCredentialVault().read<WebDAVCredentialPayloadV1>(webDAVCredentialRef)
  return {
    url: global.lx.appSetting['webdav.url'],
    username: credential.status == 'available' || credential.status == 'memory-only' ? credential.value.username : '',
    password: credential.status == 'available' || credential.status == 'memory-only' ? credential.value.password : '',
  }
}

const assertConfig = (config: LX.Music.WebDAVConfig) => {
  if (!config.url || !config.username || !config.password) throw new Error('WebDAV config is incomplete')
  normalizeDirUrl(config.url)
}

const getAuthHeader = (config: LX.Music.WebDAVConfig) => {
  return `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`
}

const getFileName = (path: string) => {
  const name = path.split('/').filter(Boolean).at(-1) ?? path
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

const getExt = (fileName: string) => {
  const ext = /\.([^.]+)$/.exec(fileName)?.[1] ?? ''
  return ext.toLocaleLowerCase()
}

const getAudioContentType = (ext: string) => {
  switch (ext.toLocaleLowerCase()) {
    case 'mp3':
      return 'audio/mpeg'
    case 'flac':
      return 'audio/flac'
    case 'ogg':
    case 'oga':
      return 'audio/ogg'
    case 'wav':
      return 'audio/wav'
    case 'm4a':
      return 'audio/mp4'
    default:
      return 'application/octet-stream'
  }
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
  let body: Readable | null = null
  try {
    const resp = await request(entry.url, {
      method: 'GET',
      headers: {
        Authorization: getAuthHeader(config),
      },
    })
    body = resp.body as unknown as Readable
    if (resp.statusCode < 200 || resp.statusCode >= 300) return null

    const { parseStream } = await import('music-metadata')
    const metadata = await parseStream(body, {
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
  } finally {
    body?.destroy()
  }
}

const parsePropfindResponse = (xml: string, rootUrl: string, baseUrl: string): WebDAVEntry[] => {
  const entries: WebDAVEntry[] = []
  const responseReg = /<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/gi
  const tagValue = (block: string, tag: string) => {
    const reg = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i')
    return reg.exec(block)?.[1]?.trim()
  }

  for (const [response] of xml.matchAll(responseReg)) {
    const href = tagValue(response, 'href')
    if (!href) continue
    const resolved = resolveWebDAVHref(rootUrl, baseUrl, href)
    if (!resolved) continue
    const { url, path } = resolved
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
  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    await resp.body.dump()
    throw new Error(`WebDAV PROPFIND failed: ${resp.statusCode}`)
  }
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
    const entries = parsePropfindResponse(xml, rootUrl, currentUrl)
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

const getWebDAVFileUrl = (musicInfo: LX.Music.MusicInfoWebDAV, filePath: string, config: LX.Music.WebDAVConfig) => {
  if (normalizeDirUrl(musicInfo.meta.url) != normalizeDirUrl(config.url)) {
    throw new Error('WebDAV configuration has changed; refresh the music list')
  }
  return createWebDAVFileUrl(config.url, filePath)
}

const ensureWebDAVDirectory = async(rootUrl: string, relativeDir: string, config: LX.Music.WebDAVConfig) => {
  const dir = normalizeWebDAVSubDir(relativeDir)
  if (!dir) return

  let currentUrl = normalizeDirUrl(rootUrl)
  for (const segment of dir.split('/')) {
    currentUrl = new URL(`${encodeURIComponent(segment)}/`, currentUrl).toString()
    const resp = await request(currentUrl, {
      method: 'MKCOL',
      headers: {
        Authorization: getAuthHeader(config),
      },
    }).catch((err) => {
      console.log(err)
      return null
    })
    if (!resp) throw new Error('WebDAV MKCOL failed')
    await resp.body.dump()
    if (resp.statusCode == 405) continue
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw new Error(`WebDAV MKCOL failed: ${resp.statusCode}`)
    }
  }
}

const createUploadedWebDAVMusicInfo = (
  musicInfo: LX.Music.MusicInfoLocal,
  rootUrl: string,
  remotePath: string,
  size?: number,
): LX.Music.MusicInfoWebDAV => {
  const fileName = getFileName(remotePath)
  const ext = getExt(fileName) || musicInfo.meta.ext
  const id = `webdav_${crypto.createHash('sha1').update(`${normalizeDirUrl(rootUrl)}\n${remotePath}`).digest('hex')}`
  return {
    id,
    name: musicInfo.name,
    singer: musicInfo.singer,
    source: 'webdav',
    interval: musicInfo.interval,
    meta: {
      songId: remotePath,
      albumName: musicInfo.meta.albumName,
      picUrl: null,
      url: normalizeDirUrl(rootUrl),
      path: remotePath,
      fileName,
      ext,
      title: musicInfo.name || null,
      artist: musicInfo.singer || null,
      album: musicInfo.meta.albumName || null,
      albumArtist: null,
      year: null,
      genre: null,
      hasEmbeddedPic: false,
      embeddedLyric: null,
      lyricPath: null,
      krcPath: null,
      picPath: null,
      size,
    },
  }
}

const requestWebDAVFile = async(musicInfo: LX.Music.MusicInfoWebDAV, filePath: string) => {
  const config = getConfiguredWebDAV()
  assertConfig(config)
  const resp = await request(getWebDAVFileUrl(musicInfo, filePath, config), {
    method: 'GET',
    headers: {
      Authorization: getAuthHeader(config),
    },
  })
  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    await resp.body.dump()
    throw new Error(`WebDAV GET failed: ${resp.statusCode}`)
  }
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

  const headers: Record<string, string> = {
    Authorization: getAuthHeader(info.config),
  }
  if (req.headers.range) headers.Range = req.headers.range

  const upstream = await request(info.targetUrl, { method: 'GET', headers }).catch(err => {
    console.log(err)
    return null
  })
  if (!upstream) {
    sendPlain(res, 502, 'WebDAV stream failed')
    return
  }
  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    await upstream.body.dump()
    sendPlain(res, upstream.statusCode, `WebDAV stream failed: ${upstream.statusCode}`)
    return
  }

  const audioExt = info.ext || 'mpeg'
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
  res.once('close', () => upstream.body.destroy())
  upstream.body.pipe(res)
}

const ensureServer = async() => {
  if (httpServer?.listening && serverPort) return
  if (serverStartPromise) return serverStartPromise

  serverStartPromise = new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const match = /^\/webdav\/stream\/([^/?#]+)/.exec(req.url ?? '')
      if (!match) {
        sendPlain(res, 404, 'Not found')
        return
      }
      void streamWebDAVMusic(req, res, match[1]).catch(err => {
        console.error('[webdav] stream failed:', err)
        if (!res.headersSent) sendPlain(res, 502, 'WebDAV stream failed')
        else res.destroy(err instanceof Error ? err : undefined)
      })
    })
    httpServer = server
    server.on('error', (err) => {
      if (httpServer === server && !server.listening) {
        httpServer = null
        serverPort = 0
      }
      reject(err)
    })
    server.on('close', () => {
      if (httpServer !== server) return
      httpServer = null
      serverPort = 0
    })
    server.on('listening', () => {
      const address = server.address()
      if (!address || typeof address == 'string') {
        httpServer = null
        serverPort = 0
        server.close()
        reject(new Error('invalid webdav proxy address'))
        return
      }
      serverPort = address.port
      resolve()
    })
    server.listen(0, '127.0.0.1')
  }).finally(() => {
    serverStartPromise = null
  })
  return serverStartPromise
}

export const testWebDAV = async(input: LX.Music.WebDAVConfig) => {
  const config = assertWebDAVTestConfig(input)
  assertConfig(config)
  await propfind(config.url, config)
  return true
}

export const listWebDAVMusics = async(params?: LX.Music.WebDAVListMusicParams) => {
  const settingConfig = getConfiguredWebDAV()
  const config: LX.Music.WebDAVConfig = {
    url: params?.url ?? settingConfig.url,
    username: settingConfig.username,
    password: settingConfig.password,
  }
  assertConfig(config)
  return scanMusics(config.url, config)
}

export const getWebDAVMusicUrl = async(musicInfo: LX.Music.MusicInfoWebDAV) => {
  const config = getConfiguredWebDAV()
  assertConfig(config)
  const targetUrl = getWebDAVFileUrl(musicInfo, musicInfo.meta.path, config)
  await ensureServer()
  const now = Date.now()
  for (const [key, info] of tokens) {
    if (info.expiresAt < now) tokens.delete(key)
  }
  while (tokens.size >= MAX_TOKEN_COUNT) {
    const oldestToken = tokens.keys().next().value
    if (!oldestToken) break
    tokens.delete(oldestToken)
  }
  const token = crypto.randomBytes(18).toString('hex')
  tokens.set(token, {
    targetUrl,
    ext: musicInfo.meta.ext,
    config,
    expiresAt: now + TOKEN_TTL,
  })
  return `http://127.0.0.1:${serverPort}/webdav/stream/${token}`
}

export const getWebDAVMusicPic = async(musicInfo: LX.Music.MusicInfoWebDAV) => {
  if (musicInfo.meta.hasEmbeddedPic == true || musicInfo.meta.picUrl?.endsWith('#embedded-cover') == true) {
    const resp = await requestWebDAVFile(musicInfo, musicInfo.meta.path)
    try {
      const { parseStream, selectCover } = await import('music-metadata')
      const metadata = await parseStream(resp.body as unknown as Readable, {
        mimeType: resp.headers['content-type']?.toString(),
        path: musicInfo.meta.path,
        size: musicInfo.meta.size,
      })
      const picture = selectCover(metadata.common.picture)
      if (picture) return `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}`
    } finally {
      resp.body.destroy()
    }
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

export const uploadLocalMusicToWebDAV = async({
  musicInfo,
  webdavDir,
}: LX.Music.LocalMusicUploadParams): Promise<LX.Music.MusicInfoWebDAV> => {
  const config = getConfiguredWebDAV()
  assertConfig(config)

  const filePath = await fs.promises.realpath(musicInfo.meta.filePath)
  const configuredDirs = await Promise.all(normalizeLocalMusicDirs(global.lx.appSetting['localMusic.dirs'])
    .map(async dir => fs.promises.realpath(dir).catch(() => null)))
  const isConfiguredFile = configuredDirs.some(dir => {
    if (!dir) return false
    const relative = path.relative(dir, filePath)
    return relative == '' || (!relative.startsWith(`..${path.sep}`) && relative != '..' && !path.isAbsolute(relative))
  })
  if (!isConfiguredFile) throw new Error('Local music file is outside the configured folders')

  const ext = getExt(filePath)
  if (!AUDIO_EXTS.has(ext)) throw new Error('Unsupported local music file type')
  const stat = await fs.promises.stat(filePath)
  if (!stat.isFile()) throw new Error('Local music is not a file')

  const remotePath = createLocalMusicWebDAVPath({
    dir: normalizeLocalMusicWebDAVDir(webdavDir ?? global.lx.appSetting['localMusic.webdavDir']),
    name: musicInfo.name,
    singer: musicInfo.singer,
    ext,
    filePath,
  })
  const remoteDir = remotePath.split('/').slice(0, -1).join('/')
  await ensureWebDAVDirectory(config.url, remoteDir, config)

  const targetUrl = createWebDAVFileUrl(config.url, remotePath)
  const resp = await request(targetUrl, {
    method: 'PUT',
    headers: {
      Authorization: getAuthHeader(config),
      'Content-Type': getAudioContentType(ext),
      'Content-Length': String(stat.size),
    },
    body: fs.createReadStream(filePath) as any,
  })
  await resp.body.dump()
  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    throw new Error(`WebDAV PUT failed: ${resp.statusCode}`)
  }

  return createUploadedWebDAVMusicInfo(musicInfo, config.url, remotePath, stat.size)
}
