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
      @qr-load="handleQrImageLoad"
    />

    <div :class="$style.content" class="scroll">
      <div v-if="!qqIsLoggedIn" :class="$style.signedOut">
        <h2>QQ Music 个性化推荐</h2>
        <p>登录后同步你的猜你喜欢、每日30首和专属歌单。</p>
        <button type="button" @click="handleShowLogin">登录 QQ 音乐</button>
      </div>

      <template v-else>
        <header :class="$style.pageHeader">
          <h2>{{ pageTitle }}</h2>
          <section-refresh-button
            label="刷新 QQ Music 推荐"
            :disabled="isPageRefreshing"
            @click="handleRefresh"
          />
        </header>

        <div v-if="effectiveError" :class="$style.errorBanner" role="status">
          <span>{{ effectiveError }}</span>
          <button type="button" @click="handleRefresh">重试</button>
        </div>

        <div :class="$style.homeFlow">
          <QQFeaturedSection
            :cards="featuredCards"
            :is-card-playing="isFeatureCardPlaying"
            :get-card-play-label="getFeatureCardPlayLabel"
            :get-card-kicker="getFeatureCardKicker"
            @open="handleFeatureCardOpen"
            @toggle-play="handleFeatureCardPlay"
          />

          <QQPlaylistSection
            title="你的私荐歌单"
            description="QQ Music 根据你的收听偏好生成"
            :playlists="homeRecommendation?.privatePlaylists ?? []"
            :loading="homeIsLoading && !homeRecommendation"
            :is-playlist-playing-list="isHomePlaylistPlaying"
            :get-playlist-play-label="homePlayback.getPlaylistPlayLabel"
            @open="homePlayback.openPlaylist"
            @toggle-play="homePlayback.togglePlaylist"
          />

          <QQRelatedSongsSection
            :title="homeRecommendation?.relatedSongTitle ?? '为你推荐的歌曲'"
            :songs="visibleRelatedSongs"
            :page-count="relatedSongPages.length"
            :loading="homeIsLoading && !homeRecommendation"
            :is-section-playing="homePlayback.isRelatedSongsPlaying()"
            :is-song-playing="homePlayback.isRelatedSongPlaying"
            @previous="showPreviousRelatedSongs"
            @next="showNextRelatedSongs"
            @play="homePlayback.playRelatedSong"
            @play-all="homePlayback.toggleRelatedSongs"
          />

          <QQPlaylistSection
            title="歌单遨游指南"
            description="沿着你的喜好继续探索"
            :playlists="homeRecommendation?.guidePlaylists ?? []"
            :loading="homeIsLoading && !homeRecommendation"
            :is-playlist-playing-list="isHomePlaylistPlaying"
            :get-playlist-play-label="homePlayback.getPlaylistPlayLabel"
            @open="homePlayback.openPlaylist"
            @toggle-play="homePlayback.togglePlaylist"
          />

          <p v-if="showEmptyState" :class="$style.emptyState">暂时没有新的个性化推荐</p>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from '@common/utils/vueTools'
import { useRoute, useRouter } from '@common/utils/vueRouter'
import { isQQBrushModeListActive } from '@renderer/store/qqBrushMode/action'
import { isQQGuessLikeListActive } from '@renderer/store/qqGuessLike/action'
import { isPlay, playMusicInfo } from '@renderer/store/player/state'
import { initQQMusicAccount, isLoggedIn as qqIsLoggedIn, profile as qqProfile } from '@renderer/store/qqMusic'
import LoginPanel from '@renderer/views/Recommend/components/LoginPanel.vue'
import SectionRefreshButton from '@renderer/views/Recommend/components/SectionRefreshButton.vue'
import { useQQGuessLikeData } from '@renderer/views/Recommend/useQQGuessLikeData'
import { useQQMusicLoginQr } from '@renderer/views/Recommend/useQQMusicLoginQr'
import type { RecommendCard } from '@renderer/views/Recommend/types'
import QQFeaturedSection from './components/QQFeaturedSection.vue'
import QQPlaylistSection from './components/QQPlaylistSection.vue'
import QQRelatedSongsSection from './components/QQRelatedSongsSection.vue'
import { useQQBrushModeCard } from './useQQBrushModeCard'
import { useQQBrushModeData } from './useQQBrushModeData'
import { useQQBrushModePlayback } from './useQQBrushModePlayback'
import { useQQDailyRecommendCard } from './useQQDailyRecommendCard'
import { useQQDailyRecommendData } from './useQQDailyRecommendData'
import { useQQDailyRecommendPlayback } from './useQQDailyRecommendPlayback'
import { useQQGuessLikeCard } from './useQQGuessLikeCard'
import { useQQGuessLikePlayback } from './useQQGuessLikePlayback'
import { useQQHomeRecommendData } from './useQQHomeRecommendData'
import { useQQHomeRecommendPlayback } from './useQQHomeRecommendPlayback'
import { useQQRadioCardSong } from './useQQRadioCardSong'

