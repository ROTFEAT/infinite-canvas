# Server Config Persistence Implementation Plan

> 执行方式：在当前独立 worktree 内按任务顺序开发和验证，不使用子代理。

**Goal:** 让自托管实例共享渠道、工作流和默认生成设置，保留原纯前端模式。

**Architecture:** 同源 GET/PUT `/api/instance-config` + revision compare-and-swap + JSON 持久卷。浏览器启动门控和单写队列负责读取、保存、冲突提示；本地凭据不共享。

**Tech Stack:** Node HTTP/fs、React、Zustand、Vitest、Node test、Docker Compose、Nginx。

## Task 1: 持久化 HTTP 服务

- [ ] 在 `web/server/instance-config-server.test.mjs` 先加入启动/写入/重启读取、旧 revision 409、并发仅一次成功、坏文件保护、跨源与凭据拒绝测试。
- [ ] 用 `node --test web/server/instance-config-server.test.mjs` 确认缺失功能，再实现 `web/server/instance-config-server.mjs`：导出 `createInstanceConfigServer({dataDir, origin})`，GET 返回 `{version:1,revision,config}`，PUT 接受 `{baseRevision,config}`，错误返回 `{error}`。
- [ ] 文件落于 `<dataDir>/instance-config.json`，原子 rename；请求大小 5 MiB，不能用无效 JSON 覆盖旧文件。测试通过后提交。

## Task 2: 浏览器同步

- [ ] 在 `web/src/services/api/instance-config.test.ts` 覆盖配置凭据过滤/恢复、串行保存、409 和失败处理。
- [ ] 添加 `web/src/services/api/instance-config.ts`，所有网络访问集中在这里；保存队列只处理最新快照并保留 revision。
- [ ] 添加 `web/src/components/layout/instance-config-gate.tsx` 并接入 AppProviders：启用时 hydration → GET → 渲染；失败/空实例须显式操作；保存状态可见。
- [ ] 运行相关 Vitest 测试，确认纯前端模式完全保留。

## Task 3: 可选部署和说明

- [ ] 添加独立配置服务 Dockerfile 与 Compose；Nginx 仅在启用时添加同源代理，默认静态配置不变。
- [ ] 环境变量 `SERVER_CONFIG_ENABLED=true` 写入 runtime config；开发模式也可通过 Vite 配置启用。
- [ ] 更新 AGENTS 的本 fork 例外、DEPLOY 说明、Unreleased 和 pending-test，复核 TODO。
- [ ] 测试完成后推送用户 fork 的 `codex/server-config-persistence` 分支；不合并 upstream/main，不自动替换生产部署。
