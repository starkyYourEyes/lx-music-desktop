<template>
  <div :class="$style.recommend">
    <div :class="$style.playlistPage">
      <login-panel
        v-if="showLoginPanel && !isLoggedIn"
        :qr-img="qrImg"
        :qr-status-text="qrStatusText"
        :is-creating-qr="isCreatingQr"
        @close="handleCloseLogin"
        @refresh="handleCreateLoginQr"
      />

      <div v-if="isExploreMode" :class="$style.sectionHead">
        <div :class="$style.heading">
          <h2>{{ pageTitle }}</h2>
          <p>{{ pageSubTitle }}</p>
        </div>
        <div :class="$style.actions">
          <button v-if="!isExploreMode" :class="$style.linkBtn" type="button" @click="handleShowAll">查看全部</button>
          <base-btn v-if="isLoggedIn" min :disabled="isLoadingPlaylists" @click="handleRefresh">刷新</base-btn>
        </div>
      </div>

      <transition enter-active-class="animated fadeIn" leave-active-class="animated fadeOut">
        <div v-if="effectivePlaylistNoItemText" :class="$style.noitem">
          <p>{{ effectivePlaylistNoItemText }}</p>
        </div>
      </transition>

      <div v-if="!effectivePlaylistNoItemText" ref="playlistScrollRef" :class="$style.playlistScroll" class="scroll">
        <explore-playlist-grid
          v-if="isExploreMode"
          :playlists="displayedPlaylists"
          :is-card-playing="isCardPlaying"
          :get-card-play-label="getCardPlayLabel"
          @open="handleOpenPlaylist"
          @toggle-card-play="handleToggleCardPlay"
        />

        <div v-else :class="$style.homeFlow">
          <SpecialCards
            :cards="specialCards"
            :is-card-playing="isCardPlaying"
            :get-card-play-label="getCardPlayLabel"
            :get-special-card-kicker="getSpecialCardKicker"
            @open="handleOpenPlaylist"
            @toggle-card-play="handleToggleCardPlay"
          />

          <horizontal-playlist-section
            title="雷达歌单"
            desc="从你的听歌偏好延展出的专属歌单"
            card-type="radar"
            :playlists="filteredHomeRadarPlaylists"
            :is-playlist-playing-list="isPlaylistPlayingList"
            :get-playlist-play-label="getPlaylistPlayLabel"
            @open="handleOpenPlaylist"
            @toggle-play="handleTogglePlaylistPlay"
          />

          <similar-songs-section
            :songs="homeSimilarSongs"
            :refreshing="isRefreshingSimilarSongs"
            :is-home-song-playing="isHomeSongPlaying"
            :is-home-song-loved="isHomeSongLoved"
            @refresh="handleRefreshSimilarSongs"
            @play="handlePlayHomeSongs"
            @toggle-love="handleToggleHomeSongLove"
          />

          <horizontal-playlist-section
            ref="recommendSectionRef"
            title="推荐歌单"
            desc="今天更适合继续听这些"
            card-type="strip"
            refreshable
            :refreshing="isRefreshingRecommendPlaylists"
            :playlists="filteredHomeRecommendPlaylists"
            :is-playlist-playing-list="isPlaylistPlayingList"
            :get-playlist-play-label="getPlaylistPlayLabel"
            @open="handleOpenPlaylist"
            @toggle-play="handleTogglePlaylistPlay"
            @refresh="handleRefreshRecommendPlaylists"
          />

          <charts-section
            :charts="homeCharts"
            @open="handleOpenChart"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from '@common/utils/vueTools'
import { useRoute } from '@common/utils/vueRouter'
import { initNeteaseAccount, isLoggedIn, profile } from '@renderer/store/netease'
import ChartsSection from './components/ChartsSection.vue'
import ExplorePlaylistGrid from './components/ExplorePlaylistGrid.vue'
import HorizontalPlaylistSection from './components/HorizontalPlaylistSection.vue'
import LoginPanel from './components/LoginPanel.vue'
import SimilarSongsSection from './components/SimilarSongsSection.vue'
import SpecialCards from './components/SpecialCards.vue'
import { useNeteaseLoginQr } from './useNeteaseLoginQr'
import { useRecommendCards } from './useRecommendCards'
import { useRecommendData } from './useRecommendData'
import { useRecommendLove } from './useRecommendLove'
import { useRecommendPlayback } from './useRecommendPlayback'

interface HorizontalPlaylistSectionExpose {
  scrollToStart: () => void
}

const route = useRoute()
const playlistScrollRef = ref<HTMLElement | null>(null)
const recommendSectionRef = ref<HorizontalPlaylistSectionExpose | null>(null)

const profileNickname = computed(() => profile.value?.nickname ? profile.value.nickname : 'WY')
const isExploreMode = computed(() => route.query.category === 'playlists')
const pageTitle = computed(() => isExploreMode.value ? '更多推荐' : '推荐')
const pageSubTitle = computed(() => isLoggedIn.value ? `${profileNickname.value} 的音乐首页` : '登录后获取每日推荐、私人漫游与雷达歌单')

