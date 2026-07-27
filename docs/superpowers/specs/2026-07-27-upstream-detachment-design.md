# 上游解耦与技术标识迁移设计

## 背景

当前定制版以 `lyswhut/lx-music-desktop` v2.12.1 为基线，已经加入独立功能，但仍沿用上游的自动更新、发布目标、作者元数据、帮助链接、系统标识、备份扩展名和若干 fork 依赖。生产版启动后仍会检查上游更新，发布配置也仍指向上游仓库。这些行为会误导用户，并可能让上游发布覆盖定制版。

本次改造保留 `LX Music` 的显示名称、现有图标、内部 `LX.*` 类型、`global.lx` / `window.lx` 命名和 `lxlyric` / `lxlrc` 数据契约；其余对上游运行环境、发布设施和维护者身份的耦合将被移除。Apache-2.0、上游归属说明、附加协议和第三方许可证继续保留。

## 目标

1. 停止访问、下载或发布到上游的运行时与 CI 行为。
2. 将项目元数据、支持入口和发布目标切换到 `starkyYourEyes/lx-music-desktop`。
3. 使用新的系统级技术标识，同时安全迁移已安装版本的用户数据。
4. 新备份使用 `.slxmc`，同时允许导入旧 `.lxmc` 文件。
5. 用 npm 官方包替换五个 `lyswhut` fork，并用项目内 RPC 实现替换 `message2call`。
6. 删除过时的上游文档、更新界面与发布脚本，保留明确且合规的来源说明。
7. 在验证通过后清理生成目录、索引缓存和多余 worktree，不删除分支、提交、标签或旧用户数据。

## 非目标

- 不更换 `LX Music` 显示名称和图标。
- 不重命名内部 `LX.*` TypeScript 命名空间、`global.lx`、`window.lx`、`lxlyric` 或 `lxlrc`。
- 不兼容旧 `lxmusic://` 深链和旧同步客户端。
- 不改变 `.slxmc` 文件的内部序列化格式；本次只改变新导出的扩展名。
- 不重写 Git 历史，不删除历史提交和标签。
- 不删除旧用户数据目录，也不删除任何工作分支。

## 项目身份

| 项目 | 新值 |
| --- | --- |
| npm/package 名称 | `starky-lx-music-desktop` |
| 显示名称 | `LX Music` |
| Electron appId | `com.starkyyoureyes.lxmusic.desktop` |
| 可执行文件与构建产物前缀 | `starky-lx-music-desktop` |
| 用户数据目录 | `starky-lx-music-desktop` |
| 深链协议 | `starkylx://` |
| 协议名称 | `starky-lx-music-protocol` |
| 桌面同步身份 | `starky_lx_music_desktop` |
| 移动同步身份 | `starky_lx_music_mobile` |
| 同步认证前缀 | `starky-lx-music auth::` |
| 同步连接前缀 | `starky-lx-music connect` |
| User-Agent | `starky-lx-music request` |
| User API session | `starky-lx-user-api` |
| 新备份扩展名 | `.slxmc` |
| 默认 WebDAV 子目录 | `/starky-lx-music` |
| 作者 | `starkyYourEyes` |
| 仓库 | `https://github.com/starkyYourEyes/lx-music-desktop` |
| Issues | `https://github.com/starkyYourEyes/lx-music-desktop/issues` |
| Releases | `https://github.com/starkyYourEyes/lx-music-desktop/releases` |

项目身份值集中在一个公共配置模块中。构建配置无法直接导入 TypeScript 时，使用一个可被 Node 和应用源码共同读取的 JavaScript 模块，并提供对应类型声明。测试直接读取同一模块，禁止在生产代码中复制这些值。

## 用户数据迁移

### 启动顺序

迁移发生在 Electron 初始化数据库、设置和窗口之前，并纳入现有 `setUserDataPath()` 流程：

1. 检测便携模式。便携版继续使用包旁的 `userData`，不执行安装版目录迁移。
2. 安装版基于 `app.getPath('appData')` 计算旧目录 `lx-music-desktop` 和新目录 `starky-lx-music-desktop`。
3. 新目录已存在时直接使用，不从旧目录覆盖任何内容。
4. 新目录不存在、旧目录存在时，将旧目录复制到同级临时目录。
5. 复制完成后验证临时目录可读，并核对旧目录的顶层条目均已出现在临时目录。
6. 将临时目录原子重命名为新目录，写入迁移标记，然后把 Electron `userData` 指向新目录。
7. 旧目录始终保留。

