import { app } from 'electron'
import { createCredentialVault, type CredentialVault } from './credentialVault'
import { createCredentialCipher } from './safeStorageCipher'

export * from './credentialVault'
export * from './safeStorageCipher'
export * from './types'

let initializationPromise: Promise<CredentialVault> | null = null

// Electron safeStorage is queried only after app readiness resolves.
export const initializeCredentialVault = async(): Promise<CredentialVault> => {
  if (global.lx.credentialVault != null) return Promise.resolve(global.lx.credentialVault)
  initializationPromise ??= app.whenReady().then(async() => {
    const { safeStorage } = await import('electron')
    const vault = await createCredentialVault({
      profileRoot: global.lxDataPath,
      cipher: createCredentialCipher({ safeStorage }),
    })
    global.lx.credentialVault = vault
    return vault
  })
  return await initializationPromise
}

export const getCredentialVault = (): CredentialVault => {
  if (global.lx.credentialVault == null) throw new Error('Credential vault has not been initialized')
  return global.lx.credentialVault
}
