export interface StorageRequestV1 { version: 1, type: 'capabilities.get' }

export interface StorageCapabilitiesV1 {
  version: 1
  schemaVersion: number
  securePersistence: 'available' | 'memory-only'
  recoveryMode: boolean
}
