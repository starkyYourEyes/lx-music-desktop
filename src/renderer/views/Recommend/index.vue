<template>
  <div :class="$style.recommend">
    <div :class="$style.playlistPage">
      <div v-if="showLoginPanel && !isLoggedIn" :class="$style.loginOverlay">
        <div :class="$style.loginPanel">
          <button :class="$style.closeBtn" type="button" @click="handleCloseLogin">×</button>
          <div :class="$style.qrWrap">
            <img v-if="qrImg" :src="qrImg" draggable="false">
            <span v-else>{{ isCreatingQr ? '生成中...' : '暂无二维码' }}</span>
          </div>
          <h3>网易云音乐登录</h3>
          <p>{{ qrStatusText }}</p>
          <base-btn min :disabled="isCreatingQr" @click="handleCreateLoginQr">重新获取二维码</base-btn>
        </div>
      </div>

      <div :class="$style.sectionHead">
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
        <div v-if="playlistNoItemText" :class="$style.noitem">
          <p>{{ playlistNoItemText }}</p>
        </div>
      </transition>

      <div v-if="!playlistNoItemText" ref="playlistScrollRef" :class="$style.playlistScroll" class="scroll">
        <div :class="$style.playlistGrid">
          <button
            v-for="playlist in displayedPlaylists"
            :key="playlist.id"
            :class="[$style.playlistCard, { [$style.privateFmCard]: playlist.isPrivateFm }]"
            type="button"
            @click="handleOpenPlaylist(playlist)"
          >
            <span :class="$style.coverWrap">
              <img :class="$style.cover" loading="lazy" decoding="async" :src="playlist.img" draggable="false">
              <button
                v-if="playlist.isPrivateFm"
                type="button"
                :class="$style.fmPlayBtn"
                :aria-label="isPrivateFmPlaying ? '暂停私人 FM' : '播放私人 FM'"
                @click.stop="handleTogglePrivateFm"
              >
                <svg v-if="isPrivateFmPlaying" version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024" space="preserve">
                  <use xlink:href="#icon-pause" />
                </svg>
                <svg v-else version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024" space="preserve">
                  <use xlink:href="#icon-play" />
                </svg>
              </button>
              <span v-if="playlist.play_count" :class="$style.playCount">
                <svg-icon name="headphones" />
                {{ playlist.play_count }}
              </span>
            </span>
            <span :class="$style.playlistName">{{ playlist.name }}</span>
            <span v-if="playlist.desc || playlist.author" :class="$style.playlistDesc">
              {{ playlist.desc || playlist.author }}
            </span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from '@common/utils/vueTools'
import { useRoute, useRouter } from '@common/utils/vueRouter'
import {
  checkNeteaseLoginQr,
  createNeteaseLoginQr,
  getNeteaseRecommendPlaylists,
} from '@renderer/utils/ipc'
import {
  initNeteaseAccount,
  isLoggedIn,
  profile,
  setNeteaseAccountStatus,
} from '@renderer/store/netease'
import { isPlay } from '@renderer/store/player/state'
import { enterPrivateFmMode, refreshPrivateFmQueue } from '@renderer/store/privateFm/action'
import { isLoadingPrivateFm, isPrivateFmMode, privateFmQueue } from '@renderer/store/privateFm/state'
import { pause, play } from '@renderer/core/player'

const LOGIN_QR_PENDING_CODES = new Set([801, 802])
const HOME_PLAYLIST_LIMIT = 10
const EXPLORE_PLAYLIST_LIMIT = 100
const PRIVATE_FM_CARD_ID = 'private_fm'

const route = useRoute()
const router = useRouter()

const qrInfo = shallowRef<LX.Netease.LoginQr | null>(null)
const qrStatusText = ref('正在生成二维码...')
const isCreatingQr = ref(false)
const isLoadingPlaylists = ref(false)
const playlistLoadError = ref('')
const recommendPlaylists = ref<LX.Netease.Playlist[]>([])
const playlistScrollRef = ref<HTMLElement | null>(null)
const showLoginPanel = ref(false)

let qrTimer: number | null = null

const profileNickname = computed(() => profile.value?.nickname ? profile.value.nickname : '网易云音乐')
const qrImg = computed(() => qrInfo.value?.qrimg ?? '')
const isExploreMode = computed(() => route.query.category === 'playlists')
const playlistLimit = computed(() => isExploreMode.value ? EXPLORE_PLAYLIST_LIMIT : HOME_PLAYLIST_LIMIT)
const pageTitle = computed(() => isExploreMode.value ? '更多推荐' : '推荐歌单')
const pageSubTitle = computed(() => isLoggedIn.value ? profileNickname.value : '登录后获取每日推荐歌单，当前展示公开推荐')

