# 手机端第一阶段配套改动

2026-09-11，分支 `codex/mobile-feature-sync-phase-1`，桌面基线 `130a4190`，手机基线 `379106c`。

桌面配套实现可选的 `listProfile:1` 同步服务，为手机传递歌单简介、HTTP(S) 封面、分组和创建时间。双方均支持且列表同步已就绪时才启用；既有 `list:1` 与旧版连接兼容行为保持不变。桌面作为客户端暂不声明该能力。

资料按歌单 ID 使用共同快照逐字段合并，冲突方向跟随列表同步选择，处理离线修改、同步途中修改、资料先到、删除以及同步能力开关顺序。失败的对端确认不推进持久化共同快照；不收敛的交换在限定轮次后停止连接。

桌面 SQLite 写入支持提交读取时的 `base`，只更新调用方实际编辑的字段；资料同步保留本机账号管理字段。主进程向界面发布已提交资料，界面用版本计数避免较早的读取或保存响应覆盖新通知。

整份和单歌单备份增加可移植的 `profile`，继续兼容已有顶层 `group`。旧备份缺少资料字段时保留本机已有资料。

验证：同步兼容、歌单分组、备份、资料协议、存储契约和 IPC 共 82 项测试通过；Electron／SQLite 存储与重试 25 项通过；TypeScript、Vue 类型与修改文件 lint 通过。四个生产模块已按项目 Webpack 配置构建到 `dist`，最后的能力切换修改也重新构建了主模块。

`npm run build` 的清理阶段遇到旧打包目录中的文件占用，改为直接使用四个现有 Webpack 配置构建。本次未生成新的桌面安装程序。需要试用新资料协议时，关闭旧桌面程序，在本项目运行 `npx electron .` 使用已经构建的程序；旧安装程序继续只支持原有能力。

手机端已生成并在 Android 11 模拟器安装签名 Release APK；已验证实际播放、UI、GitHub 导入、两端首次联网及重启重连。完整操作步骤、APK 路径及限制见 [手机第一阶段交付记录](D:/projects/lx-music-mobile/docs/superpowers/plans/2026-09-11-phase1-delivery.md)。本次变更未包含桌面工作区中已有的 `docs/blog/`。

测试命令：

```powershell
node --test scripts/test-list-profile-sync.js scripts/test-sync-client-compatibility.js scripts/test-sync-rpc-wire-compatibility.js build-config/my-list-groups.test.js build-config/my-list-group-flows.test.js build-config/storage/non-activity-contracts.test.js build-config/storage/non-activity-ipc.test.js
$env:ELECTRON_RUN_AS_NODE = '1'
$env:LX_TEST_STORAGE_ROOT = 'D:/projects/lx-music-desktop/.tmp/phase1-storage'
./node_modules/.bin/electron.cmd --test build-config/storage-electron/non-activity-repository.test.js build-config/storage-electron/non-activity-retry.test.js
```

SQLite 测试要求 `LX_TEST_STORAGE_ROOT` 指向已存在的测试目录。跨项目协议测试默认使用相邻的 `lx-music-mobile`；需要自定义路径时设置 `LX_MOBILE_PROJECT`。

本轮真实联调还修复了首次同步的分组覆盖问题：界面推导的默认分组只用于显示，不再自动写入资料与手机的显式选择冲突。82 项相关回归、修改文件 lint 及 renderer 生产构建通过；全新桌面测试资料首次接收手机歌单后保留“外部”，双向简介修改和重启重连通过。

本轮全量 Vue 类型复查在已有 `src/renderer/views/Recommend/index.vue:115` 的 ref 回调处失败，该文件未被本轮修改。完整模拟器测试证据与范围见 [运行验证记录](D:/projects/lx-music-mobile/docs/superpowers/plans/2026-09-11-phase1-runtime-validation.md)。
