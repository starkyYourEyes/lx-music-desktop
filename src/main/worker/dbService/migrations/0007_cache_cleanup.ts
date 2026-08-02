import type { SchemaMigration } from './types'
import {
  applySchema7CacheCleanup,
  CACHE_CLEANUP_MIGRATION_CHECKSUM,
  CACHE_CLEANUP_MIGRATION_NAME,
  verifySchema7AfterMigration,
} from '../../../migration/cache/cutover'

export const migration7: SchemaMigration = {
  version: 7,
  name: CACHE_CLEANUP_MIGRATION_NAME,
  checksum: CACHE_CLEANUP_MIGRATION_CHECKSUM,
  up(db, context) {
    applySchema7CacheCleanup(db, context.appliedAtMs)
  },
  verify(db) {
    verifySchema7AfterMigration(db)
  },
}

export default migration7
