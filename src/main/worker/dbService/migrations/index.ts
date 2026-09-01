import migration3 from './0003_storage_foundation'
import migration4 from './0004_account_profiles'
import migration5 from './0005_non_activity_state'
import migration6 from './0006_playback_activity'
import migration7 from './0007_cache_cleanup'
import migration8 from './0008_listening_play_count'

export type { MigrationContext, MigrationMarker, MigrationRunResult, SchemaMigration } from './types'

export const migrations = [migration3, migration4, migration5, migration6, migration7, migration8] as const
export { migration3, migration4, migration5, migration6, migration7, migration8 }
