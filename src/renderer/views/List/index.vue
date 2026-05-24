<template>
  <div id="my-list" :class="$style.container" @click="handleContainerClick">
    <MyList ref="myList" :list-id="listId" @show-menu="$refs.musicList.handleMenuClick()" />
    <MusicList ref="musicList" :list-id="listId" @show-menu="$refs.myList.handleMenuClick()" />
  </div>
</template>

<script>
import { getListPrevSelectId } from '@renderer/utils/data'
import { LIST_IDS } from '@common/constants'

import MyList from './MyList/index.vue'
import MusicList from './MusicList/index.vue'

export default {
  name: 'List',
  components: {
    MyList,
    MusicList,
  },
  async beforeRouteEnter(to, from, next) {
    let id = to.query.id
    if (!id || id == LIST_IDS.DEFAULT || id == LIST_IDS.WEBDAV) {
      id = await getListPrevSelectId()
      if (!id || id == LIST_IDS.DEFAULT || id == LIST_IDS.WEBDAV) id = LIST_IDS.LOVE
      next({
        path: to.path,
        query: { ...to.query, id },
      })
    } else next()
  },
  beforeRouteUpdate(to, from) {
    // console.log(to, from)
    if (to.query.updated) return
    let id = to.query.id
    if (id == null) return
    if (id == LIST_IDS.DEFAULT || id == LIST_IDS.WEBDAV) id = LIST_IDS.LOVE
    // if (!getList(id)) {
    //   id = defaultList.id
    // }
    this.listId = id
    const scrollIndex = to.query.scrollIndex
    const isAnimation = from.query.id == to.query.id
    this.$refs.musicList?.handleRestoreScroll(scrollIndex, isAnimation)

    return {
      path: '/list',
      query: { id, updated: true },
    }
  },
  beforeRouteLeave(to, from) {
    this.$refs.musicList?.saveListPosition()
  },
  data() {
    return {
      listId: null,
    }
  },
  created() {
    const id = this.$route.query.id
    this.listId = id == LIST_IDS.DEFAULT || id == LIST_IDS.WEBDAV ? LIST_IDS.LOVE : id
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.container {
  overflow: hidden;
  height: 100%;
  display: flex;
  position: relative;
}

</style>