const firstPrivateFmSong = computed(() => privateFmQueue[0] ?? null)
const privateFmCard = computed((): (LX.Netease.Playlist & { isPrivateFm: true }) | null => {
  const song = firstPrivateFmSong.value
  if (!song) return null
  return {
    id: PRIVATE_FM_CARD_ID,
    source: 'wy',
    play_count: '',
    author: song.singer,
    name: `从《${song.name}》开始漫游`,
    time: '',
    img: song.meta.picUrl ?? '',
    desc: song.singer || '私人 FM',
    total: '',
    isPrivateFm: true,
  }
})
const displayedPlaylists = computed(() => {
  const list = [...recommendPlaylists.value] as Array<LX.Netease.Playlist & { isPrivateFm?: boolean }>
  if (isExploreMode.value || !privateFmCard.value) return list
  if (list.length >= 2) list.splice(1, 1, privateFmCard.value)
  else list.push(privateFmCard.value)
  return list
})
const isPrivateFmPlaying = computed(() => isPrivateFmMode.value && isPlay.value)

const playlistNoItemText = computed(() => {
  if (isLoadingPlaylists.value) return '推荐歌单加载中...'
  if (playlistLoadError.value) return playlistLoadError.value
  if (!recommendPlaylists.value.length) return '暂时没有拿到推荐歌单'
  return ''
})

const clearQrTimer = () => {
  if (qrTimer == null) return
  window.clearTimeout(qrTimer)
  qrTimer = null
}

const scheduleQrCheck = () => {
  clearQrTimer()
  qrTimer = window.setTimeout(() => {
    void checkLoginStatus()
  }, 2000)
}

const checkLoginStatus = async() => {
  if (!qrInfo.value?.key || isLoggedIn.value) return

  try {
    const status = await checkNeteaseLoginQr(qrInfo.value.key)
    if (status.code == 803) {
      clearQrTimer()
      setNeteaseAccountStatus(status)
      qrStatusText.value = '登录成功'
      await loadRecommendPlaylists()
      return
    }

    if (status.code == 800) {
      clearQrTimer()
      qrStatusText.value = '二维码已过期，请重新获取'
      return
    }

    qrStatusText.value = status.code == 802
      ? '已扫码，请在手机上确认登录'
      : status.message ?? '请使用网易云音乐 App 扫码登录'

    if (LOGIN_QR_PENDING_CODES.has(status.code)) scheduleQrCheck()
  } catch (err: any) {
    qrStatusText.value = err?.message ?? '检查登录状态失败，稍后重试'
    scheduleQrCheck()
  }
}

const handleCreateLoginQr = async() => {
  clearQrTimer()
  showLoginPanel.value = true
  isCreatingQr.value = true
  qrStatusText.value = '正在生成二维码...'
  qrInfo.value = null

  try {
    qrInfo.value = await createNeteaseLoginQr()
    qrStatusText.value = '请使用网易云音乐 App 扫码登录'
    scheduleQrCheck()
  } catch (err: any) {
    qrStatusText.value = err?.message ?? '二维码生成失败'
  } finally {
    isCreatingQr.value = false
  }
}

const handleShowLogin = () => {
  if (qrInfo.value?.qrimg) {
    showLoginPanel.value = true
    scheduleQrCheck()
    return
  }
  void handleCreateLoginQr()
}

const handleCloseLogin = () => {
  showLoginPanel.value = false
  clearQrTimer()
}

const loadRecommendPlaylists = async() => {
  isLoadingPlaylists.value = true
  playlistLoadError.value = ''
  try {
    const tasks: Array<Promise<unknown>> = [
      getNeteaseRecommendPlaylists(playlistLimit.value, isExploreMode.value).then(list => {
        recommendPlaylists.value = list
      }),
    ]
    if (!isExploreMode.value && isLoggedIn.value) {
      tasks.push(refreshPrivateFmQueue().catch(err => {
        console.warn('Load private FM failed:', err)
      }))
    }
    await Promise.all(tasks)
    setTimeout(() => {
      playlistScrollRef.value?.scrollTo({ top: 0 })
    })
  } catch (err: any) {
    playlistLoadError.value = err?.message ?? '推荐歌单加载失败'
  } finally {
    isLoadingPlaylists.value = false
  }
}

const handleRefresh = () => {
  void loadRecommendPlaylists()
}

const handleShowAll = () => {
  void router.push({
    path: '/recommend',
    query: {
      category: 'playlists',
    },
  })
}

const handleOpenPlaylist = (playlist: LX.Netease.Playlist & { isPrivateFm?: boolean }) => {
  if (playlist.isPrivateFm) {
    void handleTogglePrivateFm()
    return
  }
  void router.push({
    path: '/songList/detail',
    query: {
      source: playlist.source,
      id: playlist.id,
      picUrl: playlist.img,
      fromName: route.name as string,
    },
  })
}

const handleTogglePrivateFm = async() => {
  if (isPrivateFmPlaying.value) {
    pause()
    return
  }
  if (isPrivateFmMode.value) {
    play()
    return
  }
  if (isLoadingPrivateFm.value) return
  try {
    await enterPrivateFmMode()
  } catch (err: any) {
    playlistLoadError.value = err?.message ?? '私人 FM 加载失败'
  }
}

watch(isExploreMode, () => {
  void loadRecommendPlaylists()
})

watch(() => route.query.login, login => {
  if (login == '1' && !isLoggedIn.value) handleShowLogin()
}, { immediate: true })

