<template>
  <section :class="$style.disabled">
    <h2>{{ $t('performance_disabled_title') }}</h2>
    <p>{{ $t('performance_disabled_description') }}</p>
    <router-link to="/setting?name=SettingPerformance">{{ $t('performance_open_settings') }}</router-link>
  </section>
</template>
<style module>
.disabled { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; padding: 30px; box-sizing: border-box; text-align: center; }
.disabled h2 { font-size: 20px; }
.disabled p { opacity: .7; line-height: 1.6; }
.disabled a { color: var(--color-primary); }
</style>
