import migration3 from './0003_storage_foundation'
import migration4 from './0004_account_profiles'
import migration5 from './0005_non_activity_state'
import migration6 from './0006_playback_activity'

export type { MigrationMarker, MigrationRunResult, SchemaMigration } from './types'

export const migrations = [migration3, migration4, migration5, migration6] as const
export { migration3, migration4, migration5, migration6 }
