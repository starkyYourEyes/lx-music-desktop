import { userApis as defaultUserApis } from './config'
import { STORE_NAMES } from '@common/constants'
import getStore from '@main/utils/store'
import { assertUserApiSyncData, createUserApiSyncData } from '@common/utils/userApiSync'
import { log } from '@common/utils'
import { GITHUB_USER_API_LIMITS } from '@common/utils/githubUserApi'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'

let userApis: LX.UserApi.UserApiInfo[] | null
let scripts = new Map<string, string>()

const serializeUserApis = (apis: LX.UserApi.UserApiInfo[], apiScripts: Map<string, string>) => {
  return apis.map(api => ({
    ...api,
    script: apiScripts.get(api.id),
  }))
}

const saveData = (emitChange = true) => {
  getStore(STORE_NAMES.USER_API).set('userApis', serializeUserApis(userApis!, scripts))
  if (emitChange) global.lx.event_app.user_api_changed()
}

export const getUserApis = (): LX.UserApi.UserApiInfo[] => {
  if (userApis) return userApis

  const electronStore_userApi = getStore(STORE_NAMES.USER_API)
  let infoFull = electronStore_userApi.get('userApis') as LX.UserApi.UserApiInfoFull[]
  let requiredUpdate = false
  if (infoFull) {
    for (let i = 0; i < infoFull.length; i++) {
      const api = infoFull[i]
      if (api.version != null) continue
      requiredUpdate ||= true
      try {
        infoFull.splice(i, 1, {
          ...parseScriptInfo(api.script),
          ...api,
        })
      } catch (e) {
        infoFull.splice(i, 1)
        i--
      }
    }
  } else {
    infoFull = defaultUserApis
    electronStore_userApi.set('userApis', defaultUserApis)
  }
  userApis = infoFull.map(api => {
    if (api.allowShowUpdateAlert == null) api.allowShowUpdateAlert = false
    const { script, ...info } = api
    scripts.set(api.id, script)
    return info
  })
  if (requiredUpdate) saveData(false)
  return userApis
}

const INFO_NAMES = {
  name: 24,
  description: 36,
  author: 56,
  homepage: 1024,
  version: 36,
} as const
type INFO_NAMES_Type = typeof INFO_NAMES
const matchInfo = (scriptInfo: string) => {
  const infoArr = scriptInfo.split(/\r?\n/)
  const rxp = /^\s?\*\s?@(\w+)\s(.+)$/
  const infos: Partial<Record<keyof typeof INFO_NAMES, string>> = {}
  for (const info of infoArr) {
    const result = rxp.exec(info)
    if (!result) continue
    const key = result[1] as keyof typeof INFO_NAMES
    if (INFO_NAMES[key] == null) continue
    infos[key] = result[2].trim()
  }

  for (const [key, len] of Object.entries(INFO_NAMES) as Array<{ [K in keyof INFO_NAMES_Type]: [K, INFO_NAMES_Type[K]] }[keyof INFO_NAMES_Type]>) {
    infos[key] ||= ''
    if (infos[key] == null) infos[key] = ''
    else if (infos[key].length > len) infos[key] = infos[key].substring(0, len) + '...'
  }

  return infos as Record<keyof typeof INFO_NAMES, string>
}
const parseScriptInfo = (script: string) => {
  const result = /^\/\*[\S|\s]+?\*\//.exec(script)
  if (!result) throw new Error('无效的自定义源文件')

  let scriptInfo = matchInfo(result[0])

  scriptInfo.name ||= `user_api_${new Date().toLocaleString()}`
  return scriptInfo
}
const deflateScript = async(script: string) => new Promise<string>((resolve, reject) => {
  zlib.deflate(Buffer.from(script, 'utf8'), (err, buf) => {
    if (err) {
      reject(err)
      return
    }
    resolve('gz_' + buf.toString('base64'))
  })
})
const inflateScript = async(script: string) => new Promise<string>((resolve, reject) => {
  if (script.startsWith('gz_')) {
    zlib.inflate(Buffer.from(script.substring(3), 'base64'), (err, buf) => {
      if (err) {
        reject(err)
        return
      }
      resolve(buf.toString('utf8'))
    })
  } else resolve(script)
})

const GITHUB_REPOSITORY = 'Macrohard0001/lx-ikun-music-sources'
const GITHUB_VERSION_RXP = /^[vV]\d{6}$/
const GITHUB_SHA_RXP = /^[0-9a-f]{40}$/i

