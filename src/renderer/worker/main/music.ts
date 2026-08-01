import { getLocalMusicFileLyric, getLocalMusicFilePic } from '@renderer/utils/music'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs/promises'

type OwnedDirectory = Readonly<{
  runTempRoot: string
  runTempIdentity: Readonly<LX.PathIdentity>
  childPath: string
  childIdentity: Readonly<LX.PathIdentity>
}>

type DirectoryHandle = Awaited<ReturnType<typeof fs.open>>

const identityPattern = /^(?:0|[1-9]\d*)$/
const pathKey = (value: string): string => process.platform == 'win32' ? value.toLowerCase() : value
const invalidRoot = (): Error => new Error('run_temp_root_invalid')
const sameIdentity = (stat: Awaited<ReturnType<typeof fs.lstat>>, identity: LX.PathIdentity): boolean =>
  String(stat.dev) == identity.dev && String(stat.ino) == identity.ino

let configurationStarted = false
let ownership: OwnedDirectory | null = null
let configurationError: unknown
let signalConfiguration: () => void
const configurationReady = new Promise<void>(resolve => { signalConfiguration = resolve })

const freezeOwnership = (input: LX.RunTempChildOwnership): OwnedDirectory => {
  if (input == null || typeof input != 'object' ||
    typeof input.runTempRoot != 'string' || !path.isAbsolute(input.runTempRoot) ||
    typeof input.childPath != 'string' || !path.isAbsolute(input.childPath) ||
    input.runTempIdentity == null || !identityPattern.test(input.runTempIdentity.dev) ||
    !identityPattern.test(input.runTempIdentity.ino) || input.childIdentity == null ||
    !identityPattern.test(input.childIdentity.dev) || !identityPattern.test(input.childIdentity.ino)) throw invalidRoot()

  const runTempRoot = path.resolve(input.runTempRoot)
  const childPath = path.resolve(input.childPath)
  if (pathKey(path.dirname(childPath)) != pathKey(runTempRoot) || path.basename(childPath) != 'local-artwork') {
    throw invalidRoot()
  }
  return Object.freeze({
    runTempRoot,
    runTempIdentity: Object.freeze({ ...input.runTempIdentity }),
    childPath,
    childIdentity: Object.freeze({ ...input.childIdentity }),
  })
}

const assertOwnedDirectory = async(current: OwnedDirectory): Promise<void> => {
  try {
    const runBefore = await fs.lstat(current.runTempRoot, { bigint: true })
    const childBefore = await fs.lstat(current.childPath, { bigint: true })
    if (runBefore.isSymbolicLink() || !runBefore.isDirectory() ||
      childBefore.isSymbolicLink() || !childBefore.isDirectory() ||
      !sameIdentity(runBefore, current.runTempIdentity) || !sameIdentity(childBefore, current.childIdentity)) {
      throw invalidRoot()
    }
    const runAfter = await fs.lstat(current.runTempRoot, { bigint: true })
    const childAfter = await fs.lstat(current.childPath, { bigint: true })
    if (!sameIdentity(runAfter, current.runTempIdentity) || !sameIdentity(childAfter, current.childIdentity)) {
      throw invalidRoot()
    }
  } catch {
    throw invalidRoot()
  }
}

const openOwnedChild = async(current: OwnedDirectory): Promise<Readonly<{
  handle: DirectoryHandle
  accessPath: string
}>> => {
  let handle: DirectoryHandle | null = null
  try {
    await assertOwnedDirectory(current)
    handle = await fs.open(current.childPath, 'r')
    const opened = await handle.stat({ bigint: true })
    if (!opened.isDirectory() || !sameIdentity(opened, current.childIdentity)) throw invalidRoot()
    await assertOwnedDirectory(current)
    const accessPath = process.platform == 'linux' ? `/proc/self/fd/${handle.fd}` : current.childPath
    return Object.freeze({ handle, accessPath })
  } catch (error) {
    try { await handle?.close() } catch {}
    throw error
  }
}

export const configureRunTempRoot = async(input: LX.RunTempChildOwnership | null): Promise<void> => {
  if (configurationStarted) throw new Error('run_temp_root_already_configured')
  configurationStarted = true
  try {
    if (input == null) {
      configurationError = invalidRoot()
      return
    }
    const candidate = freezeOwnership(input)
    await assertOwnedDirectory(candidate)
    ownership = candidate
  } catch (error) {
    configurationError = error
    throw error
  } finally {
    signalConfiguration()
  }
}

const getOwnedDirectory = async(): Promise<OwnedDirectory> => {
  await configurationReady
  if (ownership == null) {
    if (configurationError instanceof Error) throw configurationError
    throw new Error('run_temp_root_unavailable')
  }
  await assertOwnedDirectory(ownership)
  return ownership
}

