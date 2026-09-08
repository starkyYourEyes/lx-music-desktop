<template>
  <div :class="$style.page">
    <kugou-login-panel
      v-if="showLoginPanel && !kugouIsLoggedIn"
      :title="t('kugou_recommend_login_title')"
      :instruction="t('kugou_recommend_login_instruction')"
      :qr-img="qrImg"
      :qr-status-text="qrStatusText"
      :is-creating-qr="isCreatingQr"
      :creating-text="t('kugou_recommend_qr_creating')"
      :empty-text="t('kugou_recommend_qr_empty')"
      :refresh-text="t('kugou_recommend_qr_refresh')"
      :close-label="t('kugou_recommend_login_close')"
      @close="handleCloseLogin"
      @refresh="handleCreateLoginQr"
      @qr-load="handleQrImageLoad"
    />

    <div :class="$style.content" class="scroll">
      <header :class="$style.pageHeader">
        <div>
          <h2>{{ t('kugou_recommend_page_title') }}</h2>
          <p>{{ pageDescription }}</p>
        </div>
        <div :class="$style.headerActions">
          <span :class="$style.provider">{{ t('kugou_recommend_provider') }}</span>
          <SectionRefreshButton
            :label="t('kugou_recommend_refresh')"
            :disabled="isLoadingPublic || isLoadingPrivate"
            @click="handleRefresh"
          />
        </div>
      </header>

      <div v-if="interactionError" :class="$style.pageError" role="status">
        <span>{{ interactionError }}</span>
        <button type="button" @click="interactionError = ''">{{ t('kugou_recommend_dismiss') }}</button>
      </div>

      <div :class="$style.flow">
        <kugou-playlist-section
          :title="t('kugou_recommend_featured_title')"
          :description="t('kugou_recommend_featured_description')"
          :playlists="playlists"
          :loading="isLoadingPublicRecommendation"
          :error="publicRecommendationLoadError ? t('kugou_recommend_featured_error') : ''"
          :empty-text="t('kugou_recommend_featured_empty')"
          :retry-text="t('kugou_recommend_retry')"
          :refresh-label="t('kugou_recommend_featured_refresh')"
          :is-playlist-playing="playback.isPlaylistPlaying"
          :get-playlist-play-label="playback.getPlaylistPlayLabel"
          @retry="data.loadPublicRecommendation(true)"
          @open="playback.openPlaylist"
          @toggle-play="playback.togglePlaylist"
        />

        <kugou-songs-section
          :title="publicRank?.name || t('kugou_recommend_rank_title')"
          :description="publicRank?.description || t('kugou_recommend_rank_description')"
          :songs="publicSongs"
          :loading="isLoadingPublicSongs"
          :error="publicSongsLoadError ? t('kugou_recommend_rank_error') : ''"
          :empty-text="t('kugou_recommend_rank_empty')"
          :retry-text="t('kugou_recommend_retry')"
          :refresh-label="t('kugou_recommend_rank_refresh')"
          :play-label="playback.getSectionPlayLabel('public')"
          :provider-name="t('kugou_recommend_provider')"
          :playing="playback.isSectionPlaying('public')"
          :is-song-playing="playback.isSongPlaying"
          @retry="data.loadRankRecommendation(true)"
          @play="playback.playSong('public', $event)"
          @play-all="playback.playSection('public')"
        />

        <aside v-if="!accountKey" :class="$style.loginCta">
          <div>
            <strong>{{ t('kugou_recommend_login_cta_title') }}</strong>
            <p>{{ t('kugou_recommend_login_cta_description') }}</p>
          </div>
          <button type="button" @click="handleShowLogin">{{ t('kugou_recommend_login_action') }}</button>
        </aside>

        <template v-if="accountKey">
          <kugou-songs-section
            :title="t('kugou_recommend_daily_title')"
            :description="t('kugou_recommend_daily_description')"
            :songs="dailySongs"
            :loading="isLoadingDailySongs"
            :error="dailySongsLoadError ? t('kugou_recommend_daily_error') : ''"
            :empty-text="t('kugou_recommend_daily_empty')"
            :retry-text="t('kugou_recommend_retry')"
            :refresh-label="t('kugou_recommend_daily_refresh')"
            :play-label="playback.getSectionPlayLabel('daily')"
            :provider-name="t('kugou_recommend_provider')"
            :playing="playback.isSectionPlaying('daily')"
            :is-song-playing="playback.isSongPlaying"
            @retry="data.loadDailySongs(true)"
            @play="playback.playSong('daily', $event)"
            @play-all="playback.playSection('daily')"
          />

          <kugou-songs-section
            :title="t('kugou_recommend_style_title')"
            :description="t('kugou_recommend_style_description')"
            :songs="styleSongs"
            :loading="isLoadingStyleSongs"
            :error="styleSongsLoadError ? t('kugou_recommend_style_error') : ''"
            :empty-text="t('kugou_recommend_style_empty')"
            :retry-text="t('kugou_recommend_retry')"
            :refresh-label="t('kugou_recommend_style_refresh')"
            :play-label="playback.getSectionPlayLabel('style')"
            :provider-name="t('kugou_recommend_provider')"
            :playing="playback.isSectionPlaying('style')"
            :is-song-playing="playback.isSongPlaying"
            @retry="data.loadStyleSongs(true)"
            @play="playback.playSong('style', $event)"
            @play-all="playback.playSection('style')"
          />

          <kugou-featured-section
            :title="t('kugou_recommend_fm_title')"
            :description="t('kugou_recommend_fm_description')"
            :songs="fmSongs"
            :loading="isLoadingFmSongs"
            :error="fmSongsLoadError ? t('kugou_recommend_fm_error') : ''"
            :empty-text="t('kugou_recommend_fm_empty')"
            :retry-text="t('kugou_recommend_retry')"
            :refresh-label="t('kugou_recommend_fm_refresh')"
            :play-label="playback.getSectionPlayLabel('fm')"
            :provider-name="t('kugou_recommend_provider')"
            :queue-text="t('kugou_recommend_fm_queue', { count: fmSongs.length })"
            :playing="playback.isSectionPlaying('fm')"
            @retry="data.loadFmSongs(true)"
            @play="playback.playSection('fm')"
          />
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from '@common/utils/vueTools'
import { useRoute, useRouter } from '@common/utils/vueRouter'
import { useI18n } from '@root/lang'
import {
  getKugouMusicAccountKey,
  initKugouMusicAccount,
  isLoggedIn as kugouIsLoggedIn,
  profile as kugouProfile,
} from '@renderer/store/kugouMusic'
import KugouFeaturedSection from './components/KugouFeaturedSection.vue'
import KugouLoginPanel from './components/KugouLoginPanel.vue'
import KugouPlaylistSection from './components/KugouPlaylistSection.vue'
import KugouSongsSection from './components/KugouSongsSection.vue'
import SectionRefreshButton from '@renderer/views/Recommend/components/SectionRefreshButton.vue'
import { useKugouMusicLoginQr } from './useKugouMusicLoginQr'
import { useKugouRecommendData } from './useKugouRecommendData'
import { useKugouRecommendPlayback } from './useKugouRecommendPlayback'

