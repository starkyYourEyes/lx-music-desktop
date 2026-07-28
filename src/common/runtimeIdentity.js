const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const createUrlSchemeRxp = protocolScheme => new RegExp(`^${escapeRegExp(protocolScheme)}:\\/\\/`)

const desktopClient = Object.freeze({
  kind: 'desktop',
  isMobile: false,
})
const mobileClient = Object.freeze({
  kind: 'mobile',
  isMobile: true,
})

const classifySyncClient = (clientType, identity) => {
  if (typeof clientType !== 'string') return null
  if (clientType === identity.syncDesktopId) return desktopClient
  if (clientType === identity.syncMobileId) return mobileClient
  return null
}

module.exports = {
  createUrlSchemeRxp,
  classifySyncClient,
}
