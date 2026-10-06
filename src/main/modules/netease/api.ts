import fs from 'node:fs'
import { createRequire } from 'node:module'
import { compileFunction } from 'node:vm'
import path from 'node:path'

// Load the pinned package's individual endpoints, never its main/server entry.
declare const __non_webpack_require__: NodeRequire

const endpointNames = [
  'login_qr_key', 'login_qr_create', 'login_qr_check', 'login_status', 'logout',
  'recommend_songs', 'personal_fm', 'personal_fm_mode', 'personalized',
  'personalized_newsong', 'recommend_resource', 'homepage_block_page', 'batch',
  'toplist_detail', 'album_songsaleboard', 'playlist_detail', 'user_playlist',
  'song_detail', 'like', 'fm_trash', 'song_url_v1', 'api',
] as const

export type NeteaseEndpoint = typeof endpointNames[number]
type Query = Record<string, any>
type Request = (...args: any[]) => Promise<any>
type Endpoint = (query: Query, request: Request) => Promise<any>
type NeteaseApi = Record<NeteaseEndpoint, (query?: Query) => Promise<any>> & {
  prepare: (names: readonly NeteaseEndpoint[]) => void
}

interface Dependencies {
  loadEndpoint?: (name: NeteaseEndpoint) => Endpoint
  loadRequest?: () => Request
  parseCookie?: (cookie: string) => Record<string, unknown>
  onLoad?: (name: NeteaseEndpoint) => void
  trackActivity?: (name: NeteaseEndpoint) => boolean
  onActivity?: (active: number) => void
}

export const createNeteaseApiClient = (dependencies: Dependencies = {}): NeteaseApi => {
  let packageRoot: string | undefined
  let request: Request | undefined
  let parseCookie = dependencies.parseCookie
  let active = 0
  const endpoints = new Map<NeteaseEndpoint, Endpoint>()
  const root = () => packageRoot ??= path.dirname(__non_webpack_require__.resolve('@neteasecloudmusicapienhanced/api'))
  const loadEndpoint = (name: NeteaseEndpoint) => {
    let endpoint = endpoints.get(name)
    if (!endpoint) {
      endpoint = dependencies.loadEndpoint
        ? dependencies.loadEndpoint(name)
        : __non_webpack_require__(path.join(root(), 'module', `${name}.js`)) as Endpoint
      endpoints.set(name, endpoint)
      dependencies.onLoad?.(name)
    }
    return endpoint
  }
  const loadRequest = () => {
    if (request) return request
    if (dependencies.loadRequest) return request = dependencies.loadRequest()
    // The pinned SDK reads an anonymous_token file at module initialization.
    // Supply its empty bootstrap token in memory, scoped to this request module;
    // never touch a shared OS temp file or patch global require/os/fs behavior.
    const requestPath = path.join(root(), 'util', 'request.js')
    const requestDirectory = path.dirname(requestPath)
    const tokenPath = path.join(requestDirectory, 'anonymous_token')
    const nativeRequire = createRequire(requestPath)
    const scopedFs = new Proxy(fs, {
      get(target, property) {
        if (property == 'readFileSync') {
          return (filename: fs.PathOrFileDescriptor, options?: any) => {
            if (filename == tokenPath) return ''
            return target.readFileSync(filename, options)
          }
        }
        return Reflect.get(target, property)
      },
    })
    const scopedRequire = Object.assign((id: string) => {
      if (id == 'os') return { ...nativeRequire('os'), tmpdir: () => requestDirectory }
      if (id == 'fs') return scopedFs
      return nativeRequire(id)
    }, nativeRequire)
    const requestModule = { exports: {} }
    compileFunction(fs.readFileSync(requestPath, 'utf8'), ['exports', 'require', 'module', '__filename', '__dirname'], {
      filename: requestPath,
    })(requestModule.exports, scopedRequire, requestModule, requestPath, requestDirectory)
    return request = requestModule.exports as Request
  }
  const send: Request = async(...args) => loadRequest()(...args)
  const normalizeCookie = (cookie: unknown) => {
    if (typeof cookie != 'string') return cookie || {}
    parseCookie ??= (__non_webpack_require__(path.join(root(), 'util', 'index.js')) as { cookieToJson: NonNullable<typeof parseCookie> }).cookieToJson
    return parseCookie(cookie)
  }
  const client: Partial<NeteaseApi> = {}
  for (const name of endpointNames) {
    client[name] = async(query = {}) => {
      const endpoint = loadEndpoint(name)
      const tracked = dependencies.trackActivity?.(name) ?? true
      if (tracked) dependencies.onActivity?.(++active)
      try {
        return await endpoint({ ...query, cookie: normalizeCookie(query.cookie) }, send)
      } finally {
        if (tracked) dependencies.onActivity?.(--active)
      }
    }
  }
  client.prepare = names => {
    for (const name of names) loadEndpoint(name)
    loadRequest()
  }
  return client as NeteaseApi
}