const route = useRoute()
const router = useRouter()
const t = useI18n()
const accountKey = computed(() => getKugouMusicAccountKey())
const interactionError = ref('')
let isInitializingAccount = false

const pageDescription = computed(() => accountKey.value
  ? t('kugou_recommend_page_description_user', { name: kugouProfile.value?.nickname ?? t('kugou_recommend_provider') })
  : t('kugou_recommend_page_description_guest'))

const data = useKugouRecommendData({ accountKey })
const {
  playlists,
  publicRank,
  publicSongs,
  dailySongs,
  styleSongs,
  fmSongs,
  isLoadingPublicRecommendation,
  isLoadingPublicSongs,
  isLoadingDailySongs,
  isLoadingStyleSongs,
  isLoadingFmSongs,
  isLoadingPublic,
  isLoadingPrivate,
  publicRecommendationLoadError,
  publicSongsLoadError,
  dailySongsLoadError,
  styleSongsLoadError,
  fmSongsLoadError,
  clearPrivate,
} = data
const handleRefresh = data.handleRefresh

const playback = useKugouRecommendPlayback({
  publicSongs,
  dailySongs,
  styleSongs,
  fmSongs,
  setError: message => {
    interactionError.value = message
  },
})

const {
  qrStatusText,
  qrImg,
  isCreatingQr,
  showLoginPanel,
  handleCreateLoginQr,
  handleShowLogin,
  handleCloseLogin,
  handleQrImageLoad,
} = useKugouMusicLoginQr(async() => {
  handleCloseLogin()
})

