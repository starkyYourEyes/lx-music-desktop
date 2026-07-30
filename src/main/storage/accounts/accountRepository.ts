import { canonicalJson, type JsonValue } from '../../../common/storage/canonicalJson'
import {
  normalizePublicAccountProfile,
  publicProfileContainsValue,
} from '../../../common/storage/accountProfile'
import { assertCookieCredential, type CredentialRef } from '../credentials/types'
import type { CredentialRead, CredentialVault } from '../credentials/credentialVault'
import type {
  AccountProfileProvider,
  AccountProfileRow,
} from '../../worker/dbService/modules/account_profile'

export type AccountProvider = AccountProfileProvider
export type AccountPersistence = 'encrypted' | 'memory-only'

export interface AccountStatus {
  loggedIn: boolean
  profile: JsonValue | null
  updatedAtMs: number | null
  persistence: AccountPersistence | null
}

export interface AccountRepository {
  hydrate: () => Promise<void>
  getStatus: (provider: AccountProvider) => AccountStatus
  getCookie: (provider: AccountProvider) => string | null
  save: (provider: AccountProvider, input: {
    cookie: string
    profile: JsonValue
    updatedAtMs: number
  }) => Promise<{ persistence: AccountPersistence }>
  clear: (provider: AccountProvider) => Promise<void>
}

type Awaitable<Value> = Value | Promise<Value>

export interface AccountProfileStore {
  getAccountProfile: (provider: AccountProvider) => Awaitable<AccountProfileRow | null>
  upsertAccountProfile: (row: AccountProfileRow) => Awaitable<void>
  removeAccountProfile: (provider: AccountProvider) => Awaitable<void>
}

export interface CreateAccountRepositoryOptions {
  vault: Pick<CredentialVault, 'read' | 'write' | 'remove' | 'verify'>
  profiles: AccountProfileStore
}

interface HydratedAccount {
  cookie: string | null
  status: AccountStatus
}

const providers: readonly AccountProvider[] = ['netease', 'qq_music']
const emptyStatus = (): AccountStatus => ({
  loggedIn: false,
  profile: null,
  updatedAtMs: null,
  persistence: null,
})

const assertProvider: (provider: unknown) => asserts provider is AccountProvider = provider => {
  if (!providers.includes(provider as AccountProvider)) throw new Error('Invalid account provider')
}

const cloneProfile = (profile: JsonValue): JsonValue => JSON.parse(canonicalJson(profile)) as JsonValue

const cloneStatus = (status: AccountStatus): AccountStatus => ({
  ...status,
  profile: status.profile == null ? null : cloneProfile(status.profile),
})

const credentialRef = (provider: AccountProvider): CredentialRef => provider == 'netease'
  ? { kind: 'netease-cookie' }
  : { kind: 'qq-music-cookie' }

const readCookie = (read: CredentialRead<unknown>): {
  cookie: string | null
  persistence: AccountPersistence | null
} => {
  if (read.status != 'available' && read.status != 'memory-only') {
    return { cookie: null, persistence: null }
  }
  const value = read.value
  const cookie = typeof value == 'string'
    ? assertCookieCredential(value)
    : value != null && typeof value == 'object' && !Array.isArray(value) && 'cookie' in value
      ? assertCookieCredential(value.cookie)
      : null
  if (cookie == null) throw new Error('Invalid account credential')
  return {
    cookie,
    persistence: read.status == 'available' ? 'encrypted' : 'memory-only',
  }
}

const parseProfileRow = (provider: AccountProvider, row: AccountProfileRow | null): {
  profile: JsonValue | null
  updatedAtMs: number | null
} => {
  if (row == null) return { profile: null, updatedAtMs: null }
  if (row.provider != provider || typeof row.profileJson != 'string' ||
    !Number.isSafeInteger(row.updatedAtMs) || row.updatedAtMs < 0) {
    throw new Error('Invalid account profile row')
  }
  let profile: unknown
  try {
    profile = JSON.parse(row.profileJson)
  } catch {
    throw new Error('Invalid account profile row')
  }
  return { profile: normalizePublicAccountProfile(provider, profile), updatedAtMs: row.updatedAtMs }
}

