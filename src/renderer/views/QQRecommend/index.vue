<template>
  <div :class="$style.page">
    <login-panel
      v-if="showLoginPanel && !qqIsLoggedIn"
      title="登录 QQ 音乐"
      instruction="请使用手机 QQ 扫码，并在手机上确认"
      :qr-img="qrImg"
      :qr-status-text="qrStatusText"
      :is-creating-qr="isCreatingQr"
      @close="handleCloseLogin"
      @refresh="handleCreateLoginQr"
    />

    <div :class="$style.content" class="scroll">
      <special-cards
        :cards="cards"
        :is-card-playing="isCardPlaying"
        :get-card-play-label="getCardPlayLabel"
        :get-special-card-kicker="getKicker"
        @open="handleCardAction"
        @toggle-card-play="handleCardAction"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, watch } from '@common/utils/vueTools'
import { useRoute, useRouter } from '@common/utils/vueRouter'
import { initQQMusicAccount, isLoggedIn as qqIsLoggedIn, profile as qqProfile } from '@renderer/store/qqMusic'
import LoginPanel from '@renderer/views/Recommend/components/LoginPanel.vue'
import SpecialCards from '@renderer/views/Recommend/components/SpecialCards.vue'
import { useQQGuessLikeData } from '@renderer/views/Recommend/useQQGuessLikeData'
import { useQQMusicLoginQr } from '@renderer/views/Recommend/useQQMusicLoginQr'
import { useQQGuessLikeCard } from './useQQGuessLikeCard'
import { useQQGuessLikePlayback } from './useQQGuessLikePlayback'

const route = useRoute()
const router = useRouter()
const accountKey = computed(() => qqIsLoggedIn.value ? qqProfile.value?.uin ?? null : null)

const {
  songs,
  isLoading,
  loadError,
  load: loadQQGuessLikeSongs,
  clear: clearQQGuessLikeSongs,
} = useQQGuessLikeData()

const {
  qrStatusText,
  qrImg,
  isCreatingQr,
  showLoginPanel,
  handleCreateLoginQr,
  handleShowLogin,
  handleCloseLogin,
} = useQQMusicLoginQr(async() => {
  handleCloseLogin()
})

const { card, getKicker } = useQQGuessLikeCard({
  songs,
  isLoading,
  loadError,
  isLoggedIn: qqIsLoggedIn,
})
const cards = computed(() => [card.value])

const {
  isCardPlaying,
  getCardPlayLabel,
  handleCardAction,
} = useQQGuessLikePlayback({
  loadSongs: loadQQGuessLikeSongs,
  getAccountKey: () => accountKey.value,
  onLoginRequired: handleShowLogin,
})

let isInitializingAccount = false

const initializeAccount = async() => {
  isInitializingAccount = true
  await initQQMusicAccount().catch(() => null)
  await nextTick()
  isInitializingAccount = false
  if (accountKey.value) {
    await loadQQGuessLikeSongs()
  } else {
    clearQQGuessLikeSongs()
  }
}

watch(accountKey, (value, oldValue) => {
  if (value == oldValue) return
  clearQQGuessLikeSongs()
  if (!value) return
  handleCloseLogin()
  if (isInitializingAccount) return
  void loadQQGuessLikeSongs()
})

watch(() => route.query.login, login => {
  if (login == 'qq' && !qqIsLoggedIn.value) handleShowLogin()
  if (login != null) {
    const query = { ...route.query }
    delete query.login
    void router.replace({ path: route.path, query }).catch(_ => _)
  }
}, { immediate: true })

const handleLoginRequest = () => {
  if (!qqIsLoggedIn.value) handleShowLogin()
}

onMounted(() => {
  window.addEventListener('show-qq-music-login', handleLoginRequest)
  void initializeAccount()
})

onBeforeUnmount(() => {
  window.removeEventListener('show-qq-music-login', handleLoginRequest)
})
</script>

<style lang="less" module>
.page {
  position: relative;
  height: 100%;
  overflow: hidden;
}

.content {
  height: 100%;
  padding: 16px 34px 28px;
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
}

@media (max-width: 720px) {
  .content {
    padding: 14px 24px 22px;
  }
}
</style>
