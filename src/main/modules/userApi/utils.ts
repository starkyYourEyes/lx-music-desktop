import { userApis as defaultUserApis } from './config'
import { STORE_NAMES } from '@common/constants'
import getStore from '@main/utils/store'
import { assertUserApiSyncData, createUserApiSyncData } from '@common/utils/userApiSync'
import { log } from '@common/utils'
import { createGitHubUserApiError, GITHUB_USER_API_LIMITS } from '@common/utils/githubUserApi'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'

let userApis: LX.UserApi.UserApiInfo[] | null
let scripts = new Map<string, string>()

export interface UserApiState {
  apiList: LX.UserApi.UserApiInfo[]
  scripts: Map<string, string>
}

const serializeUserApis = (apis: LX.UserApi.UserApiInfo[], apiScripts: Map<string, string>) => {
  return apis.map(api => {
    const serialized = { ...api, script: apiScripts.get(api.id) }
    if (api.remote) serialized.remote = { ...api.remote }
    return serialized
  })
}

export const commitUserApiState = (state: UserApiState): LX.UserApi.UserApiInfo[] => {
  getStore(STORE_NAMES.USER_API).set('userApis', serializeUserApis(state.apiList, state.scripts))
  userApis = state.apiList
  scripts = state.scripts
  return userApis
}

export const notifyUserApiChanged = () => {
  try {
    global.lx.event_app.user_api_changed()
  } catch (err) {
    log.error('emit user API changed event error:', err)
  }
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
    const { script, remote, ...info } = api
    scripts.set(api.id, script)
    return remote ? { ...info, remote: { ...remote } } : info
  })
  if (requiredUpdate) saveData(false)
  return userApis
}

export const getUserApiState = (): UserApiState => {
  getUserApis()
  return {
    apiList: userApis!,
    scripts,
  }
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
const isWellFormedUnicode = (value: string) => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

type GitHubImportSnapshot = LX.UserApi.GitHubImportItem & { id: string }

const isPlainOwnDataRecord = (value: unknown): value is Record<string, unknown> => {
  if (value == null || typeof value != 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype != Object.prototype && prototype != null) return false
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>
  return Reflect.ownKeys(descriptors)
    .every(key => 'value' in descriptors[key])
}

const hasOwnProperties = (value: Record<string, unknown>, properties: string[]) => {
  return properties.every(property => Object.prototype.hasOwnProperty.call(value, property))
}


const validateGitHubImportItems = (items: LX.UserApi.GitHubImportItem[]): GitHubImportSnapshot[] => {
  if (!Array.isArray(items) || !items.length || items.length > GITHUB_USER_API_LIMITS.maxFiles) {
    throw new Error('Invalid GitHub user API item count')
  }

  const paths = new Set<string>()
  const ids = new Set<string>()
  const snapshots: GitHubImportSnapshot[] = []
  let batchVersion: string | undefined
  let batchCommit: string | undefined
  let totalBytes = 0

  for (const itemValue of items as unknown[]) {
    if (!isPlainOwnDataRecord(itemValue) ||
      !hasOwnProperties(itemValue, ['script', 'remote'])) {
      throw new Error('Invalid GitHub user API metadata')
    }
    const script = itemValue.script
    const remoteValue = itemValue.remote
    if (typeof script != 'string' || !isPlainOwnDataRecord(remoteValue) ||
      !hasOwnProperties(remoteValue, [
        'provider',
        'repository',
        'version',
        'group',
        'path',
        'blobSha',
        'commitSha',
      ])) {
      throw new Error('Invalid GitHub user API metadata')
    }
    const provider = remoteValue.provider
    const repository = remoteValue.repository
    const version = remoteValue.version
    const group = remoteValue.group
    const remotePath = remoteValue.path
    const blobSha = remoteValue.blobSha
    const commitSha = remoteValue.commitSha
    if (provider != 'github' || repository != GITHUB_REPOSITORY ||
      typeof version != 'string' || !GITHUB_VERSION_RXP.test(version) ||
      typeof group != 'string' || !group || !isWellFormedUnicode(group) ||
      typeof remotePath != 'string' || !isWellFormedUnicode(remotePath) ||
      typeof blobSha != 'string' || !GITHUB_SHA_RXP.test(blobSha) ||
      typeof commitSha != 'string' || !GITHUB_SHA_RXP.test(commitSha)) {
      throw new Error('Invalid GitHub user API metadata')
    }

    batchVersion ??= version
    batchCommit ??= commitSha
    if (version != batchVersion || commitSha != batchCommit ||
      paths.has(remotePath) || !remotePath.startsWith(version + '/') ||
      !/\.js$/i.test(remotePath) || remotePath.includes('\\')) {
      throw new Error('Invalid or duplicate GitHub user API path')
    }

    const relativeParts = remotePath.substring(version.length + 1).split('/')
    const fileName = relativeParts.at(-1)
    const expectedGroup = relativeParts.length > 1 ? relativeParts[0] : version
    if (!fileName || fileName.length <= 3 ||
      relativeParts.some(part => !part || part == '.' || part == '..') ||
      group != expectedGroup) {
      throw new Error('Invalid GitHub user API group')
    }

    paths.add(remotePath)
    const id = createGitHubUserApiId(remotePath)
    if (ids.has(id)) throw new Error(`Invalid or duplicate GitHub user API ID: ${id}`)
    ids.add(id)
    const bytes = Buffer.byteLength(script, 'utf8')
    if (bytes > GITHUB_USER_API_LIMITS.maxScriptBytes) {
      throw new Error(`GitHub user API script is too large: ${remotePath}`)
    }
    totalBytes += bytes
    snapshots.push({
      id,
      script,
      remote: {
        provider: 'github',
        repository: GITHUB_REPOSITORY,
        version,
        group,
        path: remotePath,
        blobSha,
        commitSha,
      },
    })
  }

  if (totalBytes > GITHUB_USER_API_LIMITS.maxTotalBytes) {
    throw new Error('GitHub user API batch is too large')
  }
  return snapshots
}

const createGitHubUserApiId = (remotePath: string) => {
  return 'user_api_github_' + createHash('sha256')
    .update(remotePath)
    .digest('hex')
    .substring(0, 16)
}

export const prepareApisFromGitHub = async(
  items: LX.UserApi.GitHubImportItem[],
): Promise<UserApiState> => {
  const snapshots = validateGitHubImportItems(items)

  const nextUserApis: LX.UserApi.UserApiInfo[] = []
  const nextScripts = new Map<string, string>()
  for (const { id, script, remote } of snapshots) {
    let scriptInfo: ReturnType<typeof parseScriptInfo>
    try {
      scriptInfo = parseScriptInfo(script)
    } catch {
      throw createGitHubUserApiError('GITHUB_INVALID_SCRIPT', remote.path)
    }
    nextUserApis.push({
      id,
      ...scriptInfo,
      allowShowUpdateAlert: true,
      remote,
    })
    nextScripts.set(id, await deflateScript(script))
  }

  return {
    apiList: nextUserApis,
    scripts: nextScripts,
  }
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

export const prepareUserApisFromSync = async(
  data: LX.Sync.UserApi.Data,
): Promise<UserApiState> => {
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
  return {
    apiList: nextUserApis,
    scripts: nextScripts,
  }
}