const hydratedAccount = (
  credential: ReturnType<typeof readCookie>,
  profile: ReturnType<typeof parseProfileRow>,
): HydratedAccount => {
  if (credential.cookie == null) return { cookie: null, status: emptyStatus() }
  if (profile.profile != null && publicProfileContainsValue(profile.profile, credential.cookie)) {
    return { cookie: null, status: emptyStatus() }
  }
  return {
    cookie: credential.cookie,
    status: {
      loggedIn: true,
      profile: profile.profile,
      updatedAtMs: profile.updatedAtMs,
      persistence: credential.persistence,
    },
  }
}

export const createAccountRepository = ({ vault, profiles: profileStore }: CreateAccountRepositoryOptions): AccountRepository => {
  const accounts = new Map<AccountProvider, HydratedAccount>(providers.map(provider => [
    provider,
    { cookie: null, status: emptyStatus() },
  ]))
  const operationTails = new Map<AccountProvider, Promise<void>>()

  const serialize = async<Value>(provider: AccountProvider, operation: () => Promise<Value>): Promise<Value> => {
    const previous = operationTails.get(provider) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    operationTails.set(provider, result.then(() => undefined, () => undefined))
    return await result
  }

  const readAccount = async(provider: AccountProvider): Promise<HydratedAccount> => {
    const ref = credentialRef(provider)
    const [credential, row] = await Promise.all([
      Promise.resolve(vault.read<unknown>(ref)).then(readCookie),
      Promise.resolve(profileStore.getAccountProfile(provider)).then(value => parseProfileRow(provider, value)),
    ])
    return hydratedAccount(credential, row)
  }

  const hydrate = async(): Promise<void> => {
    const hydrated = await Promise.all(providers.map(async provider => [provider, await readAccount(provider)] as const))
    for (const [provider, account] of hydrated) accounts.set(provider, account)
  }

  const getStatus = (provider: AccountProvider): AccountStatus => {
    assertProvider(provider)
    return cloneStatus(accounts.get(provider)?.status ?? emptyStatus())
  }

  const getCookie = (provider: AccountProvider): string | null => {
    assertProvider(provider)
    return accounts.get(provider)?.cookie ?? null
  }

  const save: AccountRepository['save'] = async(provider, input) => {
    assertProvider(provider)
    const cookie = assertCookieCredential(input?.cookie)
    if (!Number.isSafeInteger(input.updatedAtMs) || input.updatedAtMs < 0) {
      throw new Error('Invalid account profile timestamp')
    }
    const profile = normalizePublicAccountProfile(provider, input?.profile)
    if (publicProfileContainsValue(profile, cookie)) throw new Error('Invalid public account profile')
    const row: AccountProfileRow = {
      provider,
      profileJson: canonicalJson(profile),
      updatedAtMs: input.updatedAtMs,
    }

    return await serialize(provider, async() => {
      const ref = credentialRef(provider)
      const result = await vault.write(ref, cookie)
      if (!await vault.verify(ref, cookie)) throw new Error('Account credential verification failed')
      await profileStore.upsertAccountProfile(row)
      const account = await readAccount(provider)
      if (account.cookie != cookie || account.status.persistence != result.persistence ||
        account.status.updatedAtMs != row.updatedAtMs || canonicalJson(account.status.profile) != row.profileJson) {
        throw new Error('Account persistence readback failed')
      }
      accounts.set(provider, account)
      return result
    })
  }

  const clear = async(provider: AccountProvider): Promise<void> => {
    assertProvider(provider)
    await serialize(provider, async() => {
      const results = await Promise.allSettled([
        Promise.resolve().then(async() => { await vault.remove(credentialRef(provider)) }),
        Promise.resolve().then(async() => { await profileStore.removeAccountProfile(provider) }),
      ])
      accounts.set(provider, { cookie: null, status: emptyStatus() })
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status == 'rejected')
        .map(result => result.reason)
      if (failures.length == 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Account clear failed')
    })
  }

  return { hydrate, getStatus, getCookie, save, clear }
}
