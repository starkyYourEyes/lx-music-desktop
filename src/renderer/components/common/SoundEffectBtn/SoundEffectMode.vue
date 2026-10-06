<template>
  <section :class="$style.mode">
    <div :class="$style.options" role="group" :aria-label="$t('player__sound_effect_mode')">
      <base-btn
        min
        :outline="mode != 'original'"
        :aria-pressed="mode == 'original'"
        @click="handleChange('original')"
      >
        {{ $t('player__sound_effect_mode_original') }}
      </base-btn>
      <base-btn
        min
        :outline="mode != 'effects'"
        :aria-pressed="mode == 'effects'"
        @click="handleChange('effects')"
      >
        {{ $t('player__sound_effect_mode_effects') }}
      </base-btn>
    </div>
    <p :class="$style.description">
      {{ $t(mode == 'original' ? 'player__sound_effect_mode_original_desc' : 'player__sound_effect_mode_effects_desc') }}
    </p>
  </section>
</template>

<script setup>
import { computed } from '@common/utils/vueTools'
import { setMediaDeviceId } from '@renderer/plugins/player'
import { appSetting, saveMediaDeviceId, updateSetting } from '@renderer/store/setting'

const mode = computed(() => appSetting['player.soundEffect.mode'])
let changeRequestId = 0

const handleChange = async(nextMode) => {
  const requestId = ++changeRequestId
  if (nextMode == mode.value) return
  if (nextMode == 'effects' && appSetting['player.mediaDeviceId'] != 'default') {
    await setMediaDeviceId('default').catch(_ => _)
    if (requestId != changeRequestId) return
    saveMediaDeviceId('default')
  }
  updateSetting({ 'player.soundEffect.mode': nextMode })
}
</script>

<style lang="less" module>
.mode {
  padding: 15px 15px 0;
}

.options {
  display: flex;
  justify-content: center;
  gap: 10px;
}

.description {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-font-label);
  text-align: center;
}
</style>
