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
  div(:class="$style.weekList")
    div(v-for="item in weekItems" :key="item.key" :class="$style.weekRow")
      span(:class="$style.weekLabel") {{ item.label }}
      div(:class="$style.weekTrack" aria-hidden="true")
        div(:class="$style.weekFill" :style="{ width: `${item.width}%` }")
      span(:class="$style.weekDuration") {{ item.duration }}

dd
  h3 最常听
  div(v-if="topSongs.length" :class="$style.songList" role="list")
    div(v-for="song in topSongs" :key="song.key" :class="$style.songItem" role="listitem")
      span(:class="$style.songRank") {{ song.rank }}
      div(:class="$style.songMeta")
        strong {{ song.name }}
        span {{ song.singer || '未知歌手' }}
      em 播放 {{ song.playCount }} 次
  div(v-else :class="$style.empty")
    | 暂无播放记录
</template>

<script>
import { computed } from '@common/utils/vueTools'
import {
  buildListeningWeekRows,
  formatListeningTime,
  getLocalDateKey,
  rankTracksByPlayCount,
} from '@common/utils/listeningTime'
import { listeningTimeStats } from '@renderer/store/listeningTime/state'

const DAY_GOAL_SECONDS = 2 * 60 * 60

export default {
  name: 'SettingListeningTime',
  setup() {
    const todayKey = computed(() => getLocalDateKey())
    const todaySeconds = computed(() => (listeningTimeStats.daily.find(item => item.localDay == todayKey.value)?.playedMs ?? 0) / 1000)
    const weekItems = computed(() => buildListeningWeekRows(listeningTimeStats.daily))
    const weekSeconds = computed(() => {
      const weekKeys = new Set(weekItems.value.map(item => item.key))
      return listeningTimeStats.daily.reduce((sum, item) =>
        sum + (weekKeys.has(item.localDay) ? item.playedMs / 1000 : 0), 0)
    })
    const todayPercent = computed(() => Math.min(100, Math.round(todaySeconds.value / DAY_GOAL_SECONDS * 100)))
    const ringStyle = computed(() => ({
      '--progress': `${todayPercent.value * 3.6}deg`,
    }))
    const topSongs = computed(() => rankTracksByPlayCount(listeningTimeStats.tracks, 100))

    return {
      totalLabel: computed(() => formatListeningTime(listeningTimeStats.total.playedMs / 1000)),
      todayLabel: computed(() => formatListeningTime(todaySeconds.value)),
      weekLabel: computed(() => formatListeningTime(weekSeconds.value)),
      songCount: computed(() => listeningTimeStats.tracks.filter(song => song.playCount > 0).length),
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
.weekList {
  display: grid;
  gap: 10px;
}
.weekRow {
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr) 92px;
  align-items: center;
  gap: 12px;
  min-height: 28px;
}
.weekLabel,
.weekDuration {
  color: var(--color-font-label);
  font-size: 12px;
  white-space: nowrap;
}
.weekTrack {
  width: 100%;
  height: 10px;
  border-radius: 3px;
  background: var(--color-primary-alpha-900);
  overflow: hidden;
}
.weekFill {
  height: 100%;
  border-radius: inherit;
  background: var(--color-primary);
  transition: width .25s ease;
}
.weekDuration {
  color: var(--color-font);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.songList {
  height: 420px;
  overflow-y: auto;
  border-top: 1px solid var(--color-primary-alpha-900);
  border-bottom: 1px solid var(--color-primary-alpha-900);
}
.songItem {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) minmax(88px, auto);
  align-items: center;
  gap: 12px;
  min-height: 54px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-primary-alpha-900);

  &:last-child {
    border-bottom: 0;
  }
}
.songRank {
  color: var(--color-font-label);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: center;
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
  min-width: 0;
  max-width: min(180px, 40vw);
  color: var(--color-primary);
  font-size: 12px;
  font-style: normal;
  font-weight: 650;
  overflow-wrap: anywhere;
  text-align: right;
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

@media (max-width: 520px) {
  .hero {
    gap: 12px;
  }
  .ring {
    flex-basis: 88px;
    width: 88px;
    height: 88px;
  }
  .total {
    font-size: 24px !important;
  }
  .weekRow {
    grid-template-columns: 68px minmax(0, 1fr) 78px;
    gap: 8px;
  }
  .songList {
    height: 360px;
  }
  .songItem {
    grid-template-columns: 30px minmax(0, 1fr) minmax(76px, auto);
    gap: 8px;
    padding-inline: 4px;
  }
}
</style>
