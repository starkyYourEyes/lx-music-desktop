export interface ResolvedWebDAVHref {
  url: string
  path: string
}

export const normalizeWebDAVRootUrl: (value: unknown) => string

export const getRelativeWebDAVPath: (rootUrl: string, childUrl: string) => string | null

export const resolveWebDAVHref: (
  rootUrl: string,
  baseUrl: string,
  href: string,
) => ResolvedWebDAVHref | null

export const createWebDAVFileUrl: (rootUrl: string, relativePath: string) => string