const createArtworkFile = async(data: Uint8Array): Promise<string> => {
  const current = await getOwnedDirectory()
  const child = await openOwnedChild(current)
  try {
    if (process.platform != 'linux') throw new Error('local_artwork_secure_creation_unavailable')
    for (let attempt = 0; attempt < 8; attempt++) {
      await assertOwnedDirectory(current)
      const outputName = `${crypto.randomBytes(16).toString('hex')}.img`
      const outputPath = path.join(current.childPath, outputName)
      const ownedOutputPath = path.join(child.accessPath, outputName)
      let handle: Awaited<ReturnType<typeof fs.open>>
      try {
        handle = await fs.open(ownedOutputPath, 'wx')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code == 'EEXIST') continue
        throw error
      }
      let openedIdentity: LX.PathIdentity | null = null
      let failure: unknown
      try {
        const opened = await handle.stat({ bigint: true })
        if (!opened.isFile()) throw invalidRoot()
        openedIdentity = { dev: String(opened.dev), ino: String(opened.ino) }
        await assertOwnedDirectory(current)
        const outputBefore = await fs.lstat(outputPath, { bigint: true })
        if (outputBefore.isSymbolicLink() || !outputBefore.isFile() || !sameIdentity(outputBefore, openedIdentity)) {
          throw invalidRoot()
        }
        await handle.writeFile(data)
        const outputAfter = await handle.stat({ bigint: true })
        if (!sameIdentity(outputAfter, openedIdentity)) throw invalidRoot()
      } catch (error) {
        failure = error
      }
      try {
        await handle.close()
      } catch (error) {
        failure ??= error
      }
      const reclaimOutput = async(): Promise<void> => {
        if (openedIdentity == null) return
        try {
          const output = await fs.lstat(ownedOutputPath, { bigint: true })
          if (!output.isSymbolicLink() && output.isFile() && sameIdentity(output, openedIdentity)) {
            await fs.unlink(ownedOutputPath)
          }
        } catch {}
      }
      if (failure != null) {
        await reclaimOutput()
        throw failure instanceof Error ? failure : invalidRoot()
      }
      try {
        await assertOwnedDirectory(current)
        const output = await fs.lstat(outputPath, { bigint: true })
        if (output.isSymbolicLink() || !output.isFile() || openedIdentity == null || !sameIdentity(output, openedIdentity)) {
          throw invalidRoot()
        }
        return outputPath
      } catch (error) {
        await reclaimOutput()
        throw error
      }
    }
    throw new Error('local_artwork_name_collision')
  } finally {
    await child.handle.close()
  }
}

export const getMusicFilePic = async(filePath: string) => {
  const picture = await getLocalMusicFilePic(filePath)
  if (!picture) return ''
  if (typeof picture == 'string') return picture
  if (picture.data.length > 400_000) {
    try {
      return await createArtworkFile(picture.data)
    } catch {}
  }
  return `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}`
}

export const parseLyric = (lrc: string): LX.Music.LyricInfo => {
  const verifyAwlrc = (lrc: string) => {
    return /(?:^|\s*)\[\d+:\d+(?:\.\d+)]<\d+,\d+>.+$/m.test(lrc)
  }
  const verifylrc = (lrc: string) => {
    return /(?:^|\s*)\[\d+:\d+(?:\.\d+)].+$/m.test(lrc)
  }
  const lrcTags = {
    awlrc: {
      name: 'lxlyric',
      verify: verifyAwlrc,
    },
    lrc: {
      name: 'lyric',
      verify: verifylrc,
    },
    tlrc: {
      name: 'tlyric',
      verify: verifylrc,
    },
    rlrc: {
      name: 'rlyric',
      verify: verifylrc,
    },
  } as const
  const tagRxp = /(?:^|\n\s*)\[awlrc:([^\]]+)]/i
  const lrcRxp = /^(lrc|awlrc|tlrc|rlrc):([^,]+)$/i
  const parse = (content: string) => {
    const lyricInfo: Partial<LX.Music.LyricInfo> = {}
    const lrcs = content.trim().split(',')
    for (const lrc of lrcs) {
      const result = lrcRxp.exec(lrc.trim())
      if (!result) continue
      const target = lrcTags[result[1].toLowerCase() as 'tlrc' | 'rlrc' | 'lrc' | 'awlrc']
      if (!target) continue
      const data = Buffer.from(result[2], 'base64').toString('utf-8').trim()
      if (target.verify(data)) lyricInfo[target.name] = data
    }
    return lyricInfo
  }
  let parsedInfo: Partial<LX.Music.LyricInfo> = {}
  let lyric = lrc.replace(tagRxp, (_: string, p1: string) => {
    parsedInfo = parse(p1)
    return ''
  }).trim()
  return { lyric, ...parsedInfo }
}


export const getMusicFileLyric = async(filePath: string): Promise<LX.Music.LyricInfo | null> => {
  const lyric = await getLocalMusicFileLyric(filePath)
  if (!lyric) return null
  return parseLyric(lyric.lyric)
}
