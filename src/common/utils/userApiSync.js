const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { types: { isProxy } } = require('node:util')

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
const USER_API_SYNC_DATA_PROPERTIES = ['source', 'updatedAt', 'apis']

const getPlainOwnDataDescriptors = (value, errorMessage) => {
  if (value == null || typeof value !== 'object' || isProxy(value)) {
    throw new Error(errorMessage)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(errorMessage)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (!Reflect.ownKeys(descriptors).every(key => 'value' in descriptors[key])) {
    throw new Error(errorMessage)
  }
  return descriptors
}

const getOwnArrayValues = (value, errorMessage) => {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(errorMessage)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (!Reflect.ownKeys(descriptors).every(key => 'value' in descriptors[key])) {
    throw new Error(errorMessage)
  }
  const values = []
  for (let index = 0; index < descriptors.length.value; index++) {
    const descriptor = descriptors[index]
    if (!descriptor || !('value' in descriptor)) throw new Error(errorMessage)
    values.push(descriptor.value)
  }
  return values
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

const canonicalizeRemote = remote => {
  if (remote == null) return undefined
  const descriptors = getPlainOwnDataDescriptors(remote, 'Invalid user API remote metadata')
  if (!GITHUB_REMOTE_PROPERTIES.every(property => descriptors[property])) {
    throw new Error('Invalid user API remote metadata')
  }

  const provider = descriptors.provider.value
  const repository = descriptors.repository.value
  const version = descriptors.version.value
  const group = descriptors.group.value
  const path = descriptors.path.value
  const blobSha = descriptors.blobSha.value
  const commitSha = descriptors.commitSha.value
  if (typeof provider !== 'string' || provider !== 'github' ||
    typeof repository !== 'string' || repository !== GITHUB_REPOSITORY ||
    typeof version !== 'string' || !GITHUB_VERSION_RXP.test(version) ||
    typeof group !== 'string' || !group || !isWellFormedUnicode(group) ||
    typeof path !== 'string' || !isWellFormedUnicode(path) ||
    typeof blobSha !== 'string' || !GITHUB_SHA_RXP.test(blobSha) ||
    typeof commitSha !== 'string' || !GITHUB_SHA_RXP.test(commitSha) ||
    !path.startsWith(version + '/') || !/\.js$/i.test(path) || path.includes('\\')) {
    throw new Error('Invalid user API remote metadata')
  }

  const relativeParts = path.substring(version.length + 1).split('/')
  const fileName = relativeParts.at(-1)
  const expectedGroup = relativeParts.length > 1 ? relativeParts[0] : version
  if (!fileName || fileName.length <= 3 ||
    relativeParts.some(part => !part || part === '.' || part === '..') ||
    group !== expectedGroup) {
    throw new Error('Invalid user API remote group or path')
  }

  return { provider, repository, version, group, path, blobSha, commitSha }
}

const canonicalizeSyncApi = (api, options = {}) => {
  const descriptors = getPlainOwnDataDescriptors(api, 'Invalid user API record')
  const id = descriptors.id?.value
  if (options.skipEmptyId && !id) return null
  if (typeof id !== 'string' || !id) {
    throw new Error('Invalid or duplicate user API id')
  }

  for (const key of ['name', 'description', 'author', 'homepage', 'version']) {
    if (typeof descriptors[key]?.value !== 'string') throw new Error('Invalid user API ' + key)
  }

  const scriptEncoding = descriptors.scriptEncoding?.value
  const script = descriptors.script?.value
  if (scriptEncoding !== 'plain' || typeof script !== 'string' ||
    script.length > MAX_USER_API_SCRIPT_LENGTH) {
    throw new Error('Invalid user API script')
  }

  const allowShowUpdateAlert = descriptors.allowShowUpdateAlert?.value
  if (allowShowUpdateAlert != null && typeof allowShowUpdateAlert !== 'boolean') {
    throw new Error('Invalid user API update alert setting')
  }

  const originalRemote = descriptors.remote?.value
  const remote = canonicalizeRemote(originalRemote)
  return {
    value: {
      id,
      name: descriptors.name.value,
      description: descriptors.description.value,
      author: descriptors.author.value,
      homepage: descriptors.homepage.value,
      version: descriptors.version.value,
      allowShowUpdateAlert,
      ...(remote == null ? {} : { remote }),
      scriptEncoding,
      script,
    },
    original: api,
    originalRemote,
  }
}

const canonicalizeUserApiSyncData = (data, options = {}) => {
  const descriptors = getPlainOwnDataDescriptors(data, 'Invalid user API sync data')
  if (!USER_API_SYNC_DATA_PROPERTIES.every(property => descriptors[property])) {
    throw new Error('Invalid user API sync data')
  }

  const source = descriptors.source.value
  const updatedAt = descriptors.updatedAt.value
  const originalApis = descriptors.apis.value
  if (source !== 'desktop' || !Number.isFinite(updatedAt)) {
    throw new Error('Invalid user API sync data')
  }

  const apiValues = getOwnArrayValues(originalApis, 'Invalid user API sync data')
  const ids = new Set()
  const snapshots = []
  for (const api of apiValues) {
    const snapshot = canonicalizeSyncApi(api, {
      skipEmptyId: options.skipEmptyIds,
    })
    if (snapshot == null) continue
    if (!options.allowDuplicateIds && ids.has(snapshot.value.id)) {
      throw new Error('Invalid or duplicate user API id')
    }
    ids.add(snapshot.value.id)
    snapshots.push(snapshot)
  }

  if (options.freezeOriginal) {
    for (const snapshot of snapshots) {
      if (snapshot.originalRemote != null) Object.freeze(snapshot.originalRemote)
      Object.freeze(snapshot.original)
    }
    Object.freeze(originalApis)
    Object.freeze(data)
  }

  return {
    source: 'desktop',
    updatedAt,
    apis: snapshots.map(snapshot => snapshot.value),
  }
}

const createStableUserApiSyncDataFromCanonical = data => ({
  source: 'desktop',
  apis: data.apis,
})

const createUserApiSyncMD5FromCanonical = data => {
  return crypto.createHash('md5')
    .update(JSON.stringify(createStableUserApiSyncDataFromCanonical(data)))
    .digest('hex')
}

const createUserApiSyncData = async(apis, getScript, options = {}) => {
  const syncApis = []
  for (const api of apis) {
    try {
      const descriptors = getPlainOwnDataDescriptors(api, 'Invalid user API record')
      const id = descriptors.id?.value
      const remote = canonicalizeRemote(descriptors.remote?.value)
      syncApis.push({
        id,
        name: normalizeApiText(descriptors.name?.value),
        description: normalizeApiText(descriptors.description?.value),
        author: normalizeApiText(descriptors.author?.value),
        homepage: normalizeApiText(descriptors.homepage?.value),
        version: normalizeApiText(descriptors.version?.value),
        allowShowUpdateAlert: descriptors.allowShowUpdateAlert?.value,
        ...(remote == null ? {} : { remote }),
        scriptEncoding: 'plain',
        script: decodeUserApiScript(await getScript(id)),
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

const createStableUserApiSyncData = data => {
  return createStableUserApiSyncDataFromCanonical(canonicalizeUserApiSyncData(data))
}

const createUserApiSyncMD5 = data => {
  return createUserApiSyncMD5FromCanonical(canonicalizeUserApiSyncData(data))
}

const createUserApiSyncMeta = data => {
  const canonical = canonicalizeUserApiSyncData(data)
  return {
    md5: createUserApiSyncMD5FromCanonical(canonical),
    updatedAt: canonical.updatedAt,
    count: canonical.apis.length,
  }
}

// Freeze accepted graphs so async consumers cannot mutate data after validation.
const assertUserApiSyncData = data => {
  canonicalizeUserApiSyncData(data, { freezeOriginal: true })
  return data
}

const mergeUserApiSyncData = (baseData, incomingData, options = {}) => {
  const updatedAt = options.updatedAt ?? Date.now()
  const canonicalOptions = {
    allowDuplicateIds: true,
    skipEmptyIds: true,
  }
  const base = canonicalizeUserApiSyncData(baseData, canonicalOptions)
  const incoming = canonicalizeUserApiSyncData(incomingData, canonicalOptions)
  const apiMap = new Map()
  for (const api of base.apis) {
    apiMap.set(api.id, api)
  }
  for (const api of incoming.apis) {
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
