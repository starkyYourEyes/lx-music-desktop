<template lang="pug">
dt#listening_time 听歌时间
dd
  div(:class="$style.hero")
    div(:class="$style.heroText")
      p(:class="$style.kicker") Listening Time
      h3(:class="$style.total") {{ totalLabel }}
      p(:class="$style.caption") 只统计真实播放经过的时间，暂停、快进和切歌不会重复累计。
    div(:class="$style.ring" :style="ringStyle")
      span {{ todayPercent }}%
      small 今日

dd
  h3 今日概览
  div(:class="$style.statsGrid")
    div(:class="$style.statItem")
      svg-icon(name="play-outline" :class="$style.statIcon")
      div
        p(:class="$style.statLabel") 今日
        strong {{ todayLabel }}
    div(:class="$style.statItem")
      svg-icon(name="headphones" :class="$style.statIcon")
      div
        p(:class="$style.statLabel") 本周
        strong {{ weekLabel }}
    div(:class="$style.statItem")
      svg-icon(name="music" :class="$style.statIcon")
      div
        p(:class="$style.statLabel") 已记录歌曲
        strong {{ songCount }} 首

dd
  h3 最近 7 天
  div(:class="$style.chart")
    div(v-for="item in weekItems" :key="item.key" :class="$style.barItem")
      div(:class="$style.barTrack")
        div(:class="$style.barFill" :style="{ height: item.height }")
      span {{ item.label }}

dd
  h3 最常听
  div(v-if="topSongs.length" :class="$style.songList")
    div(v-for="song in topSongs" :key="song.key" :class="$style.songItem")
      div(:class="$style.songMeta")
        strong {{ song.name }}
        span {{ song.singer || '未知歌手' }}
      em {{ song.time }}
  div(v-else :class="$style.empty")
    | 暂时还没有统计数据。播放几首歌后，这里会慢慢亮起来。
</template>

<script>
import { computed } from '@common/utils/vueTools'
import { getLocalDateKey, formatListeningTime } from '@common/utils/listeningTime'
import { listeningTimeStats } from '@renderer/store/listeningTime/state'

const DAY_GOAL_SECONDS = 2 * 60 * 60

const getDayLabel = date => `${date.getMonth() + 1}/${date.getDate()}`

export default {
  name: 'SettingListeningTime',
  setup() {
    const todayKey = computed(() => getLocalDateKey())
    const todaySeconds = computed(() => listeningTimeStats.daily[todayKey.value] ?? 0)
    const weekItems = computed(() => {
      const days = Array.from({ length: 7 }, (_, index) => {
        const date = new Date()
        date.setDate(date.getDate() - (6 - index))
        const key = getLocalDateKey(date)
        const seconds = listeningTimeStats.daily[key] ?? 0
        return {
          key,
          label: getDayLabel(date),
          seconds,
        }
      })
      const maxSeconds = Math.max(...days.map(item => item.seconds), 1)
      return days.map(item => ({
        ...item,
        height: `${Math.max(item.seconds / maxSeconds * 100, item.seconds ? 12 : 4)}%`,
      }))
    })
    const weekSeconds = computed(() => weekItems.value.reduce((sum, item) => sum + item.seconds, 0))
    const todayPercent = computed(() => Math.min(100, Math.round(todaySeconds.value / DAY_GOAL_SECONDS * 100)))
    const ringStyle = computed(() => ({
      '--progress': `${todayPercent.value * 3.6}deg`,
    }))
    const topSongs = computed(() => Object.entries(listeningTimeStats.songs)
      .map(([key, song]) => ({
        key,
        name: song.name,
        singer: song.singer,
        seconds: song.seconds,
        time: formatListeningTime(song.seconds),
      }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 5))

    return {
      totalLabel: computed(() => formatListeningTime(listeningTimeStats.totalSeconds)),
      todayLabel: computed(() => formatListeningTime(todaySeconds.value)),
      weekLabel: computed(() => formatListeningTime(weekSeconds.value)),
      songCount: computed(() => Object.keys(listeningTimeStats.songs).length),
      todayPercent,
      ringStyle,
      weekItems,
      topSongs,
    }
  },
}
</script>

<style lang="less" module>
.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 138px;
}
.heroText {
  min-width: 0;
}
.kicker {
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  margin-bottom: 8px;
}
.total {
  color: var(--color-font);
  font-size: 30px !important;
  line-height: 1.15;
  margin: 0 0 10px !important;
  font-weight: 750;
}
.caption {
  color: var(--color-font-label);
  line-height: 1.6;
}
.ring {
  --progress: 0deg;
  flex: 0 0 116px;
  width: 116px;
  height: 116px;
  border-radius: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(circle at center, var(--color-content-background) 0 58%, transparent 59%),
    conic-gradient(var(--color-primary) var(--progress), var(--color-primary-alpha-900) 0);
  box-shadow: inset 0 0 0 1px var(--color-primary-alpha-900);

  span {
    color: var(--color-font);
    font-size: 22px;
    font-weight: 760;
  }
  small {
    color: var(--color-font-label);
    margin-top: 4px;
  }
}
.statsGrid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.statItem {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 14px;
  border-radius: 8px;
  background: var(--color-primary-alpha-900);
}
.statIcon {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  color: var(--color-primary);
}
.statLabel {
  color: var(--color-font-label);
  margin-bottom: 5px;
}
.statItem strong {
  color: var(--color-font);
  font-size: 18px;
  font-weight: 740;
}
.chart {
  display: grid;
  grid-template-columns: repeat(7, minmax(28px, 1fr));
  align-items: end;
  gap: 12px;
  height: 154px;
}
.barItem {
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  gap: 8px;
}
.barTrack {
  flex: 1;
  width: 100%;
  max-width: 36px;
  display: flex;
  align-items: end;
  border-radius: 999px;
  background: var(--color-primary-alpha-900);
  overflow: hidden;
}
.barFill {
  width: 100%;
  min-height: 4px;
  border-radius: 999px;
  background: linear-gradient(180deg, var(--color-primary-light-200), var(--color-primary));
  transition: height .25s ease;
}
.barItem span {
  color: var(--color-font-label);
  font-size: 12px;
}
.songList {
  display: grid;
  gap: 9px;
}
.songItem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 13px;
  border-radius: 8px;
  background: var(--color-primary-alpha-900);
}
.songMeta {
  min-width: 0;
  display: grid;
  gap: 4px;

  strong,
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  strong {
    color: var(--color-font);
    font-weight: 650;
  }
  span {
    color: var(--color-font-label);
    font-size: 12px;
  }
}
.songItem em {
  flex: 0 0 auto;
  color: var(--color-primary);
  font-style: normal;
  font-weight: 650;
}
.empty {
  padding: 22px;
  border-radius: 8px;
  color: var(--color-font-label);
  background: var(--color-primary-alpha-900);
}

@media (max-width: 860px) {
  .hero {
    align-items: flex-start;
  }
  .statsGrid {
    grid-template-columns: 1fr;
  }
}
</style>
