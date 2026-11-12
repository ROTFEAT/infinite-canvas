# 实施计划

采用 writing-plans / subagent-driven-development；在现有独立 worktree 的 codex/durable-gpu-queue 分支执行，不合并 main。用户已确认方案和部署目标 108。

1. 后端：新增 web/server/generation-queue*.mjs（服务与 node:test），Dockerfile.generation-queue。先写临时 SQLite + 假 Comfy HTTP/WS 的失败测试，再实现持久状态机、两 worker 调度、Comfy 兼容 API、任务管理 API、结果路由和重启核对。执行 `node --test web/server/generation-queue.test.mjs`，审查后提交。
2. 前端：web/src/services/api/generation-queue.ts 和测试；任务列表页面接 GET /api/generation/jobs，取消/重试 POST /jobs/:id/cancel 或 retry。顶部导航与画布入口仅在运行时 GENERATION_QUEUE_ENABLED 时显示。cancelJob 携带 prompt_id 防止双卡误取消。采用现有 Antd 组件和主题，先添加行为测试并验证失败再实现。执行定向 Vitest。
3. 部署配置：添加同源 Nginx /api/generation/ HTTP/WS 转发、运行时开关、Docker Compose 示例和部署说明；配置 Origin、两个静态 worker 地址和独立 SQLite 数据卷。更新 AGENTS fork 例外、CHANGELOG、pending-test/todo。
4. 审查：先需求核对再实现质量检查，修复问题；运行后端故障测试和相关前端回归测试，提交版本、打 tag、推送 ROTFEAT fork 分支。
5. 108：备份当前 compose/实例配置，队列空闲后调整两个 Comfy 实例，模型目录共享、输出隔离。部署服务和前端，精确更新 H3 渠道地址（保留所有其他配置、工作流和 revision CAS）。
6. 验收：同源 API、任务列表 UI、提交三项小任务验证两路并行加排队、重启调度服务核对；两项 768p 20 步真实 H3 验证显存/RAM/输出和进度。保存实测结果，报告链接、吞吐量、限制和回滚路径。
