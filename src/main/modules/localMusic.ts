import fs from 'node:fs'
import path from 'node:path'
import { formatPlayTime } from '@common/utils/common'
import {
  normalizeLocalMusicDirs,
} from '@common/utils/localMusicSettings'

const AUDIO_EXTS = new Set(['mp3', 'flac', 'ogg', 'oga', 'wav', 'm4a'])

const getConfiguredDirs = () => {
  return normalizeLocalMusicDirs(global.lx.appSetting['localMusic.dirs'])
}

const getExt = (filePath: string) => path.extname(filePath).replace(/^\./, '').toLocaleLowerCase()

const isAudioFile = (filePath: string) => AUDIO_EXTS.has(getExt(filePath))

const formatArtists = (artists?: unknown, artist?: unknown) => {
  if (Array.isArray(artists) && artists.length) {
    return artists.map(item => String(item ?? '').trim()).filter(Boolean).join('、')
  }
  return typeof artist == 'string' ? artist.trim() : ''
}

const createLocalMusicInfo = async(filePath: string): Promise<LX.Music.MusicInfoLocal> => {
  const ext = getExt(filePath)
  const fallbackName = path.basename(filePath, path.extname(filePath)).trim()
  let name = fallbackName
  let singer = ''
  let albumName = ''
  let interval: string | null = null

  try {
    const { parseFile } = await import('music-metadata')
    const metadata = await parseFile(filePath)
    const title = metadata.common.title?.trim()
    if (title) name = title
    singer = formatArtists(metadata.common.artists, metadata.common.artist)
    albumName = metadata.common.album?.trim() ?? ''
    interval = metadata.format.duration ? formatPlayTime(metadata.format.duration) : null
  } catch (err) {
    console.log('[localMusic] parse music metadata failed:', filePath, err)
  }

  return {
    id: filePath,
    name,
    singer,
    source: 'local',
    interval,
    meta: {
      songId: filePath,
      albumName,
      picUrl: '',
      filePath,
      ext,
    },
  }
}

const scanDir = async(dir: string, files: string[], visited: Set<string>) => {
  const realDir = await fs.promises.realpath(dir).catch(() => '')
  if (!realDir || visited.has(realDir)) return
  visited.add(realDir)

  const entries = await fs.promises.readdir(realDir, { withFileTypes: true }).catch(err => {
    console.log(err)
    return []
  })

  for (const entry of entries) {
    const entryPath = path.join(realDir, entry.name)
    if (entry.isDirectory()) {
      await scanDir(entryPath, files, visited)
      continue
    }
    if (!entry.isFile() || !isAudioFile(entryPath)) continue
    files.push(entryPath)
  }
}

export const scanLocalMusicFolders = async(params?: LX.Music.LocalMusicScanParams): Promise<LX.Music.MusicInfoLocal[]> => {
  const hasRequestDirs = Array.isArray(params?.dirs)
  const requestDirs = normalizeLocalMusicDirs(params?.dirs)
  const dirs = hasRequestDirs ? requestDirs : getConfiguredDirs()
  if (!dirs.length) return []

  const files: string[] = []
  const visited = new Set<string>()
  for (const dir of dirs) {
    await scanDir(dir, files, visited)
  }

  const uniqueFiles = Array.from(new Set(files)).sort((a, b) => a.localeCompare(b))
  const list: LX.Music.MusicInfoLocal[] = []
  for (const filePath of uniqueFiles) {
    try {
      list.push(await createLocalMusicInfo(filePath))
    } catch (err) {
      console.log('[localMusic] create music info failed:', filePath, err)
    }
  }
  return list
}
