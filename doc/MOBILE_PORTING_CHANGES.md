# 本次桌面版定制改动汇总与移动版迁移文档

本文档统计本轮对 `lx-music-desktop` 原始项目所做的主要改动，基准参考当前仓库中的上游桌面版标签 `v2.12.1`，当前定制版为 `v3.0.0`。  
用途是把这些功能迁移到 `lx-music-mobile` 时，作为功能清单、接口清单、数据结构清单和 TODO 清单使用。

> 说明：文档中的 “WY” 指本轮集成的非官方音乐平台 API。README 中已经按要求避免直接写平台全称，本文档也沿用 WY。

## 一、整体改动范围

### 1. 版本与构建

- 项目版本从桌面原版 `2.12.1` 定制为 `3.0.0`。
- 新增了 Windows 便携版与绿色压缩包构建脚本：
  - `npm run pack:win:portable:x64`
  - `npm run pack:win:7z:x64`
- 打包时需要把 `@neteasecloudmusicapienhanced/api` 作为运行时依赖带入产物。
- Windows 绿色包 release 上传使用的是 `build/lx-music-desktop-v3.0.0-win_x64-green.7z`。

关键文件：

- `package.json`
- `package-lock.json`
- `build-config/build-pack.js`
- `build-config/build-before-pack.js`
- `build-config/main/webpack.config.base.js`

移动端迁移建议：

- 移动端无需照搬 Electron 打包脚本。
- 需要关注的是依赖替换：桌面版已从旧包 `NeteaseCloudMusicApi` 切换到 `@neteasecloudmusicapienhanced/api`。
- 移动端如果不能直接运行 Node 版 API 包，建议把 WY API 能力放在后端代理服务，移动端只调用自建 HTTP 接口。

### 2. 新增/修改规模

相对上游 `v2.12.1`，本轮定制涉及约 153 个文件，核心新增/修改集中在：

- WY 登录、推荐、歌单详情、私人 FM、收藏同步。
- 推荐页面完整重构并拆分组件。
- 播放栏重构、播放队列面板、私人 FM 减少推荐按钮。
- 我的列表 UI、歌单详情 UI、歌单资料编辑弹窗。
- 最近播放、我的云盘侧边栏入口。
- 桌面歌词单行/双行自适应高度、上下 padding、翻译行间距、置顶与任务栏上方相关逻辑。
- Windows 托盘右键菜单自定义 HTML 窗口。
- 设置页样式优化、新增推荐设置、听歌时间、列表缩放、桌面歌词间距。
- 删除/隐藏设置页中的软件更新模块和启动更新日志。

## 二、依赖与 API 包变化

### 1. API 包替换

当前使用：

```json
"@neteasecloudmusicapienhanced/api": "^4.33.0"
```

原先调研过旧包 `NeteaseCloudMusicApi`，最终改为 enhanced 包，并按用户要求不再直接修改新安装包源码。

关键文件：

- `package.json`
- `package-lock.json`
- `src/main/modules/netease.ts`
- `build-config/main/webpack.config.base.js`
- `build-config/build-pack.js`

实现要点：

- `src/main/modules/netease.ts` 中通过 CommonJS 动态 `require('@neteasecloudmusicapienhanced/api')` 加载 API 包。
- webpack 主进程配置中把该包配置为 external，避免被打进主进程 bundle 后动态模块加载失败。
- electron-builder 打包配置中显式把该包相关文件带入安装包/便携包。

移动端迁移建议：

- 移动端不要直接依赖 Electron 主进程模式。
- 如果移动端项目基于 React Native/uni-app/Flutter 等，通常无法直接运行 Node API 包，应改为：
  - 方案 A：移动端请求一个本地/云端代理服务，代理服务使用 `@neteasecloudmusicapienhanced/api`。
  - 方案 B：把已确认的底层 HTTP 接口在移动端单独实现请求签名和 cookie 管理。
- 更建议方案 A，迁移成本低，也更容易维护登录 cookie。

## 三、WY 主进程 API 聚合层

### 1. 新增 WY 主模块

新增文件：

- `src/main/modules/netease.ts`
- `src/main/modules/neteasePlaylist.ts`
- `src/main/modules/winMain/rendererEvent/netease.ts`
- `src/common/types/netease.d.ts`

核心职责：

- 保存和刷新登录状态。
- 创建/轮询二维码登录。
- 调用每日推荐、私人 FM、首页推荐、雷达歌单、推荐歌单、榜单、歌单详情等接口。
- 把 WY 返回的数据转换为 LX 项目内部的 `LX.Music.MusicInfoOnline`、`LX.Netease.Playlist` 等结构。
- 收藏同步：把 WY 歌曲同步添加到 WY “我喜欢”。
- 私人 FM 减少推荐：调用 `/fm_trash`。
- 可选获取 WY 歌曲 URL，但播放最终主要走项目内部音源匹配。

### 2. 已封装的主要方法

`src/main/modules/netease.ts` 中主要导出：

- `getAccountStatus()`
  - 读取本地保存的 WY cookie/profile。
  - 5 分钟内有 profile 时避免频繁请求登录状态。
  - 过期后调用登录状态接口刷新。
- `createLoginQr()`
  - 调用二维码 key 与二维码生成接口。
- `checkLoginQr(key)`
  - 轮询二维码状态。
  - 状态码 `803` 表示扫码授权成功。
  - 成功后保存 cookie/profile。
- `logout()`
  - 调用登出接口并清空本地账号信息。
- `getRecommendSongs()`
  - 调用 `/recommend/songs`。
  - 获取登录用户每日推荐歌曲。
- `getPrivateFmSongs(params)`
  - 默认调用私人 FM。
  - 支持私人 FM 模式：
    - `DEFAULT`
    - `FAMILIAR`
    - `EXPLORE`
    - `EXERCISE`
    - `FOCUS`
    - `NIGHT_EMO`
- `getDailySongCategories()`
  - 调用 `/api/homepage/daily/song/config/get`。
  - 获取“风格日推”可选分类与 tag。
- `getRecommendPlaylistDetail(id, page)`
  - WY 歌单详情。
  - 兼容“风格日推”虚拟歌单 id。
  - 会按 trackIds 补齐歌曲详情。
- `getRecommendPlaylists(limit, removePrivateRecommend)`
  - 登录时混合每日推荐歌单与公开推荐歌单。
  - 未登录时使用公开推荐歌单。
- `getHomeRecommendation(params)`
  - 推荐页聚合入口。
  - 可按 section 局部请求。
- `likeMusic(musicInfo)`
  - 对 WY 歌曲调用喜欢接口。
- `trashPrivateFmMusic({ musicInfo, time })`
  - 调用 `/fm_trash` 减少私人 FM 当前歌曲的类型推荐。
- `getMusicUrl(musicInfo, quality)`
  - 调用 WY song url v1。
  - 目前按需求不作为推荐页歌曲的优先播放源。

### 3. IPC 名称

新增 IPC 常量位于 `src/common/ipcNames.ts`：

- `netease_get_account_status`
- `netease_login_qr_create`
- `netease_login_qr_check`
- `netease_logout`
- `netease_get_recommend_songs`
- `netease_get_private_fm`
- `netease_get_recommend_playlists`
- `netease_get_home_recommendation`
- `netease_get_daily_song_categories`
- `netease_get_playlist_detail`
- `netease_get_music_url`
- `netease_like_music`
- `netease_trash_private_fm_music`

渲染进程封装位于 `src/renderer/utils/ipc.ts`：

