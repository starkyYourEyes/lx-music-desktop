export interface GitHubUserApiLimits {
  readonly maxScriptBytes: number
  readonly maxFiles: number
  readonly maxTotalBytes: number
  readonly maxConcurrency: number
}

export interface GitHubUserApiSnapshotFile {
  path: string
  blobSha: string
  size: number
  group: string
}

export interface GitHubUserApiSnapshot {
  commitSha: string
  version: string
  files: GitHubUserApiSnapshotFile[]
}

export interface GitHubUserApiRemoteInfo {
  provider: 'github'
  repository: 'Macrohard0001/lx-ikun-music-sources'
  version: string
  group: string
  path: string
  blobSha: string
  commitSha: string
}

export interface GitHubUserApiDownload {
  script: string
  remote: GitHubUserApiRemoteInfo
}

export interface GitHubUserApiError extends Error {
  code: string
  detail: string
}

export const GITHUB_USER_API_LIMITS: Readonly<GitHubUserApiLimits>

export const createGitHubUserApiError: (
  code: string,
  detail?: string,
) => GitHubUserApiError

export const parseGitHubUserApiSnapshot: (
  branchData: unknown,
  treeData: unknown,
) => GitHubUserApiSnapshot

export const buildGitHubUserApiRawUrl: (
  commitSha: string,
  filePath: string,
) => string

export const downloadGitHubUserApiScripts: (
  snapshot: GitHubUserApiSnapshot,
  fetchScript: (file: GitHubUserApiSnapshotFile) => string | Promise<string>,
) => Promise<GitHubUserApiDownload[]>
