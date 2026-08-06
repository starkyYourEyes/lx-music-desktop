import { SYNC_CODE } from '@common/constants_sync'

type ClientStatusTranslationKey =
  | 'setting__sync_credential_reauth_required'
  | 'setting__sync_code_blocked_ip'
  | 'setting__sync_code_fail'
  | 'setting_sync_status_enabled'
  | 'sync_status_disabled'

type Translate = (key: ClientStatusTranslationKey) => string

export const getSyncClientStatusText = (
  status: LX.Sync.ClientStatus,
  translate: Translate,
): string => {
  if (status.unavailableReason == 'credential_undecryptable') {
    return translate('setting__sync_credential_reauth_required')
  }
  switch (status.message) {
    case SYNC_CODE.msgBlockedIp:
      return translate('setting__sync_code_blocked_ip')
    case SYNC_CODE.authFailed:
      return translate('setting__sync_code_fail')
    default:
      return status.message || translate(
        status.status ? 'setting_sync_status_enabled' : 'sync_status_disabled',
      )
  }
}