- `getNeteaseAccountStatus()`
- `createNeteaseLoginQr()`
- `checkNeteaseLoginQr(key)`
- `logoutNetease()`
- `getNeteaseRecommendSongs()`
- `getNeteasePrivateFm(params)`
- `getNeteaseRecommendPlaylists(limit, removePrivateRecommend)`
- `getNeteaseHomeRecommendation(params)`
- `getNeteaseDailySongCategories()`
- `getNeteasePlaylistDetail(id, page)`
- `getNeteaseMusicUrl(musicInfo, quality)`
- `likeNeteaseMusic(musicInfo)`
- `trashNeteasePrivateFmMusic(musicInfo, time)`

移动端迁移建议：

- 把这些 IPC 方法视作移动端要实现的 service API。
- 移动端可以建立类似 `services/wy.ts`：
  - `getAccountStatus`
  - `createLoginQr`
  - `checkLoginQr`
  - `logout`
  - `getHomeRecommendation`
  - `getPlaylistDetail`
  - `likeMusic`
  - `trashPrivateFmMusic`
- 如果使用后端代理，移动端 service 只负责请求后端，不直接接触 enhanced API 包。

## 四、WY 登录与账号 UI

### 1. 登录状态存储

新增数据 key：

- `DATA_KEYS.neteaseAccount`

保存内容：

```ts
interface NeteaseAccountData {
  cookie: string
  profile: LX.Netease.Profile | null
  updatedAt: number
}
```

关键文件：

- `src/common/constants.ts`
- `src/main/modules/netease.ts`
- `src/renderer/store/netease.ts`

`src/renderer/store/netease.ts` 提供：

- `accountStatus`
- `isInitingNeteaseAccount`
- `isNeteaseAccountInited`
- `profile`
- `isLoggedIn`
- `setNeteaseAccountStatus`
- `initNeteaseAccount(force)`
- `logoutNeteaseAccount`

### 2. 左上角头像替换 LX logo

改动位置：

- `src/renderer/components/layout/Aside/index.vue`

行为：

- 未登录时显示 `L X`。
- 登录后显示用户头像。
- 点击头像/logo 弹出账号操作浮层。
- 浮层中显示昵称和“登录/退出登录”按钮。
- 点击登录会跳转推荐页并打开二维码登录弹窗。
- 去掉了推荐页右上角独立的退出登录按钮。

移动端迁移建议：

- 移动端可把账号入口放在：
  - 推荐页顶部头像；
  - 我的页面顶部头像；
  - 侧边抽屉头像。
- 桌面版的头像弹窗可以迁移为移动端 bottom sheet 或普通 modal。
- QR 登录在移动端可能不一定是最佳方案，如果移动端设备就是扫码设备，需要额外设计：
  - 复制登录链接；
  - 跳转浏览器；
  - 手机号/验证码登录；
  - 或仍保留二维码用于另一台设备扫码。

## 五、推荐页面重构

### 1. 页面整体

推荐页新增并多次重构，当前已拆分为多个文件：

- `src/renderer/views/Recommend/index.vue`
- `src/renderer/views/Recommend/constants.ts`
- `src/renderer/views/Recommend/types.ts`
- `src/renderer/views/Recommend/utils.ts`
- `src/renderer/views/Recommend/useNeteaseLoginQr.ts`
- `src/renderer/views/Recommend/useRecommendCards.ts`
- `src/renderer/views/Recommend/useRecommendData.ts`
- `src/renderer/views/Recommend/useRecommendLove.ts`
- `src/renderer/views/Recommend/useRecommendPlayback.ts`
- `src/renderer/views/Recommend/components/LoginPanel.vue`
- `src/renderer/views/Recommend/components/SpecialCards.vue`
- `src/renderer/views/Recommend/components/HorizontalPlaylistSection.vue`
- `src/renderer/views/Recommend/components/SimilarSongsSection.vue`
- `src/renderer/views/Recommend/components/ChartsSection.vue`
- `src/renderer/views/Recommend/components/ExplorePlaylistGrid.vue`
- `src/renderer/views/Recommend/components/CoverPlayButton.vue`
- `src/renderer/views/Recommend/components/SectionRefreshButton.vue`

当前推荐页结构：

1. 第一行特殊卡片：
   - 每日推荐。
   - 私人 FM。
   - 私人雷达。
   - 曾经有第四个占位，后来删除。
2. 雷达歌单。
3. 多元旋律/风格歌曲推荐。
4. 风格日推。
5. 红心相似歌曲。
6. 推荐歌单。
7. 榜单精选。

用户可以在设置中调整部分 section 的顺序。

### 2. 推荐页刷新策略

当前策略：

- 软件启动或首次进入时加载推荐页内容。
- 之后从歌单详情返回推荐页时，不重新刷新整个页面。
- 每个模块可以通过局部刷新按钮刷新。
- 推荐页滚动位置会保存和恢复，避免返回后跳到顶部。

关键实现：

- `src/renderer/views/Recommend/useRecommendData.ts`
  - `recommendPlaylistCache`
  - `homeRecommendationCache`
  - `recommendScrollCache`
  - `saveScrollPosition()`
  - `restoreScrollPosition()`
  - `loadRecommendPlaylists(forceRefresh)`
- `src/renderer/views/Recommend/index.vue`
  - `onBeforeRouteLeave()` 保存滚动位置。
  - 登录状态 watcher 避免无变化时强制刷新。

移动端迁移建议：

- 推荐页要做页面级缓存，否则移动端从歌单详情返回时体验会很差。
- 建议用移动端路由的 `keepAlive` 或全局 store 缓存。
- 保留局部刷新，不要每次切 tab/返回都重新打接口。

### 3. 推荐页聚合接口

主入口：

- 渲染层：`getNeteaseHomeRecommendation(params)`
- 主进程：`getHomeRecommendation(params)`

内部按 section 调用不同底层接口。

主要 section：

- `radarPlaylists`
- `styleSongs`
- `dailySongCategories`
- `similarSongs`
- `recommendPlaylists`
- `charts`

section 常量：

- `src/common/constants.ts`
- `src/common/types/app_setting.d.ts`

### 4. 第一行特殊卡片

实现文件：

- `src/renderer/views/Recommend/components/SpecialCards.vue`
- `src/renderer/views/Recommend/useRecommendCards.ts`
- `src/renderer/views/Recommend/useRecommendPlayback.ts`
- `src/renderer/store/dailyRecommend/action.ts`
- `src/renderer/store/privateFm/action.ts`

每日推荐：

- 调用 `/recommend/songs`。
- 卡片封面使用第一首歌封面。
- 点击封面播放按钮直接播放每日推荐临时列表。
- 点击卡片其他区域进入歌单详情页。

私人 FM：

- 调用私人 FM 接口。
- 卡片文案：`从《第一首歌名》开始漫游`。
- 封面使用第一首私人 FM 歌曲封面。
- 播放/暂停按钮放在封面右下角且背景透明。
- 点击暂停后再次点击播放保持同一首歌和播放进度，不刷新队列。
- 切换到其他歌单播放才退出私人 FM 模式。

私人雷达：

- 使用用户登录后的真实私人雷达。
- 删除了“我的歌单”中未登录状态的私人雷达。
- 当前固定关注过特殊歌单 id，例如 `3136952023`。
- 第一行第三个卡片的播放按钮可直接播放，点击其他区域进入详情。

移动端迁移建议：