临时目录使用确定的、新目录派生名称，并在操作前验证其绝对路径位于 `appData` 下。只允许删除本次创建或识别出的迁移临时目录。复制或重命名失败时记录错误、清理临时目录并使用新的空目录启动，不修改旧目录。

旧产品目录名只允许存在于迁移模块、迁移测试、工程设计文档和上游归属说明中。

### 备份兼容

设置与歌单的新导出文件统一使用 `.slxmc`：

- `starky_datas_v2.slxmc`
- `starky_setting_v2.slxmc`
- `starky_list.slxmc`
- `starky_list_part_<name>.slxmc`

文件选择器接受 `.slxmc` 与 `.lxmc`。解码逻辑不根据扩展名分叉，两种扩展名进入同一现有解析流程。旧 `.lxmc` 字符串只允许出现在导入兼容模块、测试和迁移说明中。

现有用户已经保存的 WebDAV 地址不修改；只有新安装的默认值改为 `/starky-lx-music`。

## 深链与同步协议

应用只注册并解析 `starkylx://`。旧 `lxmusic://` 不再注册，也不作为别名接受。文档和示例改用 `starkylx://music/play` 与 `starkylx://music/search/...`。

同步客户端发送 `starky_lx_music_desktop`，服务端只识别新的桌面与移动身份。认证和连接消息前缀同时更新，因此旧客户端会在认证阶段失败，而不会进入半兼容状态。内部音乐、列表、歌词和开放 API 类型保持不变。

## 移除自动更新与上游发布耦合

运行时自动更新整条调用链删除，包括：

- 渲染进程更新初始化与版本信息请求。
- 更新弹窗和更新状态 store。
- 更新 IPC 名称、监听器与 preload 包装。
- 主进程 `electron-updater` 初始化、检查、下载和安装逻辑。
- `electron-updater` 依赖、自动更新默认设置和相关语言文本。
- 上游 npm、GitHub、jsDelivr、Gitee 与 CDN 版本源。

应用不提供内置更新检查。About 页面只链接当前仓库的 Releases。

Electron Builder 的 GitHub publish provider 改为 `starkyYourEyes/lx-music-desktop`，现有 Release workflow 继续把构建产物上传到触发工作流的当前仓库。删除向 `lyswhut/lx-music-desktop-version-info` 发送 dispatch 的工作流。

Git 元数据中，`origin` 改为当前仓库，当前分支跟踪目标改为 `origin`，重复的 `starky` remote 删除。不会 push、重写历史或删除标签。

## 同步 RPC 替换

`message2call` 仅在同步 WebSocket 客户端和服务端使用。新模块实现当前调用面，不引入通用 RPC 框架。

### 接口

新模块保留以下调用形状，减少业务代码改动：

- `createSyncRpc(options)`
- `remote`
- `createQueueRemote(groupName)`
- `message(data)`
- `destroy()`

`options` 支持 `funcsObj`、`timeout`、`sendMessage`、`onCallBeforeParams` 和 `onError`。

### 消息协议

消息使用可 JSON 序列化的显式结构：

- 调用：`{ type: 'call', id, path, args, group }`
- 成功：`{ type: 'result', id, data }`
- 失败：`{ type: 'error', id, error: { name, message } }`

远程代理累积属性路径，函数调用时生成唯一 ID。接收端解析路径、确认目标为函数、注入 socket 参数并等待返回值。未知路径、非函数目标和远端异常均返回错误消息，不抛出到 WebSocket 事件循环。

`createQueueRemote(groupName)` 在本地为每个分组维护 FIFO 队列，同一分组同时只允许一个调用在途；不同分组可并发。超时拒绝对应 Promise 并释放队列。`destroy()` 拒绝所有未完成和排队调用，之后拒绝新调用。

### 依赖替换

| 当前依赖 | 替换 |
| --- | --- |
| `github:lyswhut/electron-devtools-installer` | `electron-devtools-installer@^4.0.0` |
| `github:lyswhut/eslint-friendly-formatter` | `eslint-formatter-friendly@^7.0.0` |
| `github:lyswhut/spinnies` | `spinnies@^0.5.1` |
| `github:lyswhut/webpack-hot-middleware` | `webpack-hot-middleware@^2.26.1` |
| `github:lyswhut/needle` | `needle@^3.5.0` |
| `message2call` | 项目内 `createSyncRpc` 模块 |

