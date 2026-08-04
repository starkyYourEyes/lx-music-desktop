import type { CacheCleanupMigrationContext, MigrationContext, SchemaMigration } from './types'
import {
  applySchema7CacheCleanup,
  CACHE_CLEANUP_MIGRATION_CHECKSUM,
  CACHE_CLEANUP_MIGRATION_NAME,
  verifySchema7AfterMigration,
} from '../../../migration/cache/cutover'

const requireCacheCleanup = (context: MigrationContext): CacheCleanupMigrationContext => {
  if (context?.cacheCleanup == null || typeof context.cacheCleanup.assertBackupGuard != 'function' ||
    context.appliedAtMs != context.cacheCleanup.cutover?.completedAtMs) {
    throw new Error('phase4_cutover_marker_invalid')
  }
  return context.cacheCleanup
}

export const migration7: SchemaMigration = {
  version: 7,
  name: CACHE_CLEANUP_MIGRATION_NAME,
  checksum: CACHE_CLEANUP_MIGRATION_CHECKSUM,
  up(db, context) {
    applySchema7CacheCleanup(db, requireCacheCleanup(context))
  },
  verify(db, context) {
    verifySchema7AfterMigration(db, requireCacheCleanup(context))
  },
}

export default migration7
