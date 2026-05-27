import { toRaw } from '@common/utils/vueTools'

export const toCloneable = <T>(value: T): T => JSON.parse(JSON.stringify(toRaw(value)))