- 第一行适合做横向滑动卡片或 3 个大卡片。
- 私人 FM 在移动端建议进入独立播放模式页，而不是只依赖底部栏状态。
- 每日推荐和私人雷达要区分“卡片点击打开详情”和“播放按钮点击直接播放”。

### 5. 雷达歌单

当前实现：

- 推荐页第二行“雷达歌单”。
- 数据来自 `/api/batch` 包装请求，其中包含 `/api/pc/customize/block/page`。
- 目标 showType：`PC_CUSTOMIZE_PLAYLIST_SLIDE_PAPE`。
- 用户抓包里这一块可返回约 10 个歌单。
- 页面要全部展示在一行，通过左右按钮一次移动一个歌单。

UI 行为：

- 去掉底部滚动条。
- 鼠标悬停整行时显示左右滑动按钮。
- 如果左/右没有更多歌单，对应按钮虚化。
- 左右按钮只保留方向符号风格，无背景色。
- 左按钮不放在歌单上方，而是放在歌单区域左侧，与封面中心对齐。
- 右按钮向右留出更多空间，避免贴着封面。
- 所有歌单封面悬停显示播放/暂停按钮。
- 点击歌单进入歌单详情。

移动端迁移建议：

- 移动端可直接用横向 FlatList/ScrollView。
- 左右箭头在移动端不必要，可以用滑动和分页指示器。
- 需要保留封面中心播放按钮或卡片长按/右上角播放按钮。

### 6. 多元旋律/推荐歌曲 section

当前实现：

- 位于雷达歌单下方、红心相似歌曲上方。
- 标题来自接口返回的 `subTitle.title`，例如 `循环不止的「宝藏佳作」`。
- 每首歌展示歌曲名、歌手、封面、右侧收藏按钮。
- 标题右侧有播放按钮，可把整个 section 歌曲加入临时列表并播放。
- 最右侧有刷新按钮。
- 后续修正过：这里需要展示 `subTitle.title`，不要误展示 `mainTitle.title` 作为标签。

关键文件：

- `src/renderer/views/Recommend/components/SimilarSongsSection.vue`
- `src/main/modules/netease.ts`

移动端迁移建议：

- 可以复用“歌曲横向/纵向列表组件”。
- 歌曲标签应该显示 subtitle，而不是歌曲名。
- 播放全部按钮建议放在标题右侧。

### 7. 红心相似歌曲

接口来源：

- `/api/batch` 包装请求中包含 `/api/homepage/block/page`。
- block code：`HOMEPAGE_BLOCK_RED_SIMILAR_SONG`。

UI 行为：

- 去掉歌曲前面的序号。
- 歌曲右侧图标是收藏按钮，已放大并与歌曲垂直对齐。
- 标题右侧有播放按钮，可播放本 section 临时列表。
- section 最右侧有刷新按钮。
- 点击歌曲可播放。
- 收藏状态与底部播放栏爱心逻辑保持一致。

曾修复的问题：

- 红心相似歌曲一度出现“歌曲名和封面不对应”问题，原因是解析资源时把部分歌曲字段关联错位。
- 当前要求 song、cover、subtitle 都来自同一个资源项，不能用数组 index 交叉拼接。

移动端迁移建议：

- 注意资源解析必须以单个 item 为单位归一化。
- 如果接口返回里 song 和 uiElement 分离，要建立明确的 resourceId/songId 映射。

### 8. 风格日推

新增 section：

- 标题：风格日推。
- 位置默认在红心相似歌曲上方。
- 如果用户未选择任何 tag，则隐藏。
- 默认展示第一个 category 的前 6 个 tag 对应的歌单。
- 用户可在设置中选择 tag，并调整展示顺序。

相关接口：

- `/api/homepage/daily/song/config/get`
  - 获取所有 categoryName 和 tagName。
- `/api/pc/daily/rcmd/block`
  - 获取 daily song category 需要的 seed song 信息。
- `/api/homepage/category/daily/song/list`
  - 根据 categoryId、tagId、songId 获取对应风格日推歌曲。
- `/api/homepage/daily/song/tag/save`
  - 作为 fallback，保存 tag 后再请求默认 daily song list。

关键文件：

- `src/common/utils/neteaseDailySongCategory.ts`
- `src/main/modules/netease.ts`
- `src/renderer/views/Setting/components/SettingRecommend.vue`
- `src/renderer/views/Recommend/useRecommendData.ts`

虚拟歌单 id：

- 通过 `getDailySongCategoryPlaylistId(categoryId, tagId)` 生成。
- 进入详情时通过 `parseDailySongCategoryPlaylistId(id)` 判断是否为风格日推虚拟歌单。

已知注意点：

- 不能简单调用 WY 首页接口拿到固定几个推荐歌单，否则不同 tag 会展示相同内容。
- 必须根据用户选择的 tag 逐个请求对应歌曲，再把歌曲集合包装成一个虚拟歌单。
- 风格日推封面取对应 tag 歌曲列表第一首歌的封面。
- 风格日推详情页应展示该 tag 对应的歌曲，不应展示普通推荐歌单详情。

移动端迁移建议：

- 建议把“tag 设置”和“tag 歌单生成”拆开：
  - `getDailySongCategories()`
  - `saveSelectedDailySongTagKeys(keys)`
  - `getDailySongCategoryPlaylist(tag)`
  - `getDailySongCategoryPlaylistDetail(id)`
- 移动端设置页需要支持 tag 多选和排序。

### 9. 推荐歌单

当前推荐歌单 section：

- 已改为通过 `/api/batch` 包装请求。
- `/api/batch` 中包含 `/api/homepage/block/page`。
- block code：`HOMEPAGE_BLOCK_PLAYLIST_RCMD`。

UI 行为：

- 所有解析到的歌单都展示在一行。
- 去掉横向滚动条。
- 鼠标悬停显示左右浏览按钮。
- 左右按钮每次移动一个歌单。
- 每个歌单悬停显示封面中心播放/暂停按钮。
- section 右上角有刷新按钮。

移动端迁移建议：

- 可迁移成横向歌单 carousel。
- 桌面左右按钮在移动端可删除，直接滑动。
- 注意 section 局部刷新，不要刷新整个推荐页。

### 10. 榜单精选

当前展示：

- 飙升榜。
- 热歌榜。
- 黑胶 VIP 热歌榜。
- 黑胶 VIP 爱听榜。
- 歌曲畅销指数榜等。

相关接口：

- `toplist_detail`
- `album_songsaleboard`
- 普通榜单通过歌单详情补齐歌曲预览和封面。

UI 行为：

- 封面与右侧文字留间距。
- 文字限制在卡片内部，不允许溢出。

移动端迁移建议：

- 移动端适合做两列榜单卡片或横向榜单行。

### 11. 推荐页面“查看全部”

当前支持：

- 点击查看全部进入更多推荐。
- 更多推荐展示更多歌单和封面。
- 此前参考过 YesPlayMusic 的“查看全部”体验。

路由：

- `/recommend?category=playlists`

移动端迁移建议：

- 可单独实现“更多推荐”页面。
- 注意路由返回时恢复推荐主页滚动位置。

## 六、推荐页播放逻辑

### 1. 推荐页歌曲播放策略

需求多次调整后，当前原则：

- 推荐页里的 WY 歌曲不优先使用 WY 的 `song_url_v1` 播放。
- 播放时优先走 LX 项目内部已配置音源。
- 如果 WY 歌曲无法直接播放，则根据歌曲名/歌手等信息在项目内部源自动搜索匹配可播放歌曲。
- WY API 获取到的歌曲主要作为“推荐数据”和“元数据来源”。