const recommendData = useRecommendData({
  isExploreMode,
  playlistScrollRef,
  onHomeSongsUpdated: () => {},
})

const {
  isLoadingPlaylists,
  playlistLoadError,
  recommendPlaylists,
  displayedPlaylists,
  homeRadarPlaylists,
  homeSimilarSongs,
  homeRecommendPlaylists,
  homeCharts,
  playlistNoItemText,
  isRefreshingSimilarSongs,
  isRefreshingRecommendPlaylists,
  loadRecommendPlaylists,
  handleRefresh,
  handleRefreshSimilarSongs,
} = recommendData

const { specialCards, getSpecialCardKicker } = useRecommendCards(recommendPlaylists)
const specialCardIds = computed(() => new Set(specialCards.value.map(playlist => playlist.id)))
const hasSpecialHomeContent = computed(() => specialCards.value.some(playlist => !playlist.isPlaceholder))
const effectivePlaylistNoItemText = computed(() => {
  if (!isExploreMode.value && hasSpecialHomeContent.value) return ''
  return playlistNoItemText.value
})
const filteredHomeRadarPlaylists = computed(() => homeRadarPlaylists.value)
const filteredHomeRecommendPlaylists = computed(() => homeRecommendPlaylists.value.filter(playlist => !specialCardIds.value.has(playlist.id)))

const recommendLove = useRecommendLove(homeSimilarSongs)
const {
  updateHomeSongLoveStatuses,
  isHomeSongLoved,
  handleToggleHomeSongLove,
} = recommendLove

const {
  isPlaylistPlayingList,
  isHomeSongPlaying,
  isCardPlaying,
  getCardPlayLabel,
  getPlaylistPlayLabel,
  handleToggleCardPlay,
  handleTogglePlaylistPlay,
  handlePlayHomeSongs,
  handleOpenPlaylist,
  handleOpenChart,
  handleShowAll,
} = useRecommendPlayback({
  homeSimilarSongs,
  setError: message => {
    playlistLoadError.value = message
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
} = useNeteaseLoginQr(async() => {
  await loadRecommendPlaylists(true)
})

const handleRefreshRecommendPlaylists = async() => {
  await recommendData.handleRefreshRecommendPlaylists()
  await nextTick()
  recommendSectionRef.value?.scrollToStart()
}

watch(isExploreMode, () => {
  void loadRecommendPlaylists()
})

watch(homeSimilarSongs, () => {
  void updateHomeSongLoveStatuses()
})

watch(() => route.query.login, login => {
  if (login == '1' && !isLoggedIn.value) handleShowLogin()
}, { immediate: true })

watch(isLoggedIn, () => {
  void loadRecommendPlaylists(true)
})

const handleAccountLoginRequest = () => {
  if (!isLoggedIn.value) handleShowLogin()
}

onMounted(() => {
  window.addEventListener('show-netease-login', handleAccountLoginRequest)
  void initNeteaseAccount()
    .then(() => {
      void loadRecommendPlaylists()
    })
    .catch(() => {
      void loadRecommendPlaylists()
    })
})

onBeforeUnmount(() => {
  window.removeEventListener('show-netease-login', handleAccountLoginRequest)
})
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.recommend {
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  position: relative;
}

.playlistPage {
  height: 100%;
  display: flex;
  flex-flow: column nowrap;
  box-sizing: border-box;
  overflow: hidden;
}

.sectionHead {
  flex: none;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 24px 10px;
  box-sizing: border-box;
}

.heading {
  min-width: 0;

  h2 {
    margin: 0;
    color: var(--color-font);
    font-size: 24px;
    line-height: 1.25;
    font-weight: 800;
  }

  p {
    margin: 6px 0 0;
    color: var(--color-font-label);
    font-size: 13px;
    line-height: 1.45;
  }
}

.actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
}

.linkBtn {
  border: 0;
  background: transparent;
  color: var(--color-font-label);
  font-size: 13px;
  line-height: 1.2;
  cursor: pointer;
  transition: color @transition-fast;

  &:hover {
    color: var(--color-primary);
  }
}

.playlistScroll {
  flex: auto;
  min-height: 0;
  --recommend-content-left: 34px;
  --recommend-content-right: 34px;
  --recommend-carousel-gutter: 56px;
  padding: 16px var(--recommend-content-right) 28px var(--recommend-content-left);
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
}

.homeFlow {
  display: flex;
  flex-flow: column nowrap;
  gap: 30px;
}

.noitem {
  flex: auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-font-label);
  font-size: 14px;
}

@media (max-width: 720px) {
  .sectionHead {
    padding: 14px 16px 8px;
  }

  .playlistScroll {
    --recommend-content-left: 24px;
    --recommend-content-right: 24px;
    --recommend-carousel-gutter: 42px;
    padding: 14px var(--recommend-content-right) 22px var(--recommend-content-left);
  }
}
</style>
