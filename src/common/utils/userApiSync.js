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
