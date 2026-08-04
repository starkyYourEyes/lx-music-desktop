import type { AccountRepository } from '@main/storage/accounts/accountRepository'
import {
  neteaseAccountScope,
  qqMusicAccountScope,
} from '@common/storage/cacheValidation'
import type {
  AuthorizedMusicUrlGetInputV1,
  AuthorizedMusicUrlPutInputV1,
  CacheReadResultV1,
  CacheWriteResultV1,
  MusicUrlAccountInvalidationV1,
  MusicUrlAuthorizationV1,
  MusicUrlGetInputV1,
  MusicUrlInvalidationResultV1,
  MusicUrlPutInputV1,
  PersistentMusicUrlProviderV1,
} from '@common/storage/cache'

export type AccountTransitionDecision<T> =
  | { status: 'unchanged', value: T }
  | { status: 'changed', value: T }

export interface MusicUrlAuthorizationService {
  authorize: (provider: PersistentMusicUrlProviderV1) => Promise<MusicUrlAuthorizationV1 | null>
  read: (input: AuthorizedMusicUrlGetInputV1) => Promise<CacheReadResultV1<string>>
  write: (input: AuthorizedMusicUrlPutInputV1) => Promise<CacheWriteResultV1>
  transition: <T>(
    provider: PersistentMusicUrlProviderV1,
    mutation: () => Promise<AccountTransitionDecision<T>>,
  ) => Promise<T>
  flush: () => Promise<void>
}

export interface MusicUrlAuthorizationWorker {
  musicUrlGet: (input: MusicUrlGetInputV1) => Promise<CacheReadResultV1<string>>
  musicUrlPut: (input: MusicUrlPutInputV1) => Promise<CacheWriteResultV1>
  musicUrlInvalidateAccount: (
    input: MusicUrlAccountInvalidationV1,
  ) => Promise<MusicUrlInvalidationResultV1>
}

const staleAuthorization = (): Error & { code: 'music_url_authorization_stale' } => {
  const code = 'music_url_authorization_stale' as const
  return Object.assign(new Error(code), { code })
}

const accountProvider = (provider: PersistentMusicUrlProviderV1) => provider == 'wy'
  ? 'netease' as const
  : 'qq_music' as const

export const createMusicUrlAuthorizationService = ({
  accounts,
  worker,
}: {
  accounts: Pick<AccountRepository, 'getCookie' | 'getStatus'>
  worker: MusicUrlAuthorizationWorker
}): MusicUrlAuthorizationService => {
  const generations: Record<PersistentMusicUrlProviderV1, number> = { wy: 1, tx: 1 }
  const tails: Record<PersistentMusicUrlProviderV1, Promise<void>> = {
    wy: Promise.resolve(),
    tx: Promise.resolve(),
  }
  const pendingInvalidations: Record<PersistentMusicUrlProviderV1, Set<string>> = {
    wy: new Set(),
    tx: new Set(),
  }

  const enqueue = async<T>(provider: PersistentMusicUrlProviderV1, operation: () => Promise<T>): Promise<T> => {
    const result = tails[provider].then(operation)
    tails[provider] = result.then(() => {}, () => {})
    return result
  }

  const currentScope = (provider: PersistentMusicUrlProviderV1): string | null => {
    const repositoryProvider = accountProvider(provider)
    if (!accounts.getCookie(repositoryProvider)) return null
    const profile = accounts.getStatus(repositoryProvider).profile
    return provider == 'wy' ? neteaseAccountScope(profile) : qqMusicAccountScope(profile)
  }

  const invalidate = async(provider: PersistentMusicUrlProviderV1, accountScope: string): Promise<void> => {
    const pending = pendingInvalidations[provider]
    pending.add(accountScope)
    const result = await worker.musicUrlInvalidateAccount({ provider, accountScope })
    if (result.status == 'completed') pending.delete(accountScope)
  }

  const retryPendingInvalidations = async(provider: PersistentMusicUrlProviderV1): Promise<boolean> => {
    for (const accountScope of [...pendingInvalidations[provider]]) {
      await invalidate(provider, accountScope)
    }
    return pendingInvalidations[provider].size == 0
  }

  const assertCurrent = (authorization: MusicUrlAuthorizationV1): void => {
    const provider = authorization.provider
    if ((provider != 'wy' && provider != 'tx') ||
      authorization.version !== 1 ||
      authorization.generation != generations[provider] ||
      pendingInvalidations[provider].size != 0 ||
      authorization.accountScope != currentScope(provider)) throw staleAuthorization()
  }

  const authorize: MusicUrlAuthorizationService['authorize'] = async(provider) => enqueue(provider, async() => {
    if (!await retryPendingInvalidations(provider)) return null
    const accountScope = currentScope(provider)
    return accountScope == null ? null : {
      version: 1,
      provider,
      accountScope,
      generation: generations[provider],
    }
  })

  const read: MusicUrlAuthorizationService['read'] = async(input) => enqueue(input.authorization.provider, async() => {
    assertCurrent(input.authorization)
    return worker.musicUrlGet({
      provider: input.authorization.provider,
      accountScope: input.authorization.accountScope,
      sourceTrackId: input.sourceTrackId,
      quality: input.quality,
      nowMs: input.nowMs,
    })
  })

  const write: MusicUrlAuthorizationService['write'] = async(input) => enqueue(input.authorization.provider, async() => {
    assertCurrent(input.authorization)
    return worker.musicUrlPut({
      provider: input.authorization.provider,
      accountScope: input.authorization.accountScope,
      sourceTrackId: input.sourceTrackId,
      quality: input.quality,
      url: input.url,
      nowMs: input.nowMs,
      ...(input.providerExpiresAtMs == null ? {} : { providerExpiresAtMs: input.providerExpiresAtMs }),
    })
  })

  const transition: MusicUrlAuthorizationService['transition'] = async(provider, mutation) => enqueue(provider, async() => {
    const oldScope = currentScope(provider)
    const decision = await mutation()
    if (decision.status == 'unchanged') return decision.value
    generations[provider]++
    if (oldScope != null) await invalidate(provider, oldScope)
    return decision.value
  })

  return {
    authorize,
    read,
    write,
    transition,
    flush: async() => { await Promise.all([tails.wy, tails.tx]) },
  }
}