const route = useRoute()
const router = useRouter()
const accountKey = computed(() => qqIsLoggedIn.value ? qqProfile.value?.uin ?? null : null)
const interactionError = ref('')
const relatedPageIndex = ref(0)
let accountRevision = 0
let isInitializingAccount = false

const {
  songs: guessLikeSongs,
  isLoading: guessLikeIsLoading,
  isRefreshing: guessLikeIsRefreshing,
  loadError: guessLikeLoadError,
  load: loadQQGuessLikeSongs,
  clear: clearQQGuessLikeSongs,
} = useQQGuessLikeData()

const {
  songs: brushModeSongs,
  isLoading: brushModeIsLoading,
  loadError: brushModeLoadError,
  load: loadQQBrushModeSongs,
  clear: clearQQBrushModeSongs,
} = useQQBrushModeData()

const {
  songs: dailyRecommendSongs,
  isLoading: dailyRecommendIsLoading,
  isRefreshing: dailyRecommendIsRefreshing,
  loadError: dailyRecommendLoadError,
  load: loadQQDailyRecommendSongs,
  clear: clearQQDailyRecommendSongs,
} = useQQDailyRecommendData()

const {
  data: homeRecommendation,
  isLoading: homeIsLoading,
  isRefreshing: homeIsRefreshing,
  loadError: homeLoadError,
  load: loadHomeRecommendation,
  clear: clearHomeRecommendation,
} = useQQHomeRecommendData({ accountKey })

const brushModeDescriptor = computed<LX.QQMusic.BrushMode | null>(() => homeRecommendation.value?.brushMode ?? {
  id: '99',
  title: '刷歌模式',
  description: '猜你喜欢-沉浸刷歌',
})

const getCurrentQQSong = () => {
  const song = playMusicInfo.musicInfo
  return song && 'source' in song && song.source == 'tx'
    ? song
    : null
}
const guessLikeCurrentSong = computed(() => isQQGuessLikeListActive(accountKey.value) ? getCurrentQQSong() : null)
const brushModeCurrentSong = computed(() => isQQBrushModeListActive(accountKey.value) ? getCurrentQQSong() : null)
const {
  song: guessLikeCardSong,
  clear: clearGuessLikeCardSong,
} = useQQRadioCardSong('guessLike', { accountKey, currentSong: guessLikeCurrentSong })
const {
  song: brushModeCardSong,
  clear: clearBrushModeCardSong,
} = useQQRadioCardSong('brushMode', { accountKey, currentSong: brushModeCurrentSong })

const {
  qrStatusText,
  qrImg,
  isCreatingQr,
  showLoginPanel,
  handleCreateLoginQr,
  handleShowLogin,
  handleCloseLogin,
  handleQrImageLoad,
} = useQQMusicLoginQr(async() => {
  handleCloseLogin()
})

const { card: guessLikeCard, getKicker: getGuessLikeKicker } = useQQGuessLikeCard({
  songs: guessLikeSongs,
  currentSong: guessLikeCardSong,
  isLoading: guessLikeIsLoading,
  loadError: guessLikeLoadError,
  isLoggedIn: qqIsLoggedIn,
})
const { card: dailyRecommendCard, getKicker: getDailyRecommendKicker } = useQQDailyRecommendCard({
  songs: dailyRecommendSongs,
  isLoading: dailyRecommendIsLoading,
  loadError: dailyRecommendLoadError,
  isLoggedIn: qqIsLoggedIn,
})
const { card: brushModeCard, getKicker: getBrushModeKicker } = useQQBrushModeCard({
  descriptor: brushModeDescriptor,
  songs: brushModeSongs,
  currentSong: brushModeCardSong,
  isLoading: brushModeIsLoading,
  loadError: brushModeLoadError,
  fallbackImg: computed(() => guessLikeSongs.value[1]?.meta.picUrl ?? guessLikeSongs.value[0]?.meta.picUrl ?? ''),
})

const toRecommendCard = (playlist: LX.QQMusic.RecommendPlaylist): RecommendCard => ({
  id: playlist.id,
  source: 'tx',
  play_count: playlist.playCount,
  author: playlist.author,
  name: playlist.name,
  time: '',
  img: playlist.img,
  desc: playlist.description,
  total: '',
})

