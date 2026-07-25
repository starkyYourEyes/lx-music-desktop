const crypto = require('node:crypto')
const zlib = require('node:zlib')

const MAX_USER_API_SCRIPT_LENGTH = 10 * 1024 * 1024

const decodeUserApiScript = script => {
  const rawScript = String(script ?? '')
  if (!rawScript.startsWith('gz_')) return rawScript
  return zlib.inflateSync(Buffer.from(rawScript.substring(3), 'base64'), {
    maxOutputLength: MAX_USER_API_SCRIPT_LENGTH,
  }).toString('utf8')
}

const normalizeApiText = value => String(value ?? '')

const GITHUB_REPOSITORY = 'Macrohard0001/lx-ikun-music-sources'
const GITHUB_VERSION_RXP = /^[vV]\d{6}$/
const GITHUB_SHA_RXP = /^[0-9a-f]{40}$/i
const GITHUB_REMOTE_PROPERTIES = [
  'provider',
  'repository',
  'version',
  'group',
  'path',
  'blobSha',
  'commitSha',
]

const normalizeRemote = remote => remote == null
  ? undefined
  : {
      provider: remote.provider,
      repository: remote.repository,
      version: normalizeApiText(remote.version),
      group: normalizeApiText(remote.group),
      path: normalizeApiText(remote.path),
      blobSha: normalizeApiText(remote.blobSha),
      commitSha: normalizeApiText(remote.commitSha),
    }

const isPlainOwnDataRecord = value => {
  if (value == null || typeof value != 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype != Object.prototype && prototype != null) return false
  return Object.values(Object.getOwnPropertyDescriptors(value))
    .every(descriptor => 'value' in descriptor)
}

const hasOwnProperties = (value, properties) => {
  return properties.every(property => Object.prototype.hasOwnProperty.call(value, property))
}

const isWellFormedUnicode = value => {
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

const assertRemote = remote => {
  if (!isPlainOwnDataRecord(remote) || !hasOwnProperties(remote, GITHUB_REMOTE_PROPERTIES) ||
    remote.provider != 'github' || remote.repository != GITHUB_REPOSITORY ||
    typeof remote.version != 'string' || !GITHUB_VERSION_RXP.test(remote.version) ||
    typeof remote.group != 'string' || !remote.group || !isWellFormedUnicode(remote.group) ||
    typeof remote.path != 'string' || !isWellFormedUnicode(remote.path) ||
    typeof remote.blobSha != 'string' || !GITHUB_SHA_RXP.test(remote.blobSha) ||
    typeof remote.commitSha != 'string' || !GITHUB_SHA_RXP.test(remote.commitSha) ||
    !remote.path.startsWith(remote.version + '/') || !/\.js$/i.test(remote.path) ||
    remote.path.includes('\\')) {
    throw new Error('Invalid user API remote metadata')
  }

  const relativeParts = remote.path.substring(remote.version.length + 1).split('/')
  const fileName = relativeParts.at(-1)
  const expectedGroup = relativeParts.length > 1 ? relativeParts[0] : remote.version
  if (!fileName || fileName.length <= 3 ||
    relativeParts.some(part => !part || part == '.' || part == '..') ||
    remote.group != expectedGroup) {
    throw new Error('Invalid user API remote group or path')
  }
}

const createUserApiSyncData = async(apis, getScript, options = {}) => {
  const syncApis = []
  for (const api of apis) {
    try {
      syncApis.push({
        id: api.id,
        name: normalizeApiText(api.name),
        description: normalizeApiText(api.description),
        author: normalizeApiText(api.author),
        homepage: normalizeApiText(api.homepage),
        version: normalizeApiText(api.version),
        allowShowUpdateAlert: api.allowShowUpdateAlert,
        ...(api.remote == null ? {} : { remote: normalizeRemote(api.remote) }),
        scriptEncoding: 'plain',
        script: decodeUserApiScript(await getScript(api.id)),
      })
    } catch (err) {
      options.onScriptError?.(err, api)
    }
  }

  return {
    source: 'desktop',
    updatedAt: options.updatedAt ?? Date.now(),
    apis: syncApis,
  }
}

const createStableUserApiSyncData = data => ({
  source: 'desktop',
  apis: data.apis.map(api => ({
    id: api.id,
    name: normalizeApiText(api.name),
    description: normalizeApiText(api.description),
    author: normalizeApiText(api.author),
    homepage: normalizeApiText(api.homepage),
    version: normalizeApiText(api.version),
    allowShowUpdateAlert: api.allowShowUpdateAlert,
    ...(api.remote == null ? {} : { remote: normalizeRemote(api.remote) }),
    scriptEncoding: api.scriptEncoding,
    script: api.script,
  })),
})

const createUserApiSyncMD5 = data => {
  return crypto.createHash('md5')
    .update(JSON.stringify(createStableUserApiSyncData(data)))
    .digest('hex')
}

const createUserApiSyncMeta = data => ({
  md5: createUserApiSyncMD5(data),
  updatedAt: data.updatedAt,
  count: data.apis.length,
})

const assertUserApiSyncData = data => {
  if (!data || data.source != 'desktop' || !Number.isFinite(data.updatedAt) || !Array.isArray(data.apis)) {
    throw new Error('Invalid user API sync data')
  }

  const ids = new Set()
  for (const api of data.apis) {
    if (!api || typeof api.id != 'string' || !api.id || ids.has(api.id)) {
      throw new Error('Invalid or duplicate user API id')
    }
    ids.add(api.id)
    for (const key of ['name', 'description', 'author', 'homepage', 'version']) {
      if (typeof api[key] != 'string') throw new Error(`Invalid user API ${key}`)
    }
    if (api.scriptEncoding != 'plain' || typeof api.script != 'string' || api.script.length > MAX_USER_API_SCRIPT_LENGTH) {
      throw new Error('Invalid user API script')
    }
    if (api.allowShowUpdateAlert != null && typeof api.allowShowUpdateAlert != 'boolean') {
      throw new Error('Invalid user API update alert setting')
    }
    if (api.remote != null) assertRemote(api.remote)
  }
  return data
}

const mergeUserApiSyncData = (baseData, incomingData, options = {}) => {
  const updatedAt = options.updatedAt ?? Date.now()
  const apiMap = new Map()
  for (const api of baseData.apis) {
    if (!api.id) continue
    apiMap.set(api.id, api)
  }
  for (const api of incomingData.apis) {
    if (!api.id) continue
    apiMap.set(api.id, api)
  }

  return {
    source: 'desktop',
    updatedAt,
    apis: [...apiMap.values()],
  }
}

module.exports = {
  decodeUserApiScript,
  createUserApiSyncData,
  createStableUserApiSyncData,
  createUserApiSyncMeta,
  createUserApiSyncMD5,
  assertUserApiSyncData,
  mergeUserApiSyncData,
}
