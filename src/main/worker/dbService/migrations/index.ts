import migration3 from './0003_storage_foundation'
import migration4 from './0004_account_profiles'

export type { MigrationMarker, MigrationRunResult, SchemaMigration } from './types'

export const migrations = [migration3, migration4] as const
export { migration3, migration4 }
