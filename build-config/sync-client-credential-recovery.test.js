const assert = require('node:assert/strict')
const path = require('node:path')
const { describe, it } = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const useSyncPath = path.join(__dirname, '../src/renderer/core/useApp/useSync.ts')
const SYNC_CODE = {
  missingAuthCode: 'Missing auth code',
  authFailed: 'Auth failed',
  msgBlockedIp: 'Blocked IP',
  connecting: 'Connecting...',
}

const createSyncState = () => ({
  enable: true,
  mode: 'client',
  isShowSyncMode: false,
  isShowAuthCodeModal: false,
  deviceName: '',
  type: 'list',
  server: {
    port: '',
    status: { status: false, message: '', address: [], code: '', devices: [] },
  },
  client: {
    host: 'http://127.0.0.1:9527',
    status: { status: false, message: '', address: [] },
  },
})

const createHarness = () => {
  const sync = createSyncState()
  let listener
  const useSync = loadTsModule(useSyncPath, {
    '@common/utils/vueTools': {
      markRaw: value => value,
      onBeforeUnmount: () => {},
    },
    '@renderer/utils/ipc': {
      onSyncAction: callback => {
        listener = callback
        return () => {}
      },
      sendSyncAction: async() => {},
    },
    '@renderer/store': { sync },
    '@renderer/store/setting': {
      appSetting: {
        'sync.enable': true,
        'sync.mode': 'client',
        'sync.server.port': '',
        'sync.client.host': sync.client.host,
      },
    },
    '@common/constants_sync': { SYNC_CODE },
  }).default
  useSync()
  assert.equal(typeof listener, 'function')
  return {
    sync,
    publish(status) {
      listener({ params: { action: 'client_status', data: status } })
    },
  }
}

describe('sync client credential recovery', () => {
  it('projects an undecryptable reason and opens re-authentication', () => {
    const harness = createHarness()
    harness.publish({
      status: false,
      message: 'credential unavailable',
      address: [],
      unavailableReason: 'credential_undecryptable',
    })

    assert.equal(harness.sync.client.status.unavailableReason, 'credential_undecryptable')
    assert.equal(harness.sync.isShowAuthCodeModal, true)

    harness.publish({ status: false, message: 'Connect service failed', address: [] })
    assert.equal(Object.hasOwn(harness.sync.client.status, 'unavailableReason'), false)
    assert.equal(harness.sync.isShowAuthCodeModal, false)
  })

  it('preserves existing authentication and connection modal behavior', () => {
    for (const message of [SYNC_CODE.missingAuthCode, SYNC_CODE.authFailed]) {
      const harness = createHarness()
      harness.publish({ status: false, message, address: [] })
      assert.equal(harness.sync.isShowAuthCodeModal, true)
    }

    const harness = createHarness()
    harness.publish({ status: false, message: 'Connect service failed', address: [] })
    assert.equal(harness.sync.isShowAuthCodeModal, false)
    harness.sync.isShowAuthCodeModal = true
    harness.publish({ status: true, message: '', address: ['127.0.0.1'] })
    assert.equal(harness.sync.isShowAuthCodeModal, false)
  })
})