watch(isLoggedIn, () => {
  void loadRecommendPlaylists()
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
  clearQrTimer()
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

.actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.playlistPage {
  position: absolute;
  inset: 0;
  display: flex;
  flex-flow: column nowrap;
  min-height: 0;
}

.sectionHead {
  flex: none;
  padding: 22px 24px 8px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.heading {
  min-width: 0;

  h2 {
    margin: 0;
    font-size: 30px;
    line-height: 1.2;
    color: var(--color-font);
    font-weight: 800;
  }

  p {
    margin: 5px 0 0;
    font-size: 13px;
    color: var(--color-font-label);
    .mixin-ellipsis-1();
  }
}

.linkBtn {
  flex: none;
  border: 0;
  padding: 4px 0;
  background: transparent;
  color: var(--color-font);
  cursor: pointer;
  font-size: 14px;
  opacity: .82;
  transition: opacity @transition-normal;

  &:hover {
    opacity: 1;
  }
}

.playlistScroll {
  flex: auto;
  min-height: 0;
  overflow: auto;
  padding: 18px 24px 36px;
  box-sizing: border-box;
}

.playlistGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 34px 28px;
  align-items: start;
}

.playlistCard {
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--color-font);
  text-align: left;
  cursor: pointer;
  display: block;
  transition: opacity @transition-normal, transform @transition-normal;

  &:hover {
    opacity: .82;
    transform: translateY(-1px);
  }
}

.privateFmCard {
  .coverWrap {
    box-shadow: 0 12px 28px rgba(0, 0, 0, .16);

    &:after {
      .mixin-after();
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background: linear-gradient(180deg, rgba(0, 0, 0, .04), rgba(0, 0, 0, .22));
      pointer-events: none;
    }
  }
}

.coverWrap {
  position: relative;
  display: block;
  aspect-ratio: 1 / 1;
  border-radius: 9px;
  overflow: hidden;
  background-color: rgba(0, 0, 0, .08);
  box-shadow: 0 0 2px 0 rgba(0, 0, 0, .18);
}

.fmPlayBtn {
  position: absolute;
  z-index: 2;
  right: 10px;
  bottom: 10px;
  width: 40px;
  height: 40px;
  border: 0;
  padding: 9px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background-color: transparent;
  box-shadow: none;
  cursor: pointer;
  filter: drop-shadow(0 2px 5px rgba(0, 0, 0, .42));
  transition: transform @transition-fast, opacity @transition-fast;

  svg {
    width: 100%;
    height: 100%;
    fill: currentColor;
  }

  &:hover {
    opacity: .94;
    transform: scale(1.06);
  }

  &:active {
    transform: scale(.98);
  }
}

.cover {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.playCount {
  position: absolute;
  top: 7px;
  right: 8px;
  max-width: calc(100% - 16px);
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border-radius: 8px;
  background-color: rgba(0, 0, 0, .38);
  color: #fff;
  font-size: 12px;
  line-height: 1.2;
  backdrop-filter: blur(8px);
  .mixin-ellipsis-1();

  svg {
    flex: none;
    width: 12px;
    height: 12px;
  }
}

.playlistName {
  display: -webkit-box;
  overflow: hidden;
  margin-top: 11px;
  color: var(--color-font);
  font-size: 16px;
  line-height: 1.24;
  font-weight: 700;
  word-break: break-all;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.playlistDesc {
  display: block;
  margin-top: 4px;
  color: var(--color-font-label);
  font-size: 12px;
  line-height: 1.25;
  .mixin-ellipsis-1();
}

.noitem {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;

  p {
    font-size: 22px;
    color: var(--color-font-label);
  }
}

.loginOverlay {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  background-color: rgba(20, 28, 31, .28);
  backdrop-filter: blur(8px);
}

.loginPanel {
  position: relative;
  width: min(360px, 100%);
  text-align: center;
  padding: 28px;
  box-sizing: border-box;
  border-radius: 8px;
  background-color: var(--color-main-background);
  border: 1px solid rgba(128, 128, 128, .14);
  box-shadow: 0 18px 42px rgba(31, 38, 35, .18);

  h3 {
    margin: 18px 0 8px;
    font-size: 18px;
    color: var(--color-font);
  }

  p {
    margin: 0 0 16px;
    min-height: 20px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--color-font-label);
  }
}

.closeBtn {
  position: absolute;
  top: 10px;
  right: 12px;
  width: 28px;
  height: 28px;
  border: 0;
  padding: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-font-label);
  font-size: 22px;
  line-height: 28px;
  cursor: pointer;
  transition: color @transition-normal, background-color @transition-normal;

  &:hover {
    color: var(--color-font);
    background-color: rgba(0, 0, 0, .08);
  }
}

.qrWrap {
  width: 218px;
  height: 218px;
  margin: 0 auto;
  border-radius: 8px;
  overflow: hidden;
  background-color: #fff;
  box-shadow: inset 0 0 0 1px rgba(128, 128, 128, .1);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-font-label);

  img {
    display: block;
    width: 100%;
    height: 100%;
  }
}
</style>
