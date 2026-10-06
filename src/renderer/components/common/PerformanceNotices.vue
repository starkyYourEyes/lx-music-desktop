<template>
  <material-modal :show="showRestartNotice" @close="showRestartNotice = false" @after-enter="later?.focus()">
    <section :class="$style.dialog" role="dialog" aria-modal="true" :aria-label="$t('performance_restart_title')" @keydown.esc.stop="showRestartNotice = false" @keydown.tab="trapFocus">
      <h2>{{ $t('performance_restart_title') }}</h2>
      <p>{{ $t('performance_restart_description') }}</p>
      <p v-if="isPlay || performanceStates.download.active">{{ $t('performance_restart_activity') }}</p>
      <ul><li v-for="feature in restartFeatures" :key="feature">{{ $t(`performance_feature_${feature}`) }}</li></ul>
      <p v-if="performanceError" role="alert">{{ $t(performanceError) }}</p>
      <footer>
        <button ref="later" type="button" :disabled="performanceSaving" @click="showRestartNotice = false">{{ $t('performance_restart_later') }}</button>
        <button type="button" :disabled="performanceSaving" @click="restartAppForPerformance">{{ $t('performance_restart_now') }}</button>
      </footer>
    </section>
  </material-modal>
  <material-modal :show="showPerformanceLeaveNotice" @close="finishPerformanceLeave('stay')" @after-enter="stay?.focus()">
    <section :class="$style.dialog" role="dialog" aria-modal="true" :aria-label="$t('performance_unsaved')" @keydown.esc.stop="finishPerformanceLeave('stay')" @keydown.tab="trapFocus">
      <h2>{{ $t('performance_unsaved') }}</h2>
      <p>{{ $t('performance_unsaved_description') }}</p>
      <p v-if="performanceError" role="alert">{{ $t(performanceError) }}</p>
      <footer>
        <button ref="stay" type="button" :disabled="performanceSaving" @click="finishPerformanceLeave('stay')">{{ $t('performance_stay') }}</button>
        <button type="button" :disabled="performanceSaving" @click="finishPerformanceLeave('discard')">{{ $t('performance_discard') }}</button>
        <button type="button" :disabled="performanceSaving || performanceConflicts.length > 0" @click="finishPerformanceLeave('save')">{{ $t('performance_save_leave') }}</button>
      </footer>
    </section>
  </material-modal>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { isPlay } from '@renderer/store/player/state'
import {
  showRestartNotice, restartFeatures, performanceError, performanceSaving, restartAppForPerformance,
  showPerformanceLeaveNotice, finishPerformanceLeave, performanceConflicts,
  performanceStates,
} from '@renderer/store/performance'
const later = ref<HTMLButtonElement>()
const stay = ref<HTMLButtonElement>()
const trapFocus = (event: KeyboardEvent) => {
  const buttons = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  const target = event.shiftKey ? buttons.at(-1) : buttons[0]
  if (document.activeElement == (event.shiftKey ? buttons[0] : buttons.at(-1))) {
    event.preventDefault()
    target?.focus()
  }
}
</script>

<style module lang="less">
.dialog {
  padding: 24px; max-width: 470px; line-height: 1.65;
  h2 { font-size: 18px; margin-bottom: 12px; }
  ul { margin: 12px 0; padding-left: 20px; }
  footer { display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px; }
  button { padding: 7px 12px; border: 1px solid var(--color-primary-alpha-300); border-radius: 5px; background: var(--color-content-background); color: var(--color-font); cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--color-primary); }
  button:disabled { opacity: .5; cursor: default; }
}
</style>
