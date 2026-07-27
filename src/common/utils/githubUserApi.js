const REPOSITORY = 'Macrohard0001/lx-ikun-music-sources'
const VERSION_RXP = /^[vV](\d{6})$/
const SHA_RXP = /^[0-9a-f]{40}$/i
const ENTRY_TYPES = new Set(['blob', 'tree', 'commit'])

const GITHUB_USER_API_LIMITS = Object.freeze({
  maxScriptBytes: 9_000_000,
  maxFiles: 200,
  maxTotalBytes: 50_000_000,
  maxConcurrency: 4,
})

const createGitHubUserApiError = (code, detail = '') => Object.assign(
  new Error(detail ? `${code}: ${detail}` : code),
  { code, detail },
)

const assertTreeEntry = item => {
  if (!item || !ENTRY_TYPES.has(item.type) || typeof item.path != 'string' || !item.path) {
    throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'tree entry')
  }
  if ((item.type == 'commit' || item.type == 'tree') && !SHA_RXP.test(item.sha ?? '')) {
    throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', item.path)
  }
  if (item.type == 'blob' &&
    (!SHA_RXP.test(item.sha ?? '') || !Number.isSafeInteger(item.size) || item.size < 0)) {
    throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', item.path)
  }
}

const assertBatchLimits = files => {
  if (files.length > GITHUB_USER_API_LIMITS.maxFiles) {
    throw createGitHubUserApiError('GITHUB_BATCH_LIMIT', 'file count')
  }

  let totalBytes = 0
  for (const file of files) {
    if (file.size > GITHUB_USER_API_LIMITS.maxScriptBytes) {
      throw createGitHubUserApiError('GITHUB_BATCH_LIMIT', file.path)
    }
    totalBytes += file.size
    if (totalBytes > GITHUB_USER_API_LIMITS.maxTotalBytes) {
      throw createGitHubUserApiError('GITHUB_BATCH_LIMIT', 'total bytes')
    }
  }
}

const parseGitHubUserApiSnapshot = (branchData, treeData) => {
  const commitSha = branchData?.commit?.sha
  if (!SHA_RXP.test(commitSha ?? '')) {
    throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'commit SHA')
  }
  if (!treeData || !Array.isArray(treeData.tree) || typeof treeData.truncated != 'boolean') {
    throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'tree')
  }
  if (treeData.truncated) throw createGitHubUserApiError('GITHUB_TREE_TRUNCATED')

  treeData.tree.forEach(assertTreeEntry)

  const versions = treeData.tree.flatMap(item => {
    if (item.type != 'tree' || item.path.includes('/')) return []
    const match = VERSION_RXP.exec(item.path)
    return match ? [{ path: item.path, number: Number(match[1]) }] : []
  }).sort((a, b) => b.number - a.number || b.path.localeCompare(a.path))
  if (!versions.length) throw createGitHubUserApiError('GITHUB_VERSION_NOT_FOUND')

  const version = versions[0].path
  const prefix = `${version}/`
  const files = treeData.tree.flatMap(item => {
    if (item.type != 'blob' || !item.path.startsWith(prefix) || !/\.js$/i.test(item.path)) return []

    const relativeParts = item.path.substring(prefix.length).split('/')
    return [{
      path: item.path,
      blobSha: item.sha,
      size: item.size,
      group: relativeParts.length > 1 ? relativeParts[0] : version,
    }]
  })
  if (!files.length) throw createGitHubUserApiError('GITHUB_SCRIPTS_NOT_FOUND')

  assertBatchLimits(files)
  return { commitSha, version, files }
}

const buildGitHubUserApiRawUrl = (commitSha, filePath) => {
  if (!SHA_RXP.test(commitSha ?? '')) {
    throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'commit SHA')
  }
  if (typeof filePath != 'string' || !filePath) {
    throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'file path')
  }
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${REPOSITORY}/${commitSha}/${encodedPath}`
}

const buildGitHubUserApiCdnUrl = (commitSha, filePath) => {
  if (!SHA_RXP.test(commitSha ?? '')) {
    throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'commit SHA')
  }
  if (typeof filePath != 'string' || !filePath) {
    throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'file path')
  }
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  return `https://cdn.jsdelivr.net/gh/${REPOSITORY}@${commitSha}/${encodedPath}`
}

const assertDownloadSnapshot = snapshot => {
  if (!snapshot || !SHA_RXP.test(snapshot.commitSha ?? '') ||
    typeof snapshot.version != 'string' || !VERSION_RXP.test(snapshot.version) ||
    !Array.isArray(snapshot.files)) {
    throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'snapshot')
  }
  if (!snapshot.files.length) throw createGitHubUserApiError('GITHUB_SCRIPTS_NOT_FOUND')

  for (const file of snapshot.files) {
    if (!file || typeof file.path != 'string' || !file.path ||
      typeof file.group != 'string' || !file.group ||
      !SHA_RXP.test(file.blobSha ?? '') ||
      !Number.isSafeInteger(file.size) || file.size < 0) {
      throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'snapshot file')
    }
  }
  assertBatchLimits(snapshot.files)
}

const downloadGitHubUserApiScripts = async(snapshot, fetchScript) => {
  assertDownloadSnapshot(snapshot)
  if (typeof fetchScript != 'function') {
    throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'fetch script')
  }

  const results = new Array(snapshot.files.length)
  let nextIndex = 0
  let totalBytes = 0
  let hasError = false
  let firstError

  const worker = async() => {
    while (!hasError && nextIndex < snapshot.files.length) {
      const index = nextIndex++
      const file = snapshot.files[index]
      try {
        const script = await fetchScript(file)
        if (typeof script != 'string') {
          throw createGitHubUserApiError('GITHUB_INVALID_SCRIPT', file.path)
        }

        const bytes = Buffer.byteLength(script, 'utf8')
        if (bytes > GITHUB_USER_API_LIMITS.maxScriptBytes) {
          throw createGitHubUserApiError('GITHUB_BATCH_LIMIT', file.path)
        }
        totalBytes += bytes
        if (totalBytes > GITHUB_USER_API_LIMITS.maxTotalBytes) {
          throw createGitHubUserApiError('GITHUB_BATCH_LIMIT', 'total bytes')
        }

        results[index] = {
          script,
          remote: {
            provider: 'github',
            repository: REPOSITORY,
            version: snapshot.version,
            group: file.group,
            path: file.path,
            blobSha: file.blobSha,
            commitSha: snapshot.commitSha,
          },
        }
      } catch (err) {
        if (!hasError) {
          hasError = true
          firstError = err
        }
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(GITHUB_USER_API_LIMITS.maxConcurrency, snapshot.files.length) },
    worker,
  ))
  if (hasError) throw firstError
  return results
}

module.exports = {
  GITHUB_USER_API_LIMITS,
  createGitHubUserApiError,
  parseGitHubUserApiSnapshot,
  buildGitHubUserApiRawUrl,
  buildGitHubUserApiCdnUrl,
  downloadGitHubUserApiScripts,
}
