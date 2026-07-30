import type { CredentialCipher } from './types'

interface SafeStorageSource {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
}

export interface CredentialCipherDependencies {
  safeStorage: SafeStorageSource
  platform?: NodeJS.Platform
}

const isSecure = ({ safeStorage, platform = process.platform }: CredentialCipherDependencies): boolean => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (platform == 'linux' && safeStorage.getSelectedStorageBackend?.() == 'basic_text') return false
    return true
  } catch {
    return false
  }
}

export const createCredentialCipher = (dependencies: CredentialCipherDependencies): CredentialCipher => {
  const mode = isSecure(dependencies) ? 'encrypted' : 'memory-only'

  const assertSecure = () => {
    if (mode != 'encrypted' || !isSecure(dependencies)) throw new Error('Secure credential storage is unavailable')
  }

  return {
    mode,
    encrypt(plaintext) {
      assertSecure()
      return dependencies.safeStorage.encryptString(plaintext)
    },
    decrypt(ciphertext) {
      assertSecure()
      return dependencies.safeStorage.decryptString(ciphertext)
    },
  }
}
