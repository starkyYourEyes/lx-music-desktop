<template lang="pug">
dd
  h3 {{ $t('setting__sync_client_mode') }}
  div
    .p.small {{ $t('setting__sync_client_status', { status: clientStatus }) }}
    .p.small {{ $t('setting__sync_client_address', { address: sync.client.status.address.join(', ') || '' }) }}
    .p
      .p.small {{ $t('setting__sync_client_host') }}
      div
        base-input.gap-left(:class="$style.hostInput" :model-value="appSetting['sync.client.host']" :disabled="sync.enable" :placeholder="$t('setting__sync_client_host_tip')" @update:model-value="setSyncClientHost")
</template>

<script>
import { computed } from '@common/utils/vueTools'
import { sync } from '@renderer/store'
import { useI18n } from '@renderer/plugins/i18n'
import { appSetting, updateSetting } from '@renderer/store/setting'
import { debounce } from '@common/utils/common'
import { getSyncClientStatusText } from './clientStatus'

export default {
  name: 'SettingSyncClient',
  setup() {
    const t = useI18n()

    const clientStatus = computed(() => getSyncClientStatusText(sync.client.status, t))

    const setSyncClientHost = debounce(host => {
      updateSetting({ 'sync.client.host': host.trim() })
    }, 500)


    return {
      appSetting,
      sync,
      setSyncClientHost,
      clientStatus,
    }
  },
}
</script>

<style lang="less" module>
.hostInput[disabled] {
  opacity: .8 !important;
}

.hostInput {
  min-width: 380px;
}
</style>