关键文件：

- `src/renderer/core/player/action.ts`

关键逻辑：

- `findBestProjectSourceMusic(musicInfo)`
  - 仅对 `source == 'wy'` 的歌曲启用。
  - 用歌曲名、歌手、时长等信息走项目内部搜索。
  - 找到非 WY 且当前源支持的歌曲后，用该歌曲播放。
- 播放错误时，WY 歌曲允许 fallback 到项目内部源。
- 非 WY 歌曲保留原项目的换源/播放逻辑。

移动端迁移建议：

- 移动端若已经有 LX 原有音源体系，应复用同样策略：
  - 推荐数据来自 WY。
  - 实际音频 URL 来自 LX 当前配置的源。
- 推荐页播放前应做“推荐歌曲 -> 可播放歌曲”的匹配。
- 建议增加匹配失败 UI：
  - “未找到可播放音源”
  - “手动搜索”
  - “换源重试”

### 2. 歌单播放

当前支持：

- 推荐歌单点击进入详情后可播放。
- 双击歌曲播放。
- 推荐页卡片播放按钮直接播放整个歌单/section。
- 第一行每日推荐、私人雷达的封面播放按钮直接播放对应歌单，点击其他区域进入详情。
- 私人 FM 进入 FM 模式，不使用普通播放队列展示。

关键文件：

- `src/renderer/views/Recommend/useRecommendPlayback.ts`
- `src/renderer/components/material/OnlineList/usePlay.ts`
- `src/renderer/components/material/OnlineList/index.vue`
- `src/renderer/store/songList/action.ts`
- `src/renderer/store/dailyRecommend/action.ts`
- `src/renderer/store/privateFm/action.ts`

移动端迁移建议：

- 歌单详情页和推荐页列表都要支持双击等桌面操作的移动端等价行为：
  - 单击播放按钮；
  - 点击歌曲行播放；
  - 长按弹出菜单。
- 私人 FM 要和普通歌单播放状态隔离。

## 七、私人 FM 模式

### 1. 数据与状态

新增 store：

- `src/renderer/store/privateFm/state.ts`
- `src/renderer/store/privateFm/action.ts`

核心状态：

- `privateFmQueue`
- `isPrivateFmMode`
- `privateFmModeId`
- `isLoadingPrivateFm`
- `privateFmError`

核心方法：

- `loadPrivateFmSongs(mode, limit)`
- `refreshPrivateFmQueue(mode)`
- `preparePrivateFmQueue(forceRefresh, mode)`
- `appendPrivateFmQueue()`
- `syncPrivateFmTempList()`
- `setPrivateFmMode(mode)`
- `enterPrivateFmMode(startIndex)`
- `playPrivateFmSong(musicInfo)`
- `exitPrivateFmMode()`
- `syncPrivateFmModeWithPlayer()`
- `ensurePrivateFmNextSongs()`

### 2. 队列策略

当前策略：

- 私人 FM 使用内部队列，但 UI 上不展示普通播放队列。
- 队列剩余不足时自动 append 新歌曲。
- 退出私人 FM 时调用 `refreshPrivateFmQueue()`，并更新推荐页私人 FM 信息。
- 暂停/继续私人 FM 不算退出，不刷新歌曲、不重置播放进度。
- 只有切换到其他歌单播放才退出 FM 模式。

### 3. 私人 FM 模式图标

播放栏中：

- 普通模式下，上一首按钮左侧是播放模式切换按钮。
- 私人 FM 模式下，切换为“漫游模式”按钮。
- 图标曾改为旋转 90 度的 8 形符号，并做了对齐和尺寸调整。

关键文件：

- `src/renderer/components/common/PrivateFmModeBtn.vue`
- `src/renderer/components/common/TogglePlayModeBtn.vue`
- `src/renderer/components/layout/PlayBar/ControlBtns.vue`

### 4. 减少推荐

私人 FM 模式下：

- 底部播放栏下一首右边原本的播放队列按钮，改为“减少推荐”按钮。
- 点击后调用 `/fm_trash`，然后播放下一首。
- 退出私人 FM 模式后恢复为播放队列按钮。

关键文件：

- `src/renderer/components/layout/PlayBar/ModernBar.vue`
- `src/main/modules/netease.ts`
- `src/renderer/utils/ipc.ts`

移动端迁移建议：

- 移动端建议在播放页或迷你播放栏提供“不感兴趣/减少推荐”按钮。
- FM 模式和普通队列模式需要有明显状态标识。
- FM 模式下“上一首”是否可用要根据业务决定，当前桌面版保留原有控制布局。

## 八、收藏同步与我的收藏

### 1. 添加到我的收藏同步 WY 喜欢

当前行为：

- 点击添加到列表时，与其他歌单一样弹出“添加到哪一个歌单”的选择弹窗。
- 如果选择“我的收藏”，且歌曲来源是 WY，则自动同步添加到 WY 的“我喜欢”。
- 底部播放栏左侧的爱心按钮仅表示添加/取消本地“我的收藏”。
- 取消收藏时不会切换歌曲，保持当前播放。
- 爱心图标空心/实心状态表示是否已收藏。

关键文件：

- `src/renderer/store/list/action.ts`
- `src/renderer/views/Recommend/useRecommendLove.ts`
- `src/renderer/components/layout/PlayBar/ModernBar.vue`
- `src/renderer/components/layout/PlayBar/ControlBtns.vue`

核心方法：

- `syncNeteaseLikedMusics(musicInfos)`
- `addListMusics(id, musicInfos, addMusicLocationType, options)`
  - 当 `id == LIST_IDS.LOVE` 且未跳过同步时，调用 `likeNeteaseMusic()`。

移动端迁移建议：

- 移动端也应在本地收藏和 WY 喜欢之间建立同步策略。
- 当前仅重点实现“添加收藏 -> WY 喜欢”。
- TODO：取消收藏时是否同步取消 WY 喜欢仍需确认。

## 九、播放栏重构

### 1. 新样式播放栏

新增文件：

- `src/renderer/components/layout/PlayBar/ModernBar.vue`

改动目标：

- 左侧：
  - 歌曲封面。
  - 歌名/歌手两行显示。
  - 歌手颜色更浅。
  - 收藏到我的收藏按钮靠近歌名/歌手。
- 中间：
  - 播放模式/私人 FM 模式按钮。
  - 上一首、播放/暂停、下一首按钮保留原项目样式。
  - 播放队列按钮；私人 FM 模式下替换为减少推荐。
- 右侧：
  - 进度展示。
  - 一起听入口。
  - 添加到歌单、歌词显示/隐藏、音量等其他控制。

涉及文件：

- `src/renderer/components/layout/PlayBar/ModernBar.vue`
- `src/renderer/components/layout/PlayBar/ControlBtns.vue`
- `src/renderer/components/layout/PlayBar/FullWidthProgress.vue`
- `src/renderer/components/layout/PlayBar/MiddleWidthProgress.vue`
- `src/renderer/components/layout/PlayBar/MiniWidthProgress.vue`
- `src/renderer/components/common/VolumeBtn.vue`
- `src/renderer/components/common/TogglePlayModeBtn.vue`
- `src/renderer/components/common/PrivateFmModeBtn.vue`

### 2. 播放队列浮层

新增文件：

- `src/renderer/components/layout/PlayQueue.vue`

行为：

- 点击底部播放栏的播放列表 icon，在右下角显示当前播放队列。
- 队列分为：
  - 当前播放。
  - 稍后播放。
  - 后续待播放。
