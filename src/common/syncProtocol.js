const { PROJECT_IDENTITY } = require('./projectIdentity')

const CURRENT_SYNC_PROTOCOL = Object.freeze({
  id: 'current',
  syncDesktopId: PROJECT_IDENTITY.syncDesktopId,
  syncMobileId: PROJECT_IDENTITY.syncMobileId,
  syncAuthPrefix: PROJECT_IDENTITY.syncAuthPrefix,
  syncConnectMessage: PROJECT_IDENTITY.syncConnectMessage,
})

const LEGACY_SYNC_PROTOCOL = Object.freeze({
  id: 'legacy',
  syncDesktopId: 'lx_music_desktop',
  syncMobileId: 'lx_music_mobile',
  syncAuthPrefix: 'lx-music auth::',
  syncConnectMessage: 'lx-music connect',
})

const SYNC_PROTOCOLS = Object.freeze([
  CURRENT_SYNC_PROTOCOL,
  LEGACY_SYNC_PROTOCOL,
])

const getSyncProtocol = protocolId =>
  protocolId === LEGACY_SYNC_PROTOCOL.id
    ? LEGACY_SYNC_PROTOCOL
    : CURRENT_SYNC_PROTOCOL

const getSyncProtocolCandidates = protocolId =>
  protocolId == null ? SYNC_PROTOCOLS : [getSyncProtocol(protocolId)]

module.exports = {
  CURRENT_SYNC_PROTOCOL,
  LEGACY_SYNC_PROTOCOL,
  SYNC_PROTOCOLS,
  getSyncProtocol,
  getSyncProtocolCandidates,
}
