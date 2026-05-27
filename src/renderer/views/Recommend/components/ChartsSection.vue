<template>
  <section v-if="charts.length" :class="$style.homeSection">
    <div :class="$style.sectionTitleBar">
      <div>
        <h3>榜单精选</h3>
        <p>热度、黑胶与畅销趋势都放在这里</p>
      </div>
    </div>
    <div :class="$style.chartGrid">
      <div
        v-for="chart in charts"
        :key="chart.id"
        :class="[$style.chartCard, { [$style.staticChart]: chart.isSales }]"
        role="button"
        tabindex="0"
        @click="$emit('open', chart)"
        @keydown.enter="$emit('open', chart)"
        @keydown.space.prevent="$emit('open', chart)"
      >
        <img v-if="chart.img" :src="chart.img" loading="lazy" decoding="async" draggable="false">
        <span v-else :class="$style.chartCoverFallback">{{ chart.name.slice(0, 1) }}</span>
        <span :class="$style.chartBody">
          <span :class="$style.chartMeta">{{ chart.updateFrequency || chart.desc || '持续更新' }}</span>
          <span :class="$style.chartName">{{ chart.name }}</span>
          <span :class="$style.chartSongs">
            <span v-for="(song, index) in chart.songs" :key="getChartSongKey(chart, index)">
              <b>{{ toDisplayIndex(index) }}</b>
              <span :class="$style.chartSongName">{{ song.name }}</span>
              <small>{{ song.singer }}</small>
            </span>
          </span>
        </span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  charts: LX.Netease.HomeChart[]
}>()

defineEmits<{
  open: [chart: LX.Netease.HomeChart]
}>()

const toNumberIndex = (index: unknown) => Number(index)
const toDisplayIndex = (index: unknown) => toNumberIndex(index) + 1
const getChartSongKey = (chart: LX.Netease.HomeChart, index: unknown) => `${String(chart.id)}_${String(index)}`
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.homeSection {
  min-width: 0;
}

.sectionTitleBar {
  margin-bottom: 12px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;

  h3 {
    margin: 0;
    font-size: 19px;
    line-height: 1.25;
    color: var(--color-font);
    font-weight: 800;
  }

  p {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--color-font-label);
  }
}

.chartGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}

.chartCard {
  min-width: 0;
  height: 154px;
  display: grid;
  grid-template-columns: 102px minmax(0, 1fr);
  gap: 18px;
  padding: 14px;
  box-sizing: border-box;
  border-radius: 8px;
  border: 1px solid rgba(128, 128, 128, .12);
  background-color: rgba(128, 128, 128, .06);
  color: var(--color-font);
  cursor: pointer;
  transition: transform @transition-normal, border-color @transition-normal, background-color @transition-normal;

  &:hover {
    transform: translateY(-1px);
    border-color: rgba(128, 128, 128, .22);
    background-color: rgba(128, 128, 128, .1);
  }

  img,
  .chartCoverFallback {
    width: 102px;
    height: 126px;
    border-radius: 8px;
    object-fit: cover;
  }
}

.staticChart {
  cursor: default;
}

.chartCoverFallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-font-label);
  background-color: rgba(128, 128, 128, .12);
  font-weight: 700;
}

.chartBody {
  min-width: 0;
  display: flex;
  flex-flow: column nowrap;
}

.chartMeta {
  color: var(--color-font-label);
  font-size: 11px;
  line-height: 1.2;
  .mixin-ellipsis-1();
}

.chartName {
  margin-top: 5px;
  color: var(--color-font);
  font-size: 17px;
  line-height: 1.22;
  font-weight: 800;
  .mixin-ellipsis-1();
}

.chartSongs {
  min-width: 0;
  margin-top: 10px;
  display: flex;
  flex-flow: column nowrap;
  gap: 6px;

  > span {
    min-width: 0;
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) minmax(0, .72fr);
    align-items: center;
    color: var(--color-font);
    font-size: 12px;
    line-height: 1.2;
    overflow: hidden;

    b {
      color: var(--color-font-label);
      font-weight: 700;
    }

    .chartSongName {
      min-width: 0;
      .mixin-ellipsis-1();
    }

    small {
      min-width: 0;
      margin-left: 5px;
      color: var(--color-font-label);
      font-size: 11px;
      .mixin-ellipsis-1();
    }
  }
}
</style>