- 点击队列项可切换播放。
- 私人 FM 模式下隐藏普通播放队列按钮。

移动端迁移建议：

- 移动端应迁移为播放页中的“播放队列 bottom sheet”。
- 队列数据来源同样是当前播放列表、临时播放列表、稍后播放。

## 十、侧边栏与路由

### 1. 侧边栏按钮调整

当前左侧侧边栏：

- 推荐。
- 我的列表。
- 我的云盘。
- 最近播放。
- 下载。
- 设置在最底部。

删除/隐藏：

- 搜索。
- 歌单。
- 排行榜。

关键文件：

- `src/renderer/components/layout/Aside/NavBar.vue`
- `src/renderer/components/layout/Aside/index.vue`
- `src/renderer/components/layout/Icons.vue`
- `src/renderer/router.ts`

UI 调整：

- 左侧侧边栏整体增大过，图标也同步增大。
- 后续修正了最近播放 icon 与其他 icon 大小不匹配问题。
- 推荐 icon 与其他 icon 之间增加分隔线。
- 设置 icon 固定在侧边栏底部。
- 搜索栏左侧增加返回上一级按钮 `<`。

移动端迁移建议：

- 移动端一般不使用桌面侧边栏，可迁移为底部 tab：
  - 推荐
  - 我的
  - 云盘
  - 最近
  - 设置
- 搜索可作为顶部搜索框或独立搜索页入口。

### 2. 新增路由

新增/调整：

- `/recommend`
- `/recent-play`
- `/cloud-disk`

关键文件：

- `src/renderer/router.ts`

## 十一、最近播放

新增文件：

- `src/renderer/views/RecentPlay/index.vue`
- `src/renderer/store/recentPlay/action.ts`
- `src/renderer/store/recentPlay/state.ts`

行为：

- 左侧新增“最近播放”按钮，点击进入最近播放页面。
- 最近播放最多保存 520 首。
- 播放歌曲时记录到最近播放。
- 重复歌曲会移动到最前面。

数据 key：

- `DATA_KEYS.recentPlayList`

核心常量：

- `RECENT_PLAY_LIMIT = 520`

移动端迁移建议：

- 移动端可放在“我的”页或底部 tab。
- 列表存储可用移动端本地 storage。
- 注意播放记录应基于 `source:id` 去重。

## 十二、我的云盘 / WebDAV

### 1. 我的云盘入口

新增：

- 左侧侧边栏空心云朵 icon。
- 独立“我的云盘”页面。
- 原“我的列表”中的“我的云盘”歌单被移除。

关键文件：

- `src/renderer/views/CloudDisk/index.vue`
- `src/renderer/components/layout/Aside/NavBar.vue`
- `src/common/types/list.d.ts`

### 2. WebDAV 支持

新增文件：

- `src/main/modules/webdav.ts`
- `src/main/modules/winMain/rendererEvent/webdav.ts`
- `src/renderer/core/music/webdav.ts`

设置项：

- `webdav.url`
- `webdav.username`
- `webdav.password`
- `webdav.autoRefresh`

IPC：

- `webdav_test`
- `webdav_list_musics`
- `webdav_get_music_url`
- `webdav_get_music_pic`
- `webdav_get_music_lyric`

音乐类型：

- 新增 `LX.Music.MusicInfoWebDAV`
- `LX.Music.MusicInfo` 扩展为 `MusicInfoOnline | MusicInfoLocal | MusicInfoWebDAV`

移动端迁移建议：

- 移动端如果要支持 WebDAV，需要独立实现：
  - WebDAV 登录/测试。
  - 目录扫描。
  - 音频 URL 获取。
  - 封面/歌词文件关联。
- 该功能与 WY 推荐主线无强耦合，可后续迁移。

## 十三、我的列表与歌单详情 UI

### 1. 我的列表侧栏

改动文件：

- `src/renderer/views/List/MyList/index.vue`
- `src/renderer/views/List/MyList/actions.ts`
- `src/renderer/views/List/MyList/useMenu.js`
- `src/renderer/views/List/MyList/useDarg.ts`
- `src/renderer/views/List/index.vue`

行为：

- 隐藏“试听列表”。
- 移除“我的云盘”条目，改为侧边栏独立入口。
- 每个歌单左侧显示封面，右侧显示歌单名。
- 封面默认使用歌单第一首歌封面。
- 预留自定义封面 API。
- 歌单名一行放不下可两行展示。
- 字体和封面大小可缩放。
- 滚动条变细，降低视觉干扰。

设置项：

- `list.myListSidebarScale`
  - 我的列表侧栏缩放百分比。

移动端迁移建议：

- 移动端“我的列表”可用卡片/列表混合样式。
- 歌单封面应尽量缓存，避免每次进入都从第一首歌临时取。

### 2. 歌单详情页头部

改动文件：

- `src/renderer/views/List/MusicList/index.vue`
- `src/renderer/views/List/MusicList/components/ListProfileEditModal.vue`
- `src/renderer/views/List/MusicList/useListScroll.js`
- `src/renderer/views/List/MusicList/useMenu.js`
- `src/renderer/store/list/listManage/rendererListManage.ts`
- `src/renderer/store/list/listManage/state.ts`

UI：

- 详情页上方新增歌单资料区域：
  - 左侧封面。
  - 右侧歌单名。
  - 歌单名右侧编辑按钮。
  - 创建时间。
  - 简介。
  - 播放全部按钮。
- 下方歌曲列表保留原样。
- 歌单资料区域去掉独立背景色，与页面融合。
- 封面和信息之间留出间距。
- 编辑图标放大，和歌单名视觉重量接近。
- 封面/信息整体大小支持设置中缩放。

设置项：

- `list.playlistProfileScale`
  - 歌单详情头部缩放比例。
  - 范围：`60%` 到 `140%`。

编辑弹窗：

- 可编辑歌单名。
- 可编辑简介。
- 可编辑封面。
- 保存和取消按钮下面留空。

数据结构：

```ts
interface UserListProfile {
  description?: string
  coverUrl?: string
}
```

移动端迁移建议：

- 移动端歌单详情页可做顶部 collapsible header。
- 编辑页建议单独页面，不一定用弹窗。
- 需要在移动端列表数据结构中加入 `profile.description`、`profile.coverUrl`。

### 3. 当前播放歌曲定位与耳机图标

行为：

- 当前歌单中正在播放的歌曲，序号替换为耳机 icon。
- 在当前播放音乐所属歌单时，如果用户滚动列表，右下角出现“定位到当前播放音乐”按钮。
- 5 秒无滚动操作后自动隐藏定位按钮。
- 点击定位后滚动到当前歌曲，并短暂显示类似 hover 的高亮特效。
- 修复了最初只在“我的列表”显示耳机 icon，推荐页 WY 歌单不显示的问题。
- 当前通过音乐 identity 比较，而不只依赖本地列表 id/index。

关键文件：

- `src/renderer/views/List/MusicList/index.vue`
- `src/renderer/components/material/OnlineList/index.vue`

移动端迁移建议：

- 移动端也可在列表右下角显示“当前播放”悬浮按钮。
- 当前歌曲标识应使用统一 identity：`source:id`，不要只用列表 index。

## 十四、在线歌单详情与 WY 歌单

### 1. WY 歌单详情接入

关键文件：

- `src/renderer/store/songList/action.ts`
- `src/main/modules/netease.ts`

行为：

