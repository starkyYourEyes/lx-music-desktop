import { httpFetch } from './request'
import {
  createGitHubUserApiError,
  parseGitHubUserApiSnapshot,
  buildGitHubUserApiRawUrl,
  buildGitHubUserApiCdnUrl,
  downloadGitHubUserApiScripts,
} from '@common/utils/githubUserApi'

const branchUrl = 'https://api.github.com/repos/Macrohard0001/lx-ikun-music-sources/branches/main'
const treeUrlPrefix = 'https://api.github.com/repos/Macrohard0001/lx-ikun-music-sources/git/trees/'
const apiHeaders = { Accept: 'application/vnd.github+json' }
const commitShaRxp = /^[0-9a-f]{40}$/i
const retryDelays = [250, 1_000]
const retryableErrorCodes = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT',
])

const wait = delay => new Promise(resolve => setTimeout(resolve, delay))

const isRetryableError = error => {
  return retryableErrorCodes.has(error?.code) || error?.message == 'socket hang up'
}

const assertResponse = (response, url) => {
  const statusCode = response?.statusCode ?? 0
  if (statusCode == 200) return response

  const headers = response?.headers ?? {}
  if (statusCode == 403 && headers['x-ratelimit-remaining'] == '0') {
    const reset = headers['x-ratelimit-reset']
    throw createGitHubUserApiError(
      'GITHUB_RATE_LIMIT',
      reset == null ? '' : String(reset),
    )
  }
  throw createGitHubUserApiError('GITHUB_HTTP_ERROR', `${statusCode} ${url}`)
}

export const createGitHubUserApiClient = (request = httpFetch, delay = wait) => {
  const requestWithRetry = async(url, options) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(url, options).promise
      } catch (error) {
        if (!isRetryableError(error) || attempt >= retryDelays.length) throw error
        await delay(retryDelays[attempt])
      }
    }
  }

  const requestApi = async url => {
    const response = await requestWithRetry(url, {
      headers: apiHeaders,
      follow_max: 3,
      timeout: 15_000,
    })
    return assertResponse(response, url).body
  }

  const getSnapshot = async() => {
    const branchData = await requestApi(branchUrl)
    const commitSha = branchData?.commit?.sha
    if (!commitShaRxp.test(commitSha ?? '')) {
      throw createGitHubUserApiError('GITHUB_INVALID_RESPONSE', 'commit SHA')
    }

    const treeUrl = `${treeUrlPrefix}${commitSha}?recursive=1`
    const treeData = await requestApi(treeUrl)
    return parseGitHubUserApiSnapshot(branchData, treeData)
  }

  const downloadSnapshot = snapshot => downloadGitHubUserApiScripts(
    snapshot,
    async file => {
      const requestOptions = {
        format: 'text',
        follow_max: 3,
        timeout: 30_000,
      }
      const rawUrl = buildGitHubUserApiRawUrl(snapshot.commitSha, file.path)
      let url = rawUrl
      let successfulResponse
      try {
        successfulResponse = assertResponse(
          await request(rawUrl, requestOptions).promise,
          rawUrl,
        )
      } catch {
        url = buildGitHubUserApiCdnUrl(snapshot.commitSha, file.path)
        successfulResponse = assertResponse(
          await requestWithRetry(url, requestOptions),
          url,
        )
      }
      const { raw } = successfulResponse
      const script = raw instanceof Uint8Array
        ? Buffer.from(raw).toString('utf8')
        : successfulResponse.body
      if (typeof script != 'string') {
        throw createGitHubUserApiError('GITHUB_INVALID_SCRIPT', file.path)
      }
      return script
    },
  )

  return { getSnapshot, downloadSnapshot }
}

const client = createGitHubUserApiClient()

export const getGitHubUserApiSnapshot = () => client.getSnapshot()
export const downloadGitHubUserApiSnapshot = snapshot => client.downloadSnapshot(snapshot)
