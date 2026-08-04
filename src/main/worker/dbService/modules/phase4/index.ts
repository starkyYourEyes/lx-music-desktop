import type { CachePhase4Result } from '../../../../../common/storage/cachePhase'
import {
  attestSchema6TypedOwnership,
  runTypedCacheSmoke,
  verifyExistingSchema6ReadWriteMarker,
  verifySchema7MarkersBeforeCache,
} from '../../../../migration/cache/cutover'
import { migrateRawLyrics } from '../../../../migration/cache/rawLyrics'
import { openCacheDatabase } from '../../cacheDb'
import * as appDatabase from '../../db'

const failure = (code: string): Error & { code: string } => Object.assign(new Error(code), { code })

const result = (
  schemaVersion: 6 | 7,
  typedOwnershipVerified: boolean,
): Readonly<CachePhase4Result> => Object.freeze({ schemaVersion, typedOwnershipVerified })

export const initializePhase4 = async(value?: unknown): Promise<Readonly<CachePhase4Result>> => {
  if (value !== undefined) throw failure('phase4_request_invalid')

  let initialization = appDatabase.getDatabaseInitialization()
  if (initialization.schemaVersion == 6 && appDatabase.getOpenAppDatabaseSchemaVersion() == 7) {
    const published = await appDatabase.advanceAppDatabase({
      targetSchemaVersion: 7,
      backupsRoot: initialization.backupsRoot,
    })
    if (published.status != 'ready' || published.schemaVersion != 7) {
      throw failure('phase4_database_advance_invalid')
    }
    initialization = appDatabase.getDatabaseInitialization()
  }
  if (initialization.schemaVersion == 7) verifySchema7MarkersBeforeCache(appDatabase.getAppDB())
  else verifyExistingSchema6ReadWriteMarker(appDatabase.getAppDB())

  const opened = await openCacheDatabase()
  if (opened.status == 'unavailable') return result(initialization.schemaVersion, false)

  if (initialization.schemaVersion == 7) {
    const smoke = await runTypedCacheSmoke()
    return result(7, smoke.status == 'completed')
  }

  const rawLyrics = await migrateRawLyrics({ nowMs: Date.now() })
  if (rawLyrics.status == 'unavailable') return result(6, false)
  if (rawLyrics.status != 'complete' && rawLyrics.status != 'already-complete') {
    throw failure('phase4_raw_lyric_migration_invalid')
  }

  const attestation = await attestSchema6TypedOwnership(appDatabase.getAppDB(), Date.now())
  if (attestation.status == 'unavailable') return result(6, false)
  if (attestation.status != 'completed') throw failure('phase4_attestation_invalid')

  const advanced = await appDatabase.advanceAppDatabase({
    targetSchemaVersion: 7,
    backupsRoot: initialization.backupsRoot,
  })
  if (advanced.status != 'ready' || advanced.schemaVersion != 7) {
    throw failure('phase4_database_advance_invalid')
  }
  return result(7, true)
}
