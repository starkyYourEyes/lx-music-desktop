/* eslint-disable @typescript-eslint/no-var-requires */
// import Vue from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { watch } from 'vue'
import { appSetting } from '@renderer/store/setting'
import { getFeatureForPath, isFeatureEnabled } from '@common/performance/featurePolicy'
import { loadRecommendationPage, noteFeaturePageLoaded } from '@renderer/core/features/recommendations'


const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/feature-disabled', component: async() => import('./views/FeatureDisabled.vue') },
    {
      path: '/search',
      name: 'Search',
      component: async() => import('./views/Search/index.vue'),
      meta: {
        name: 'Search',
      },
    },
    {
      path: '/recommend',
      name: 'Recommend',
      component: () => loadRecommendationPage('neteaseRecommend'),
      meta: {
        name: 'Recommend',
      },
    },
    {
      path: '/qq-recommend',
      name: 'QQRecommend',
      component: () => loadRecommendationPage('qqRecommend'),
      meta: {
        name: 'QQRecommend',
      },
    },
    {
      path: '/kg-recommend',
      name: 'KugouRecommend',
      component: () => loadRecommendationPage('kugouRecommend'),
      meta: {
        name: 'KugouRecommend',
      },
    },
    {
      path: '/recent-play',
      name: 'RecentPlay',
      component: async() => import('./views/RecentPlay/index.vue'),
      meta: {
        name: 'RecentPlay',
      },
    },
    {
      path: '/cloud-disk',
      name: 'CloudDisk',
      component: async() => import('./views/CloudDisk/index.vue'),
      meta: {
        name: 'CloudDisk',
      },
    },
    {
      path: '/local-music',
      name: 'LocalMusic',
      component: async() => import('./views/LocalMusic/index.vue'),
      meta: {
        name: 'LocalMusic',
      },
    },
    {
      path: '/songList/list',
      name: 'SongList',
      component: async() => import('./views/songList/List/index.vue'),
      meta: {
        name: 'SongList',
      },
    },
    {
      path: '/songList/detail',
      name: 'SongListDetail',
      component: async() => import('./views/songList/Detail/index.vue'),
      meta: {
        name: 'SongList',
      },
    },
    {
      path: '/leaderboard',
      name: 'Leaderboard',
      component: async() => import('./views/Leaderboard/index.vue'),
      meta: {
        name: 'Leaderboard',
      },
    },
    {
      path: '/list',
      name: 'List',
      component: async() => import('./views/List/index.vue'),
      meta: {
        name: 'List',
      },
    },
    {
      path: '/download',
      name: 'Download',
      component: async() => import('./views/Download/index.vue'),
      meta: {
        name: 'Download',
      },
    },
    {
      path: '/setting',
      name: 'Setting',
      component: async() => import('./views/Setting/index.vue'),
      meta: {
        name: 'Setting',
      },
    },
    { path: '/:pathMatch(.*)*', redirect: '/search' },
  ],
  linkActiveClass: 'active-link',
  linkExactActiveClass: 'exact-active-link',
})


const guardFeatureRoute = (to: { path: string }) => {
  const feature = getFeatureForPath(to.path)
  if (feature && !isFeatureEnabled(appSetting, feature)) return { path: '/feature-disabled', query: { feature } }
}
router.beforeEach(guardFeatureRoute)
router.beforeResolve(guardFeatureRoute)
router.afterEach((to, _from, failure) => {
  if (failure) return
  const feature = getFeatureForPath(to.path)
  noteFeaturePageLoaded(feature)
})
watch(() => {
  const feature = getFeatureForPath(router.currentRoute.value.path)
  return feature && !isFeatureEnabled(appSetting, feature) ? feature : null
}, feature => {
  if (feature) void router.replace({ path: '/feature-disabled', query: { feature } })
})

export default router
