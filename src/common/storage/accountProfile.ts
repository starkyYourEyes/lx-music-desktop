import type { JsonValue } from './canonicalJson'

export type PublicAccountProvider = 'netease' | 'qq_music' | 'kugou'

const invalidProfile = (): never => {
  throw new Error('Invalid public account profile')
}

const asPlainRecord = (value: unknown): Record<string, unknown> => {
  if (value == null || typeof value != 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) invalidProfile()
  return value as Record<string, unknown>
}

const hasExactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key))
}

const requiredString = (value: unknown): string => {
  if (typeof value != 'string') return invalidProfile()
  return value
}

const optionalString = (value: unknown): string | undefined => {
  if (value == null) return undefined
  if (typeof value != 'string') return invalidProfile()
  return value
}

export const normalizePublicAccountProfile = (
  provider: PublicAccountProvider,
  value: unknown,
): JsonValue => {
  const profile = asPlainRecord(value)
  switch (provider) {
    case 'kugou':
      if (!hasExactKeys(profile, ['userId', 'nickname', 'avatarUrl'])) invalidProfile()
      return {
        userId: requiredString(profile.userId),
        nickname: requiredString(profile.nickname),
        avatarUrl: requiredString(profile.avatarUrl),
      }
    case 'qq_music':
      if (!hasExactKeys(profile, ['uin', 'nickname'])) invalidProfile()
      return {
        uin: requiredString(profile.uin),
        nickname: requiredString(profile.nickname),
      }
    case 'netease': {
      if (!hasExactKeys(profile, ['userId', 'nickname', 'avatarUrl'], ['backgroundUrl', 'signature'])) invalidProfile()
      if (!Number.isSafeInteger(profile.userId) || (profile.userId as number) <= 0) invalidProfile()
      const normalized: Record<string, JsonValue> = {
        userId: profile.userId as number,
        nickname: requiredString(profile.nickname),
        avatarUrl: requiredString(profile.avatarUrl),
      }
      const backgroundUrl = optionalString(profile.backgroundUrl)
      const signature = optionalString(profile.signature)
      if (backgroundUrl != null) normalized.backgroundUrl = backgroundUrl
      if (signature != null) normalized.signature = signature
      return normalized
    }
  }
}

export const publicProfileContainsValue = (profile: JsonValue, expected: string): boolean => {
  if (typeof profile == 'string') return profile.includes(expected)
  if (profile == null || typeof profile != 'object') return false
  return Object.values(profile).some(value => publicProfileContainsValue(value, expected))
}