- 对 `source == 'wy'` 的歌单优先使用 WY 歌单详情接口。
- 每日推荐是虚拟歌单，走 `getDailyRecommendPlaylistDetail()`。
- 风格日推是虚拟歌单，走 daily category detail 逻辑。
- 如果 WY 歌单详情加载失败，fallback 到项目原有 source sdk 的歌单详情。

特殊逻辑：

- 私人雷达歌单 id `3136952023` 走 WY 用户详情逻辑。
- cache key 区分：
  - 普通 sdetail。
  - WY sdetail。
  - WY 每日推荐。
  - WY 私人雷达。

移动端迁移建议：

- 移动端也需要区分真实 WY 歌单和虚拟歌单。
- 虚拟歌单不能直接拿 id 去普通 playlist_detail。

## 十五、桌面歌词

### 1. 单行/双行歌词与自适应高度

改动目标：

- 桌面歌词默认只显示一行。
- 如果开启翻译，则显示两行。
- 桌面歌词窗口高度根据字体大小、行高、上下 padding 自动调整。
- 选择翻译时，两行之间的间距可配置。
- 歌词显示区域上下 padding 可分别配置。

关键文件：

- `src/renderer-lyric/components/layout/LyricHorizontal/index.vue`
- `src/renderer-lyric/components/layout/LyricHorizontal/useLyric.js`
- `src/renderer-lyric/components/layout/LyricVertical/index.vue`
- `src/renderer-lyric/core/lyric.ts`
- `src/renderer-lyric/store/state.ts`
- `src/renderer-lyric/useApp/useLyric.ts`
- `src/main/modules/winLyric/main.ts`
- `src/main/modules/winLyric/utils.ts`
- `src/common/types/desktop_lyric.d.ts`
- `src/renderer/views/Setting/components/SettingDesktopLyric.vue`

新增/调整设置项：

- `desktopLyric.style.lineHeight`
- `desktopLyric.style.lineGap`
- `desktopLyric.style.extendedLineGap`
- `desktopLyric.style.paddingTop`
- `desktopLyric.style.paddingBottom`

关键行为：

- `useLyric.js` 中渲染当前行时，只把当前歌词行插入 DOM。
- 根据 `scrollHeight + paddingTop + paddingBottom` 计算目标窗口高度。
- 调用 `setWindowBounds()` 自动更新歌词窗口高度。
- 翻译行最多显示一行扩展行。

移动端迁移建议：

- 移动端不需要桌面歌词窗口，但歌词页可复用：
  - 单行/双行切换。
  - 翻译行间距。
  - 行高和 padding 设置。
- 移动端如果有悬浮歌词，需要重新实现平台悬浮窗权限与布局，不能直接迁移 Electron 逻辑。

### 2. 任务栏上方与置顶

Windows 桌面歌词调整：

- 支持歌词置于任务栏上方。
- 使用屏幕尺寸而不是工作区尺寸，允许移动到 Windows 任务栏覆盖区域附近。
- `alwaysOnTop` 使用更高层级，并支持循环置顶。

关键文件：

- `src/main/modules/winLyric/main.ts`
- `src/main/modules/winLyric/utils.ts`

移动端迁移建议：

- 移动端无 Windows 任务栏概念。
- Android 悬浮窗要用系统 overlay 权限，iOS 基本无法做全局悬浮歌词。

## 十六、Windows 托盘右键菜单

### 1. 自定义 HTML 托盘菜单

改动文件：

- `src/main/modules/tray.ts`

行为：

- Windows 下不再用 Electron 原生 `Menu` 作为托盘右键菜单。
- 改为创建无边框、透明、置顶的 `BrowserWindow` 显示自定义 HTML 菜单。
- 右键托盘后，菜单显示在鼠标右键位置稍微偏移处。
- 菜单左下角尽量贴近右键位置。
- 菜单整体缩小到原先约 75% 视觉体量。

### 2. 菜单内容

当前菜单内容：

- 顶部当前歌曲标题。
- 一行四个控制按钮：
  - 喜欢/取消喜欢。
  - 上一首。
  - 播放/暂停。
  - 下一首。
- 音量行：
  - 静音按钮。
  - 音量 slider。
  - 鼠标悬浮显示音量百分比，例如 `12%`。
- 桌面歌词开关。
- 设置。
- 退出。

删除：

- “开启音乐桌面”。
- “最小化”。

交互：

- 点击上一首/播放暂停/下一首/喜欢/音量/静音后，右键菜单不消失。
- 点击设置/退出等动作后菜单关闭。
- 喜欢、上一首、播放/暂停、下一首图标放大。

移动端迁移建议：

- 移动端无托盘菜单，不需要迁移。
- 可以参考其控制布局，用于移动端通知栏控制或播放器快捷控制区。

## 十七、设置页重构

### 1. 设置页视觉优化

改动文件：

- `src/renderer/views/Setting/index.vue`
- 多个 `src/renderer/views/Setting/components/*.vue`

目标：

- 每个设置系列增加边框/卡片式分组。
- 字体、间距、边框、背景更统一。
- 删除/隐藏“软件更新”栏目。
- 打开软件时不弹出版本更新日志。

删除文件：

- `src/renderer/views/Setting/components/SettingUpdate.vue`

调整：

- `src/renderer/core/useApp/useUpdate.ts`
- `src/common/defaultSetting.ts`
  - `common.showChangeLog`
  - `common.tryAutoUpdate`

移动端迁移建议：

- 移动端设置页可按分组卡片实现。
- 软件更新如果由应用商店托管，移动端可以不显示。

### 2. 推荐设置

新增文件：

- `src/renderer/views/Setting/components/SettingRecommend.vue`

功能：

- 推荐首页 section 顺序设置。
- 上移/下移按钮调整：
  - 雷达歌单。
  - 多元旋律/风格歌曲。
  - 风格日推。
  - 红心相似歌曲。
  - 推荐歌单。
  - 榜单精选。
- 重置顺序。
- 风格日推 tag 设置：
  - 通过 `/api/homepage/daily/song/config/get` 获取 category/tag。
  - 用户可选择 tag。
  - 用户可对已选 tag 上移/下移。
  - 可重置为默认。
  - 可清空，清空后推荐页隐藏风格日推 section。

设置项：

- `recommend.homeSectionOrder`
- `recommend.dailySongCategoryTagKeys`

辅助文件：

- `src/renderer/utils/recommendSectionOrder.ts`
- `src/common/utils/neteaseDailySongCategory.ts`

移动端迁移建议：

- 移动端设置页需提供：
  - 推荐模块排序。
  - 风格日推 tag 多选与排序。
- 上移/下移可以换成拖拽排序。

### 3. 列表设置

改动文件：

- `src/renderer/views/Setting/components/SettingList.vue`

新增设置：

- 我的列表侧栏缩放：`list.myListSidebarScale`
- 歌单详情头部缩放：`list.playlistProfileScale`

移动端迁移建议：

- 移动端可以保留“列表密度/封面大小”设置。
- 不一定需要和桌面版同名。

### 4. 桌面歌词设置

改动文件：

- `src/renderer/views/Setting/components/SettingDesktopLyric.vue`

新增可调：

- 行高。
- 翻译两行之间的间距。
- 歌词区域上 padding。
- 歌词区域下 padding。

移动端迁移建议：

- 若移动端有歌词页，可迁移为歌词显示设置。

### 5. 听歌时间展示

新增文件：