const featuredCards = computed(() => [
  guessLikeCard.value,
  dailyRecommendCard.value,
  brushModeCard.value,
  ...(homeRecommendation.value?.featuredPlaylists ?? []).slice(0, 2).map(toRecommendCard),
])

const allHomePlaylists = computed(() => [
  ...(homeRecommendation.value?.featuredPlaylists ?? []),
  ...(homeRecommendation.value?.privatePlaylists ?? []),
  ...(homeRecommendation.value?.guidePlaylists ?? []),
])
const homePlaylistById = computed(() => new Map(allHomePlaylists.value.map(playlist => [playlist.id, playlist])))

const relatedSongPages = computed(() => {
  const groups = homeRecommendation.value?.relatedSongGroups ?? []
  const pages: LX.Music.MusicInfo_tx[][] = []
  for (let index = 0; index < groups.length; index += 3) {
    const page = groups.slice(index, index + 3).flat()
    if (page.length) pages.push(page)
  }
  return pages
})
const visibleRelatedSongs = computed(() => relatedSongPages.value[relatedPageIndex.value] ?? [])

const homePlayback = useQQHomeRecommendPlayback({
  relatedSongs: visibleRelatedSongs,
  setError: message => {
    interactionError.value = message
  },
})

const {
  isCardPlaying: isGuessLikeCardPlaying,
  getCardPlayLabel: getGuessLikeCardPlayLabel,
  handleCardAction: handleGuessLikeCardAction,
} = useQQGuessLikePlayback({
  loadSongs: loadQQGuessLikeSongs,
  getAccountKey: () => accountKey.value,
  getAccountRevision: () => accountRevision,
  onLoginRequired: handleShowLogin,
})

const {
  isCardPlaying: isBrushModeCardPlaying,
  getCardPlayLabel: getBrushModeCardPlayLabel,
  handleCardAction: handleBrushModeCardAction,
} = useQQBrushModePlayback({
  loadSongs: loadQQBrushModeSongs,
  getAccountKey: () => accountKey.value,
  getAccountRevision: () => accountRevision,
  onLoginRequired: handleShowLogin,
})

const {
  isCardPlaying: isDailyRecommendCardPlaying,
  getCardPlayLabel: getDailyRecommendCardPlayLabel,
  handleCardOpen: handleDailyRecommendCardOpen,
  handleCardPlay: handleDailyRecommendCardPlay,
} = useQQDailyRecommendPlayback({
  loadSongs: loadQQDailyRecommendSongs,
  getAccountKey: () => accountKey.value,
  onLoginRequired: handleShowLogin,
})

const pageTitle = computed(() => homeRecommendation.value?.title ??
  `Hi ${qqProfile.value?.nickname ?? 'QQ Music'} 今日为你推荐`)
const effectiveError = computed(() => interactionError.value.length ? interactionError.value : homeLoadError.value)
const isPageRefreshing = computed(() => homeIsRefreshing.value || guessLikeIsRefreshing.value ||
  brushModeIsLoading.value || dailyRecommendIsRefreshing.value)
const showEmptyState = computed(() => {
  if (homeIsLoading.value || homeLoadError.value || !homeRecommendation.value) return false
  return !homeRecommendation.value.privatePlaylists.length &&
    !homeRecommendation.value.relatedSongGroups.length &&
    !homeRecommendation.value.guidePlaylists.length
})

const isHomePlaylistPlaying = (playlist: LX.QQMusic.RecommendPlaylist) => {
  return homePlayback.isPlaylistPlayingList(playlist) && isPlay.value
}

const isFeatureCardPlaying = (card: RecommendCard) => {
  if (card.isQQGuessLike) return isGuessLikeCardPlaying(card)
  if (card.isQQDailyRecommend) return isDailyRecommendCardPlaying(card)
  if (card.isQQBrushMode) return isBrushModeCardPlaying(card)
  const playlist = homePlaylistById.value.get(card.id)
  return playlist ? isHomePlaylistPlaying(playlist) : false
}

const getFeatureCardPlayLabel = (card: RecommendCard) => {
  if (card.isQQGuessLike) return getGuessLikeCardPlayLabel(card)
  if (card.isQQDailyRecommend) return getDailyRecommendCardPlayLabel(card)
  if (card.isQQBrushMode) return getBrushModeCardPlayLabel(card)
  const playlist = homePlaylistById.value.get(card.id)
  return playlist ? homePlayback.getPlaylistPlayLabel(playlist) : `播放 ${card.name}`
}

const getFeatureCardKicker = (card: RecommendCard) => {
  if (card.isQQGuessLike) return getGuessLikeKicker()
  if (card.isQQDailyRecommend) return getDailyRecommendKicker()
  if (card.isQQBrushMode) return getBrushModeKicker()
  return card.author || 'QQ Music'
}