const validateGitHubImportItems = (items: LX.UserApi.GitHubImportItem[]) => {
  if (!Array.isArray(items) || !items.length || items.length > GITHUB_USER_API_LIMITS.maxFiles) {
    throw new Error('Invalid GitHub user API item count')
  }

  const paths = new Set<string>()
  let batchVersion: string | undefined
  let batchCommit: string | undefined
  let totalBytes = 0

  for (const item of items) {
    if (item == null || typeof item != 'object') {
      throw new Error('Invalid GitHub user API metadata')
    }
    const { remote, script } = item
    if (typeof script != 'string' || remote == null || typeof remote != 'object' ||
      remote.provider != 'github' || remote.repository != GITHUB_REPOSITORY ||
      typeof remote.version != 'string' || !GITHUB_VERSION_RXP.test(remote.version) ||
      typeof remote.group != 'string' || !remote.group ||
      typeof remote.path != 'string' ||
      typeof remote.blobSha != 'string' || !GITHUB_SHA_RXP.test(remote.blobSha) ||
      typeof remote.commitSha != 'string' || !GITHUB_SHA_RXP.test(remote.commitSha)) {
      throw new Error('Invalid GitHub user API metadata')
    }

    batchVersion ??= remote.version
    batchCommit ??= remote.commitSha
    if (remote.version != batchVersion || remote.commitSha != batchCommit ||
      paths.has(remote.path) || !remote.path.startsWith(remote.version + '/') ||
      !/\.js$/i.test(remote.path) || remote.path.includes('\\')) {
      throw new Error('Invalid or duplicate GitHub user API path')
    }

    const relativeParts = remote.path.substring(remote.version.length + 1).split('/')
    const fileName = relativeParts.at(-1)
    const expectedGroup = relativeParts.length > 1 ? relativeParts[0] : remote.version
    if (!fileName || fileName.length <= 3 ||
      relativeParts.some(part => !part || part == '.' || part == '..') ||
      remote.group != expectedGroup) {
      throw new Error('Invalid GitHub user API group')
    }

    paths.add(remote.path)
    const bytes = Buffer.byteLength(script, 'utf8')
    if (bytes > GITHUB_USER_API_LIMITS.maxScriptBytes) {
      throw new Error(`GitHub user API script is too large: ${remote.path}`)
    }
    totalBytes += bytes
  }

  if (totalBytes > GITHUB_USER_API_LIMITS.maxTotalBytes) {
    throw new Error('GitHub user API batch is too large')
  }
}

const createGitHubUserApiId = (remotePath: string) => {
  return 'user_api_github_' + createHash('sha256')
    .update(remotePath)
    .digest('hex')
    .substring(0, 16)
}

export const replaceApisFromGitHub = async(items: LX.UserApi.GitHubImportItem[]) => {
  getUserApis()
  validateGitHubImportItems(items)

  const nextUserApis: LX.UserApi.UserApiInfo[] = []
  const nextScripts = new Map<string, string>()
  for (const item of items) {
    const id = createGitHubUserApiId(item.remote.path)
    nextUserApis.push({
      id,
      ...parseScriptInfo(item.script),
      allowShowUpdateAlert: true,
      remote: { ...item.remote },
    })
    nextScripts.set(id, await deflateScript(item.script))
  }

  getStore(STORE_NAMES.USER_API).set('userApis', serializeUserApis(nextUserApis, nextScripts))
  userApis = nextUserApis
  scripts = nextScripts
  global.lx.event_app.user_api_changed()
  return getUserApis()
}
export const importApi = async(scriptRaw: string): Promise<LX.UserApi.UserApiInfo> => {
  let scriptInfo = parseScriptInfo(scriptRaw)
  const apiInfo = {
    id: `user_api_${Math.random().toString().substring(2, 5)}_${Date.now()}`,
    ...scriptInfo,
    allowShowUpdateAlert: true,
  }
  const script = await deflateScript(scriptRaw)
  userApis ??= []
  userApis.push(apiInfo)
  scripts.set(apiInfo.id, script)
  saveData()
  return apiInfo
}

export const removeApi = (ids: string[]) => {
  if (!userApis) return
  const idSet = new Set(ids)
  let removed = false
  for (let index = userApis.length - 1; index > -1; index--) {
    if (idSet.has(userApis[index].id)) {
      scripts.delete(userApis[index].id)
      userApis.splice(index, 1)
      removed = true
    }
  }
  if (!removed) return
  saveData()
}

export const setAllowShowUpdateAlert = (id: string, enable: boolean) => {
  const targetApi = userApis?.find(api => api.id == id)
  if (!targetApi) return
  if (targetApi.allowShowUpdateAlert == enable) return
  targetApi.allowShowUpdateAlert = enable
  saveData()
}

export const getScript = async(id: string) => {
  return inflateScript(scripts.get(id) ?? '')
}

export const getUserApiSyncData = async(): Promise<LX.Sync.UserApi.Data> => {
  return createUserApiSyncData(getUserApis(), getScript, {
    onScriptError(err: Error, api: LX.UserApi.UserApiInfo) {
      log.error(`skip invalid user api sync script: ${api.id}`, err)
    },
  })
}

export const overwriteUserApisFromSync = async(data: LX.Sync.UserApi.Data) => {
  assertUserApiSyncData(data)
  const nextUserApis: LX.UserApi.UserApiInfo[] = []
  const nextScripts = new Map<string, string>()
  for (const api of data.apis) {
    const { script, scriptEncoding, ...info } = api
    nextUserApis.push({
      ...info,
      allowShowUpdateAlert: info.allowShowUpdateAlert ?? false,
    })
    nextScripts.set(api.id, await deflateScript(script))
  }
  getStore(STORE_NAMES.USER_API).set('userApis', serializeUserApis(nextUserApis, nextScripts))
  userApis = nextUserApis
  scripts = nextScripts
}
