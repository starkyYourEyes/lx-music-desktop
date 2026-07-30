import migration3 from './0003_storage_foundation'

export type { MigrationMarker, MigrationRunResult, SchemaMigration } from './types'

export const migrations = [migration3] as const
export { migration3 }