- `src/common/utils/listeningTime.ts`
- `src/renderer/store/listeningTime/action.ts`
- `src/renderer/store/listeningTime/state.ts`
- `src/renderer/views/Setting/components/SettingListeningTime.vue`

数据 key：

- `DATA_KEYS.listeningTimeStats`

展示内容：

- 总听歌时间。
- 今日听歌时间。
- 本周听歌时间。
- 已统计歌曲数。
- 最近 7 天柱状/比例展示。
- 听歌最多歌曲列表。

统计逻辑：

- 播放过程中累加当前歌曲收听秒数。
- 节流保存到本地存储。
- 按日期聚合 daily。
- 按歌曲 identity 聚合 songs。

移动端迁移建议：

- 这是适合移动端的功能，建议迁移。
- 可放在“我的”页顶部卡片或设置页。
- 移动端要处理后台播放、锁屏播放时的计时准确性。

## 十八、窗口尺寸与启动行为

改动：

- 默认窗口尺寸调大，参考 YesPlayMusic。
- 在设置的窗口尺寸中，“超大”和“巨大”之间新增一个中间尺寸。
- 顶部搜索区域拖动问题已修复：搜索栏等控件设置 no-drag，保留可拖动区域。
- 打开软件时不弹版本更新日志。

关键文件：

- `src/common/config.ts`
- `src/common/defaultSetting.ts`
- `src/renderer/components/layout/Toolbar/index.vue`
- `src/renderer/components/material/SearchInput.vue`
- `src/renderer/assets/styles/index.less`
- `src/renderer/assets/styles/variables.less`

移动端迁移建议：

- 窗口尺寸不适用于移动端。
- 但“顶部栏可点击区域和可拖动区域冲突”的经验可转化为移动端的手势冲突处理。

## 十九、搜索栏与顶部栏

改动：

- 顶部搜索框恢复为原来的输入框样式，而不是单独搜索 icon。
- 样式微调，使其更贴近整体 UI。
- 搜索栏左侧增加返回上一级按钮 `<`。
- 修复顶部搜索区域占用窗口拖动区域导致部分区域不可拖动的问题。

关键文件：

- `src/renderer/components/material/SearchInput.vue`
- `src/renderer/components/layout/Toolbar/index.vue`

移动端迁移建议：

- 移动端可以把搜索框放推荐页顶部。
- 返回按钮用系统导航返回，不必显示 `<`。

## 二十、一起听与同步相关改动

本轮代码中还新增了一组“一起听/party”相关能力，虽然不是当前 WY 推荐主线的核心需求。

新增/修改文件：

- `src/main/modules/sync/party.ts`
- `src/main/modules/sync/client/modules/party/handler.ts`
- `src/main/modules/sync/client/modules/party/index.ts`
- `src/main/modules/winMain/rendererEvent/party.ts`
- `src/renderer/core/party.ts`
- `src/renderer/core/useApp/useParty.ts`
- `src/renderer/store/party.ts`
- `src/renderer/components/layout/PlayDetail/PartyModal.vue`
- `src/renderer/components/layout/PlayDetail/PlayBar.vue`
- `src/renderer/components/layout/PlayDetail/index.vue`

播放栏中：

- 右侧增加“一起听”入口。

移动端迁移建议：

- 如果移动端已有同步/一起听机制，再参考迁移。
- 如果当前目标只是 WY 推荐与播放，不建议第一阶段迁移该功能。

## 二十一、数据结构与类型扩展

### 1. 设置项

新增或改动位置：

- `src/common/defaultSetting.ts`
- `src/common/types/app_setting.d.ts`
- `src/common/utils/migrateSetting.ts`

新增/重点设置项：

- `common.windowSizeId`
- `common.showChangeLog`
- `list.myListSidebarScale`
- `list.playlistProfileScale`
- `recommend.homeSectionOrder`
- `recommend.dailySongCategoryTagKeys`
- `desktopLyric.style.lineHeight`
- `desktopLyric.style.lineGap`
- `desktopLyric.style.extendedLineGap`
- `desktopLyric.style.paddingTop`
- `desktopLyric.style.paddingBottom`
- `webdav.url`
- `webdav.username`
- `webdav.password`
- `webdav.autoRefresh`

### 2. 数据 key

新增或重点 key：

- `recentPlayList`
- `neteaseAccount`
- `listeningTimeStats`

位置：

- `src/common/constants.ts`

### 3. 音乐类型

改动：

- 新增 WY 元数据字段。
- 新增 WebDAV 音乐类型。
- `MusicInfo` union 扩展。

位置：

- `src/common/types/music.d.ts`

### 4. 歌单类型

改动：

- 用户歌单增加 profile 信息。
- 我的云盘歌单类型拆出。

位置：

- `src/common/types/list.d.ts`

## 二十二、国际化文案

修改文件：

- `src/lang/zh-cn.json`
- `src/lang/zh-tw.json`
- `src/lang/en-us.json`

新增文案覆盖：

- 推荐页。
- 私人 FM。
- 播放队列。
- 最近播放。
- 我的云盘。
- 歌单资料编辑。
- 设置页推荐排序。
- 风格日推 tag。
- 听歌时间。
- 桌面歌词行高/padding。
- 托盘/播放栏相关文案。

移动端迁移建议：

- 移动端如果已有 i18n，需要同步新增 key。
- 如果移动端第一阶段只做中文，可先保留 zh-cn。

## 二十三、README 与文档资源

修改：

- `README.md`
- `doc/images/recommendation.png`
- `doc/images/my_list.png`

README 当前记录：

- 支持 WebDAV。
- 新增推荐/私人雷达。
- WY 收藏同步。
- TODO。
- 推荐页和我的列表截图。

注意：

- README 中按要求把敏感平台名替换为 WY。

移动端迁移建议：

- 移动版 README 可参考当前 README 的“修改记录”和截图结构。

## 二十四、移动端迁移优先级建议

### 第一阶段：必须迁移

1. WY 登录状态与账号存储。
2. WY API service：
   - 登录二维码。
   - 登录状态。
   - 每日推荐。
   - 私人 FM。
   - 首页推荐聚合。
   - 歌单详情。
   - 喜欢/收藏同步。
   - `/fm_trash`。
3. 推荐页主结构：
   - 每日推荐。
   - 私人 FM。
   - 私人雷达。
   - 雷达歌单。
   - 红心相似歌曲。
   - 推荐歌单。
4. 推荐歌曲播放 fallback：
   - WY 推荐数据 -> LX 内置音源搜索匹配 -> 播放。
5. 推荐页缓存和返回位置恢复。
6. 收藏到“我的收藏”时同步 WY 喜欢。

### 第二阶段：体验增强

1. 风格日推 tag 选择与排序。
2. 多元旋律/风格歌曲 section。
3. 榜单精选。
4. 播放队列 bottom sheet。
5. 最近播放 520 首。
6. 听歌时间统计。
7. 歌单详情页资料头部与编辑页。

### 第三阶段：可选迁移

1. WebDAV 我的云盘。
2. 一起听/party。
3. 桌面歌词相关设置在移动端的等价功能。
4. Windows 托盘菜单无需迁移，只能参考通知栏/快捷控制设计。

## 二十五、移动端实现时需要特别注意的问题

### 1. 不要把 WY 歌曲 URL 当作主播放源

本轮最后确定的策略是：

- WY API 负责推荐数据。
- 播放源优先使用当前项目配置的音源。
- WY song url 只保留为可选能力，不作为推荐页优先播放方式。

移动端如果照搬 WY song url，可能出现：

