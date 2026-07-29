import { safeStorage } from 'electron'
import type { StorageCapabilitiesV1 } from '../../../../common/storage/contracts'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '../../../../common/ipcNames'
import { mainHandle } from '../../../../common/mainIpc'
import { parseStorageRequest } from '../../../storage/validateStorageRequest'

interface SafeStorageCapabilitySource {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
}

interface StorageCapabilityState {
  schemaVersion: number
  recoveryMode: boolean
}

export interface StorageCapabilitiesHandlerDependencies {
  getCapabilities(): Promise<StorageCapabilitiesV1> | StorageCapabilitiesV1
}

export interface StorageCapabilitiesProviderDependencies {
  getStorageState(): Promise<StorageCapabilityState> | StorageCapabilityState
  safeStorage?: SafeStorageCapabilitySource
  platform?: NodeJS.Platform
}

export const getSecurePersistenceCapability = (
  storage: SafeStorageCapabilitySource = safeStorage,
  platform: NodeJS.Platform = process.platform,
): StorageCapabilitiesV1['securePersistence'] => {
  try {
    if (!storage.isEncryptionAvailable()) return 'memory-only'
    if (platform == 'linux' && storage.getSelectedStorageBackend?.() == 'basic_text') return 'memory-only'
    return 'available'
  } catch {
    return 'memory-only'
  }
}

export const createStorageCapabilitiesProvider = ({
  getStorageState,
  safeStorage: storage = safeStorage,
  platform = process.platform,
}: StorageCapabilitiesProviderDependencies): StorageCapabilitiesHandlerDependencies['getCapabilities'] => async() => {
  const state = await getStorageState()
  return {
    version: 1,
    schemaVersion: state.schemaVersion,
    securePersistence: getSecurePersistenceCapability(storage, platform),
    recoveryMode: state.recoveryMode,
  }
}

export const createStorageCapabilitiesHandler = ({ getCapabilities }: StorageCapabilitiesHandlerDependencies) => async(
  request: unknown,
): Promise<StorageCapabilitiesV1> => {
  parseStorageRequest(request)
  return getCapabilities()
}

const getStorageState = async(): Promise<StorageCapabilityState> => {
  const outcome = await global.lx.storage?.start()
  if (outcome?.status != 'ready') throw new Error('Storage is not ready')
  return { schemaVersion: outcome.schemaVersion, recoveryMode: false }
}

export default () => {
  const handle = createStorageCapabilitiesHandler({
    getCapabilities: createStorageCapabilitiesProvider({ getStorageState }),
  })
  mainHandle<unknown, StorageCapabilitiesV1>(WIN_MAIN_RENDERER_EVENT_NAME.storage_capabilities_get, ({ params }) => handle(params))
}
