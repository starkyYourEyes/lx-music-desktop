const HTTP_PROTOCOLS = new Set(['http:', 'https:'])
const XML_ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
}

const isValidXMLCodePoint = codePoint => {
  return codePoint == 0x9 || codePoint == 0xA || codePoint == 0xD ||
    (codePoint >= 0x20 && codePoint <= 0xD7FF) ||
    (codePoint >= 0xE000 && codePoint <= 0xFFFD) ||
    (codePoint >= 0x10000 && codePoint <= 0x10FFFF)
}

const decodeXMLText = (value) => {
  let isValid = true
  const decoded = String(value ?? '').replace(
    /&(#(?:[xX][0-9a-fA-F]+|\d+)|[a-zA-Z][\w.-]*);/g,
    (entity, name) => {
      if (name[0] != '#') {
        if (Object.prototype.hasOwnProperty.call(XML_ENTITIES, name)) return XML_ENTITIES[name]
        isValid = false
        return ''
      }

      const isHex = name[1] == 'x' || name[1] == 'X'
      const codePoint = Number.parseInt(name.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      if (!isValidXMLCodePoint(codePoint)) {
        isValid = false
        return ''
      }
      return String.fromCodePoint(codePoint)
    },
  )
  return isValid ? decoded : null
}

const decodePathname = pathname => {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return null
  }
}

const normalizeWebDAVRootUrl = value => {
  const url = new URL(String(value ?? ''))
  if (!HTTP_PROTOCOLS.has(url.protocol)) throw new Error('WebDAV URL must use HTTP or HTTPS')
  if (url.username || url.password) throw new Error('WebDAV URL must not contain credentials')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  url.hash = ''
  return url.toString()
}

const getRelativeWebDAVPath = (rootUrl, childUrl) => {
  let root
  let child
  try {
    root = new URL(normalizeWebDAVRootUrl(rootUrl))
    child = new URL(childUrl)
  } catch {
    return null
  }
  if (!HTTP_PROTOCOLS.has(child.protocol) || child.origin !== root.origin) return null
  if (child.username !== root.username || child.password !== root.password) return null

  const rootPath = decodePathname(root.pathname)
  const childPath = decodePathname(child.pathname)
  if (rootPath == null || childPath == null) return null

  const rootDir = rootPath.endsWith('/') ? rootPath : `${rootPath}/`
  if (childPath == rootDir || childPath == rootDir.slice(0, -1)) return ''
  if (!childPath.startsWith(rootDir)) return null

  const relativePath = childPath.slice(rootDir.length)
  if (relativePath.split('/').some(part => part == '.' || part == '..')) return null
  return relativePath
}

const resolveWebDAVHref = (rootUrl, baseUrl, href) => {
  try {
    const normalizedRoot = normalizeWebDAVRootUrl(rootUrl)
    const normalizedBase = normalizeWebDAVRootUrl(baseUrl)
    if (getRelativeWebDAVPath(normalizedRoot, normalizedBase) == null) return null

    const decodedHref = decodeXMLText(href)
    if (decodedHref == null) return null
    const url = new URL(decodedHref, normalizedBase)
    const path = getRelativeWebDAVPath(normalizedRoot, url.toString())
    return path == null ? null : { url: url.toString(), path }
  } catch {
    return null
  }
}

const createWebDAVFileUrl = (rootUrl, relativePath) => {
  const path = String(relativePath ?? '')
  if (!path || path.startsWith('/') || path.startsWith('\\')) {
    throw new Error('Invalid WebDAV file path')
  }

  const encodedPath = path.split('/').map(part => {
    const decoded = decodePathname(part)
    if (!decoded || decoded == '.' || decoded == '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new Error('Invalid WebDAV file path')
    }
    return encodeURIComponent(decoded)
  }).join('/')

  const normalizedRoot = normalizeWebDAVRootUrl(rootUrl)
  const url = new URL(encodedPath, normalizedRoot).toString()
  if (getRelativeWebDAVPath(normalizedRoot, url) == null) throw new Error('Invalid WebDAV file path')
  return url
}

module.exports = {
  normalizeWebDAVRootUrl,
  getRelativeWebDAVPath,
  resolveWebDAVHref,
  createWebDAVFileUrl,
}