- 会员/版权无法播放。
- URL 过期。
- 音质/权限不可控。
- 与 LX 原项目自定义源体系冲突。

### 2. 虚拟歌单要单独处理

虚拟歌单包括：

- 每日推荐。
- 风格日推。
- 私人 FM。

这些不应直接调用普通歌单详情接口。

### 3. 推荐页不要每次进入都刷新

已修复的问题：

- 从推荐页进入歌单详情后返回，会重置到顶部。
- 推荐页重新加载导致私人 FM 信息刷新，进而影响 FM 队列。

移动端要避免：

- tab 切换刷新。
- 路由返回刷新。
- 登录状态未变化也强制刷新。

### 4. section 局部刷新比整页刷新更重要

当前设计：

- 页面首次加载时尽量并行加载。
- 用户手动点击各 section 的刷新按钮时，只刷新对应 section。
- 风格日推设置变化时才刷新相关 section。

### 5. 歌曲 identity 必须统一

当前播放标识建议：

```ts
`${musicInfo.source}:${musicInfo.id}`
```

原因：

- 推荐页 WY 歌单和本地列表可能不是同一个 listId。
- 只靠 index 无法识别来自不同页面的同一首歌。
- 耳机 icon、收藏状态、最近播放都依赖统一 identity。

### 6. Tag 风格日推不能用固定首页推荐代替

风格日推必须根据用户选中的 tag 获取对应歌曲：

- 先获取 category/tag。
- 再获取 seed song。
- 再请求 category daily song list。
- 再包装成虚拟歌单。

如果只请求首页推荐，会出现用户选了多个 tag，但界面只显示两个或内容都一样的问题。

## 二十六、主要文件对照表

### WY/API

- `src/main/modules/netease.ts`
- `src/main/modules/neteasePlaylist.ts`
- `src/main/modules/winMain/rendererEvent/netease.ts`
- `src/common/types/netease.d.ts`
- `src/renderer/store/netease.ts`
- `src/renderer/utils/ipc.ts`

### 推荐页

- `src/renderer/views/Recommend/index.vue`
- `src/renderer/views/Recommend/useRecommendData.ts`
- `src/renderer/views/Recommend/useRecommendPlayback.ts`
- `src/renderer/views/Recommend/useRecommendCards.ts`
- `src/renderer/views/Recommend/useRecommendLove.ts`
- `src/renderer/views/Recommend/useNeteaseLoginQr.ts`
- `src/renderer/views/Recommend/components/SpecialCards.vue`
- `src/renderer/views/Recommend/components/HorizontalPlaylistSection.vue`
- `src/renderer/views/Recommend/components/SimilarSongsSection.vue`
- `src/renderer/views/Recommend/components/ChartsSection.vue`
- `src/renderer/views/Recommend/components/LoginPanel.vue`

### 播放/队列/私人 FM

- `src/renderer/core/player/action.ts`
- `src/renderer/store/privateFm/action.ts`
- `src/renderer/store/privateFm/state.ts`
- `src/renderer/store/dailyRecommend/action.ts`
- `src/renderer/store/dailyRecommend/state.ts`
- `src/renderer/components/layout/PlayBar/ModernBar.vue`
- `src/renderer/components/layout/PlayQueue.vue`
- `src/renderer/components/common/PrivateFmModeBtn.vue`
- `src/renderer/components/common/TogglePlayModeBtn.vue`

### 列表/歌单

- `src/renderer/views/List/MyList/index.vue`
- `src/renderer/views/List/MusicList/index.vue`
- `src/renderer/views/List/MusicList/components/ListProfileEditModal.vue`
- `src/renderer/components/material/OnlineList/index.vue`
- `src/renderer/components/material/OnlineList/usePlay.ts`
- `src/renderer/store/list/action.ts`
- `src/renderer/store/songList/action.ts`

### 最近播放/云盘

- `src/renderer/views/RecentPlay/index.vue`
- `src/renderer/store/recentPlay/action.ts`
- `src/renderer/store/recentPlay/state.ts`
- `src/renderer/views/CloudDisk/index.vue`
- `src/main/modules/webdav.ts`
- `src/main/modules/winMain/rendererEvent/webdav.ts`

### 设置

- `src/renderer/views/Setting/index.vue`
- `src/renderer/views/Setting/components/SettingRecommend.vue`
- `src/renderer/views/Setting/components/SettingList.vue`
- `src/renderer/views/Setting/components/SettingDesktopLyric.vue`
- `src/renderer/views/Setting/components/SettingListeningTime.vue`
- `src/renderer/views/Setting/components/SettingOther.vue`
- `src/common/defaultSetting.ts`
- `src/common/types/app_setting.d.ts`

### 桌面歌词

- `src/renderer-lyric/components/layout/LyricHorizontal/index.vue`
- `src/renderer-lyric/components/layout/LyricHorizontal/useLyric.js`
- `src/renderer-lyric/core/lyric.ts`
- `src/main/modules/winLyric/main.ts`
- `src/main/modules/winLyric/utils.ts`

### 托盘

- `src/main/modules/tray.ts`

### 路由/侧边栏/顶部栏

- `src/renderer/router.ts`
- `src/renderer/components/layout/Aside/index.vue`
- `src/renderer/components/layout/Aside/NavBar.vue`
- `src/renderer/components/layout/Toolbar/index.vue`
- `src/renderer/components/material/SearchInput.vue`
- `src/renderer/components/layout/Icons.vue`

## 二十七、当前遗留 TODO

### WY 与推荐

- 补充 WY 登录、推荐歌单、私人 FM、收藏同步的自动化测试。
- 对推荐歌曲匹配失败增加更明确提示。
- 为推荐歌曲多源匹配增加手动选择候选结果的能力。
- 继续验证取消收藏是否需要同步 WY 取消喜欢。
- 增加登录过期、接口限流、网络超时、无权限歌单等错误分类和重试策略。

### 风格日推

- 继续观察 `/api/pc/daily/rcmd/block` 的 seed song 是否稳定。
- 如果接口降级 demote，当前 fallback 会保存 tag 后请求默认 list，仍需更多实测。
- 移动端要特别防止“所有 tag 获取到相同歌单”的回归。

### 推荐页性能

- 大量横向歌单 section 在低性能设备上需要虚拟化或懒加载。
- 移动端应优先按 section 懒加载图片。
- 返回页面恢复滚动位置要和移动端路由缓存配合。

### 播放

- WY 推荐歌曲 fallback 到项目内部源时，仍可能遇到同名歌曲误匹配。
- 建议记录匹配结果缓存，减少重复搜索。

### 桌面/平台差异

- 桌面歌词、托盘菜单、窗口尺寸等功能不适合直接迁移移动端。
- 移动端应设计对应平台原生体验，而不是照搬 Electron 实现。

## 二十八、迁移时可复用的设计结论

- 推荐数据和播放源解耦：WY 负责“推荐什么”，LX 源负责“怎么播放”。
- 推荐页应该是缓存型首页，不是每次进入都重新请求的普通列表页。
- 私人 FM 是一种播放模式，不只是一个歌单。
- 每个推荐 section 要支持局部刷新。
- 收藏同步只在进入“我的收藏”时触发 WY 喜欢，更符合用户预期。
- 歌单详情和在线推荐列表都应使用统一的当前播放歌曲判断方式。
- 设置页中的模块排序和 tag 排序，可以让推荐页更可控。
- 移动端优先迁移主链路：登录 -> 推荐 -> 歌单详情 -> 播放 -> 收藏同步。