const initializeAccount = async() => {
  isInitializingAccount = true
  await initKugouMusicAccount().catch(() => null)
  await nextTick()
  isInitializingAccount = false
  await data.loadPrivate()
}

watch(accountKey, (value, oldValue) => {
  if (value == oldValue) return
  clearPrivate()
  if (!value) return
  handleCloseLogin()
  if (!isInitializingAccount) void data.loadPrivate()
})

watch(() => route.query.login, login => {
  if (login == 'kugou' && !kugouIsLoggedIn.value) handleShowLogin()
  if (login != null) {
    const query = { ...route.query }
    delete query.login
    void router.replace({ path: route.path, query }).catch(_ => _)
  }
}, { immediate: true })

const handleLoginRequest = () => {
  if (!kugouIsLoggedIn.value) handleShowLogin()
}

onMounted(() => {
  window.addEventListener('show-kugou-music-login', handleLoginRequest)
  void data.loadPublic()
  void initializeAccount()
})

onBeforeUnmount(() => {
  window.removeEventListener('show-kugou-music-login', handleLoginRequest)
})
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.page { position: relative; height: 100%; overflow: hidden; }
.content { height: 100%; padding: 18px 34px 34px; box-sizing: border-box; overflow-x: hidden; overflow-y: auto; }
.pageHeader {
  min-width: 0;
  margin-bottom: 24px;
  padding-left: 12px;
  border-left: 3px solid #1695f1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  h2 { margin: 0; color: var(--color-font); font-size: 23px; line-height: 1.25; font-weight: 800; }
  p { margin: 5px 0 0; color: var(--color-font-label); font-size: 12px; line-height: 1.35; }
}
.provider { flex: none; color: #168be0; font-size: 12px; font-weight: 700; }
.headerActions { flex: none; display: flex; align-items: center; gap: 10px; }
.flow { min-width: 0; display: flex; flex-flow: column nowrap; gap: 32px; }
.pageError { min-height: 38px; margin: 0 0 16px; padding: 8px 10px 8px 13px; box-sizing: border-box; border-left: 3px solid #1695f1; color: var(--color-font-label); background-color: rgba(128, 128, 128, .08); display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; button { padding: 5px 10px; border: 0; border-radius: 6px; color: #168be0; background-color: rgba(22, 149, 241, .1); cursor: pointer; } }
.loginCta {
  min-width: 0;
  padding: 16px 18px;
  border-left: 3px solid #1695f1;
  color: var(--color-font);
  background-color: rgba(128, 128, 128, .07);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  strong { display: block; font-size: 14px; line-height: 1.3; }
  p { margin: 5px 0 0; color: var(--color-font-label); font-size: 12px; line-height: 1.4; }
  button { flex: none; min-height: 34px; padding: 0 15px; border: 0; border-radius: 7px; color: #fff; background-color: #168be0; font-size: 13px; font-weight: 700; cursor: pointer; transition: opacity @transition-fast, transform @transition-fast; &:hover { opacity: .9; } &:active { transform: translateY(1px); } }
}
@media (max-width: 720px) { .content { padding: 15px 24px 28px; } .pageHeader h2 { font-size: 20px; } .flow { gap: 28px; } .loginCta { align-items: flex-start; flex-flow: column nowrap; } }
</style>