依赖更新通过 `npm install` 生成 lockfile，不手工编辑完整性哈希。若官方包的导出形式变化，只在现有调用点做最小适配。

## 文档与归属

`README.md` 重写为当前定制版说明，包含功能、开发命令、迁移变化、支持渠道、许可证和上游致谢。About、Issue 模板、自定义源、同步、开放 API 和歌单帮助链接全部指向当前仓库 README、Issues 或 Releases。

删除以下遗留内容：

- `FAQ.md`
- `CHANGELOG.md`
- `publish/` 旧发布脚本与版本 JSON
- 上游 version-info dispatch workflow
- 更新弹窗、变更日志弹窗及相关代码

源码中用于解释实现的上游 Issue URL 改写为本地技术注释。历史工程文档中的构建产物名更新为新前缀；纯历史设计记录允许描述迁移前名称，但不得作为运行时配置来源。

保留标准 Apache-2.0 `LICENSE`、现有中英文/RTF 附加协议和第三方许可证。新增上游归属文件，明确当前项目派生自 `lyswhut/lx-music-desktop` v2.12.1，并说明后续修改由当前维护者负责。上游作者名和 URL 只允许出现在许可证、归属文件、README 致谢、迁移设计/测试以及不可重写的 Git 历史中。

## 测试策略

所有行为变更遵循先失败、后实现的 TDD 顺序。

### 身份与迁移测试

- 公共身份模块返回设计表中的精确值。
- 旧目录存在、新目录不存在时完整复制并保留旧目录。
- 新目录存在时不复制、不覆盖。
- 复制失败时旧目录保持不变，临时目录被清理。
- 临时目录路径越界时拒绝执行删除或重命名。
- 便携模式不触发安装版迁移。
- 新导出使用 `.slxmc`，导入同时接受 `.slxmc` 和 `.lxmc`。

### RPC 契约测试

- 同步返回值和异步返回值。
- 嵌套方法路径与调用前参数注入。
- 远端错误、未知方法和非函数路径。
- 超时拒绝与后续调用恢复。
- 销毁时拒绝在途和排队调用。
- 同组严格串行、不同组允许并发。
- 双向内存消息端点上的真实 JSON 往返。

### 去上游化审计测试

静态审计测试验证：

- 生产代码、package metadata、workflow、构建配置和用户文档中不存在上游更新源与发布目标。
- `lyswhut` 仅存在于许可证、上游归属和 README 致谢等允许位置。
- 旧 appId、深链和同步身份不出现在生产代码。
- 旧用户目录和 `.lxmc` 仅出现在隔离兼容代码与测试中。
- package 与 lockfile 不包含 `github:lyswhut` 或 `github.com/lyswhut` 依赖地址。

## 验证与清理顺序

1. 运行新增 Node 测试和现有脚本测试。
2. 运行 `npm run lint`。
3. 运行 `npm run build`。
4. 运行主进程 bundle 与 packaged-app 测试。
5. 执行全仓字符串复扫，检查允许列表以外的上游标识。
6. 核对 Git diff，确认未覆盖任务开始前已有修改。
7. 验证成功后删除 `build/`、`dist/` 和 `.codegraph/`。
8. 用 Git worktree 命令注销三个仅含 `.claude/` 缓存的 Claude worktree，并 prune 已失效的 `qq-music-login` worktree 记录；保留所有分支和提交。
9. 保留更新后的 `node_modules/`，使项目仍可直接测试和构建。

## 验收标准

- 生产版不会检查或下载任何上游更新。
- Release workflow 和 Electron Builder 只面向当前仓库。
- 新安装使用新的 appId、协议、同步身份、用户数据目录和构建产物前缀。
- 已安装用户的数据可一次性迁移，旧目录不被删除或覆盖。
- 新备份使用 `.slxmc`，旧 `.lxmc` 仍可导入。
- 同步客户端与服务端在新 RPC 模块上通过全部契约测试。
- 六个 `lyswhut` 相关直接依赖全部移除或替换。
- 用户可见链接不再导向上游的 Issues、Releases 或文档。
- 许可证、第三方声明与上游归属完整保留。
- `build/`、`dist/`、`.codegraph/` 和多余 worktree 已清理，分支、提交、标签、旧用户数据与 `node_modules/` 保留。
