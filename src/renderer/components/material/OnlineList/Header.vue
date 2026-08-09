<template>
  <div class="thead">
    <table>
      <thead>
        <tr v-if="actionButtonsVisible">
          <th class="num" style="width: 5%;">#</th>
          <th class="nobreak"><span :style="{ marginLeft: `${artworkSize + 10}px` }">{{ $t('music_title') }}</span></th>
          <th class="nobreak" style="width: 22%;">{{ $t('music_album') }}</th>
          <th class="nobreak" style="width: 9%;">{{ $t('music_time') }}</th>
          <th class="nobreak" style="width: 16%;">{{ $t('action') }}</th>
        </tr>
        <tr v-else>
          <th class="num" style="width: 5%;">#</th>
          <th class="nobreak"><span :style="{ marginLeft: `${artworkSize + 10}px` }">{{ $t('music_title') }}</span></th>
          <th class="nobreak" style="width: 27%;">{{ $t('music_album') }}</th>
          <th class="nobreak" style="width: 10%;">{{ $t('music_time') }}</th>
        </tr>
      </thead>
    </table>
  </div>
</template>

<script>
export default {
  name: 'OnlineListHeader',
  props: {
    actionButtonsVisible: {
      type: Boolean,
      default: false,
    },
    artworkSize: {
      type: Number,
      required: true,
    },
  },
}
</script>
