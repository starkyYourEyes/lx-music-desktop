import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertContainedPath } from '@main/utils/storagePaths'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const themeEditorDirectoryName = 'theme-editor'

export interface StagedThemeImage {
  stagingId: string
  previewPath: string
}

export interface PromotedThemeImage {
  fileName: string
  previewPath: string
}

export interface ThemeAssetManager {
  prepareThemeAssetStorage: () => Promise<void>
  stageThemeImage: (input: { sourcePath: string }) => Promise<StagedThemeImage>
  promoteThemeImage: (staged: StagedThemeImage) => Promise<PromotedThemeImage>
  discardThemeImage: (input: { stagingId: string }) => Promise<void>
  getThemeImagesPath: () => string
}

const isImage = (bytes: Buffer): boolean => {
  if (bytes.length < 12) return false
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true
  if (bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff) return true
  if (bytes.subarray(0, 6).toString('ascii') == 'GIF87a' || bytes.subarray(0, 6).toString('ascii') == 'GIF89a') return true
  if (bytes.subarray(0, 2).toString('ascii') == 'BM') return true
  if (bytes.subarray(0, 4).toString('ascii') == 'RIFF' && bytes.subarray(8, 12).toString('ascii') == 'WEBP') return true
  const text = bytes.subarray(0, 1024).toString('utf8').trimStart().toLowerCase()
  return text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))
}

const assertRegularFile = async(targetPath: string, errorCode: string): Promise<void> => {
  const stat = await fs.lstat(targetPath)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(errorCode)
}

const isOpaqueId = (value: string): boolean => /^[a-f0-9]{32}$/i.test(value)

export const createThemeAssetManager = (input: { profileRoot: string, runTempRoot: string }): ThemeAssetManager => {
  const profileRoot = path.resolve(input.profileRoot)
  const runTempRoot = path.resolve(input.runTempRoot)
  const stagingRoot = path.join(runTempRoot, themeEditorDirectoryName)
  const assetRoot = path.join(profileRoot, 'assets', 'theme-images')
  const legacyRoot = path.join(profileRoot, 'theme_images')

  const assertStagingRoot = async() => {
    assertContainedPath(runTempRoot, stagingRoot)
    await fs.mkdir(stagingRoot, { recursive: true })
    const stat = await fs.lstat(stagingRoot)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('theme_stage_invalid')
  }
  const stagingPath = (stagingId: string) => {
    if (!isOpaqueId(stagingId)) throw new Error('theme_stage_invalid')
    const target = path.join(stagingRoot, stagingId)
    try {
      assertContainedPath(stagingRoot, target)
    } catch {
      throw new Error('theme_stage_invalid')
    }
    return target
  }
  const assertStaged = async(stagingId: string) => {
    await assertStagingRoot()
    const target = stagingPath(stagingId)
    await assertRegularFile(target, 'theme_stage_invalid')
    return target
  }
  const ensureAssetRoot = async() => {
    assertContainedPath(profileRoot, assetRoot)
    await fs.mkdir(assetRoot, { recursive: true })
    const stat = await fs.lstat(assetRoot)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('theme_asset_root_invalid')
  }

  return {
    getThemeImagesPath: () => assetRoot,
    prepareThemeAssetStorage: async() => {
      await ensureAssetRoot()
      try {
        const legacyStat = await fs.lstat(legacyRoot)
        if (legacyStat.isSymbolicLink() || !legacyStat.isDirectory()) return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code == 'ENOENT') return
        throw error
      }
      for (const entry of await fs.readdir(legacyRoot, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || !entry.isFile()) continue
        const source = path.join(legacyRoot, entry.name)
        const target = path.join(assetRoot, entry.name)
        assertContainedPath(legacyRoot, source)
        assertContainedPath(assetRoot, target)
        try {
          await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code != 'EEXIST') throw error
        }
      }
    },
    stageThemeImage: async({ sourcePath }) => {
      const source = path.resolve(sourcePath)
      await assertRegularFile(source, 'theme_image_invalid')
      const sourceStat = await fs.lstat(source)
      if (sourceStat.size > MAX_IMAGE_BYTES) throw new Error('theme_image_too_large')
      const bytes = await fs.readFile(source)
      await assertRegularFile(source, 'theme_image_invalid')
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('theme_image_too_large')
      if (!isImage(bytes)) throw new Error('theme_image_invalid')
      await assertStagingRoot()
      const stagingId = crypto.randomBytes(16).toString('hex')
      const target = stagingPath(stagingId)
      await fs.writeFile(target, bytes, { flag: 'wx' })
      await assertStaged(stagingId)
      return { stagingId, previewPath: target }
    },
    promoteThemeImage: async(staged) => {
      const source = await assertStaged(staged.stagingId)
      if (staged.previewPath != source) throw new Error('theme_stage_invalid')
      const bytes = await fs.readFile(source)
      await assertStaged(staged.stagingId)
      if (!isImage(bytes)) throw new Error('theme_stage_invalid')
      await ensureAssetRoot()
      const fileName = `${crypto.randomBytes(16).toString('hex')}.img`
      const target = path.join(assetRoot, fileName)
      assertContainedPath(assetRoot, target)
      await fs.writeFile(target, bytes, { flag: 'wx' })
      await assertRegularFile(target, 'theme_asset_invalid')
      await assertStaged(staged.stagingId)
      await fs.unlink(source)
      return { fileName, previewPath: target }
    },
    discardThemeImage: async({ stagingId }) => {
      const target = await assertStaged(stagingId)
      await assertStaged(stagingId)
      await fs.unlink(target)
    },
  }
}
