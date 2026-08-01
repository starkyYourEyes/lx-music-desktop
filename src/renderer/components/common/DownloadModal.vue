<template>
  <material-modal :show="show" :bg-close="bgClose" :teleport="teleport" @close="handleClose">
    <main :class="$style.main">
      <h2>{{ info.name }}<br>{{ info.singer }}</h2>
      <div v-if="sourceState == 'loading'" :class="$style.status">{{ $t('download__source_loading') }}</div>
      <div v-else-if="sourceState == 'unsupported'" :class="$style.status">{{ $t('download__source_unsupported') }}</div>
      <div v-else-if="sourceState == 'failed'" :class="$style.status">{{ $t('download__source_init_failed') }}</div>
      <base-btn v-for="quality in qualitys" v-else :key="quality.type" :class="$style.btn" @click="handleClick(quality.type)">
        {{ getTypeName(quality.type) }}{{ quality.size && ` - ${quality.size.toUpperCase()}` }}
      </base-btn>
    </main>
  </material-modal>
</template>

<script>
import { qualityList } from '@renderer/store'
import { createDownloadTasks } from '@renderer/store/download/action'
import { ensurePrimarySourceCapabilities } from '@renderer/core/music/primarySource'
import { appSetting } from '@renderer/store/setting'

export default {
  props: {
    show: {
      type: Boolean,
      default: false,
    },
    musicInfo: {
      type: [Object, null],
      required: true,
    },
    listId: {
      type: String,
      default: '',
    },
    bgClose: {
      type: Boolean,
      default: true,
    },
    teleport: {
      type: String,
      default: '#root',
    },
  },
  emits: ['update:show'],
  setup() {
    return {
      qualityList,
    }
  },
  data() {
    return {
      sourceState: 'idle',
      sourceRequestToken: 0,
      availableQualitys: [],
    }
  },
  computed: {
    info() {
      return this.musicInfo || {}
    },
    sourceQualityList() {
      return this.availableQualitys
    },
    qualitys() {
      return this.info.meta?.qualitys?.filter(quality => this.checkSource(quality.type)) || []
    },
  },
  watch: {
    show(value, previous) {
      if (value && !previous) void this.loadSourceCapabilities()
      if (!value) this.sourceRequestToken++
    },
  },
  methods: {
    async loadSourceCapabilities() {
      const musicInfo = this.musicInfo
      if (!musicInfo) return
      const token = ++this.sourceRequestToken
      const primaryId = appSetting['common.apiSource']
      const musicKey = `${musicInfo.source}:${musicInfo.id}`
      this.sourceState = 'loading'
      this.availableQualitys = []
      try {
        const capabilities = await ensurePrimarySourceCapabilities()
        if (!this.show || token != this.sourceRequestToken ||
          primaryId != appSetting['common.apiSource'] ||
          musicKey != `${this.musicInfo?.source}:${this.musicInfo?.id}`) return
        const sourceInfo = capabilities.sources[musicInfo.source]
        this.availableQualitys = sourceInfo?.actions.includes('musicUrl') ? [...sourceInfo.qualitys] : []
        this.sourceState = this.qualitys.length ? 'ready' : 'unsupported'
      } catch {
        if (!this.show || token != this.sourceRequestToken ||
          primaryId != appSetting['common.apiSource'] ||
          musicKey != `${this.musicInfo?.source}:${this.musicInfo?.id}`) return
        this.sourceState = 'failed'
      }
    },
    handleClick(quality) {
      void createDownloadTasks([this.musicInfo], quality, this.listId)
      this.handleClose()
    },
    handleClose() {
      this.$emit('update:show', false)
    },
    getTypeName(quality) {
      switch (quality) {
        case 'flac24bit':
          return this.$t('download__lossless') + ' FLAC Hires'
        case 'flac':
        case 'ape':
        case 'wav':
          return this.$t('download__lossless') + ' ' + quality.toUpperCase()
        case '320k':
          return this.$t('download__high_quality') + ' ' + quality.toUpperCase()
        case '192k':
        case '128k':
          return this.$t('download__normal') + ' ' + quality.toUpperCase()
      }
    },
    checkSource(quality) {
      return this.sourceQualityList.includes(quality)
    },
  },
}
</script>


<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.main {
  padding: 15px;
  max-width: 400px;
  min-width: 200px;
  display: flex;
  flex-flow: column nowrap;
  justify-content: center;
  h2 {
    font-size: 13px;
    color: var(--color-font);
    line-height: 1.3;
    text-align: center;
    margin-bottom: 15px;
  }
}

.btn {
  display: block;
  margin-bottom: 15px;
  &:last-child {
    margin-bottom: 0;
  }
}

.status {
  color: var(--color-font-label);
  font-size: 12px;
  line-height: 1.5;
  padding: 4px 0;
  text-align: center;
}

</style>