const handleFeatureCardOpen = async(card: RecommendCard) => {
  interactionError.value = ''
  if (card.isQQGuessLike) return handleGuessLikeCardAction(card)
  if (card.isQQDailyRecommend) return handleDailyRecommendCardOpen(card)
  if (card.isQQBrushMode) return handleBrushModeCardAction(card)
  const playlist = homePlaylistById.value.get(card.id)
  if (playlist) await homePlayback.openPlaylist(playlist)
}

const handleFeatureCardPlay = async(card: RecommendCard) => {
  interactionError.value = ''
  if (card.isQQGuessLike) return handleGuessLikeCardAction(card)
  if (card.isQQDailyRecommend) return handleDailyRecommendCardPlay(card)
  if (card.isQQBrushMode) return handleBrushModeCardAction(card)
  const playlist = homePlaylistById.value.get(card.id)
  if (playlist) await homePlayback.togglePlaylist(playlist)
}

const showPreviousRelatedSongs = () => {
  const count = relatedSongPages.value.length
  if (count < 2) return
  relatedPageIndex.value = (relatedPageIndex.value - 1 + count) % count
}

const showNextRelatedSongs = () => {
  const count = relatedSongPages.value.length
  if (count < 2) return
  relatedPageIndex.value = (relatedPageIndex.value + 1) % count
}

const loadAll = async(force = false) => {
  await Promise.allSettled([
    loadHomeRecommendation(force),
    loadQQGuessLikeSongs(force),
    loadQQBrushModeSongs(force),
    loadQQDailyRecommendSongs(force),
  ])
}

const handleRefresh = async() => {
  interactionError.value = ''
  await loadAll(true)
}

const clearAll = () => {
  relatedPageIndex.value = 0
  interactionError.value = ''
  clearGuessLikeCardSong()
  clearBrushModeCardSong()
  clearHomeRecommendation()
  clearQQGuessLikeSongs()
  clearQQBrushModeSongs()
  clearQQDailyRecommendSongs()
}

const initializeAccount = async() => {
  isInitializingAccount = true
  await initQQMusicAccount().catch(() => null)
  await nextTick()
  isInitializingAccount = false
  if (accountKey.value) await loadAll()
  else clearAll()
}

watch(accountKey, (value, oldValue) => {
  if (value == oldValue) return
  accountRevision++
  clearAll()
  if (!value) return
  handleCloseLogin()
  if (!isInitializingAccount) void loadAll(true)
})

watch(relatedSongPages, pages => {
  if (relatedPageIndex.value >= pages.length) relatedPageIndex.value = 0
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
@import '@renderer/assets/styles/layout.less';

.page {
  position: relative;
  height: 100%;
  overflow: hidden;
}

.content {
  height: 100%;
  padding: 18px 34px 34px;
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
}

.pageHeader {
  min-width: 0;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;

  h2 {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--color-font);
    font-size: 23px;
    line-height: 1.25;
    font-weight: 800;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}

.homeFlow {
  min-width: 0;
  display: flex;
  flex-flow: column nowrap;
  gap: 32px;
}

.errorBanner {
  min-height: 38px;
  margin: 0 0 16px;
  padding: 8px 10px 8px 13px;
  box-sizing: border-box;
  border-left: 3px solid var(--color-primary);
  color: var(--color-font-label);
  background-color: rgba(128, 128, 128, .08);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;

  button {
    flex: none;
    padding: 5px 10px;
    border: 0;
    border-radius: 6px;
    color: var(--color-primary);
    background-color: var(--color-primary-background-hover);
    cursor: pointer;
  }
}

.signedOut {
  min-height: 100%;
  display: flex;
  flex-flow: column nowrap;
  align-items: center;
  justify-content: center;
  text-align: center;

  h2 {
    margin: 0;
    color: var(--color-font);
    font-size: 24px;
    line-height: 1.25;
  }

  p {
    margin: 10px 0 20px;
    color: var(--color-font-label);
    font-size: 13px;
    line-height: 1.45;
  }

  button {
    min-height: 36px;
    padding: 0 18px;
    border: 0;
    border-radius: 7px;
    color: #fff;
    background-color: var(--color-primary);
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: opacity @transition-fast, transform @transition-fast;

    &:hover {
      opacity: .9;
      transform: translateY(-1px);
    }
  }
}

.emptyState {
  min-height: 96px;
  margin: 0;
  color: var(--color-font-label);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}

@media (max-width: 720px) {
  .content {
    padding: 15px 24px 28px;
  }

  .pageHeader h2 {
    font-size: 20px;
  }

  .homeFlow {
    gap: 28px;
  }
}
</style>
