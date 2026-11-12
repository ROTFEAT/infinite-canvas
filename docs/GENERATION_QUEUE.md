# 自托管双 GPU 生成队列

本 fork 可选部署同源 `/api/generation` 调度服务。默认静态模式仍直连 ComfyUI。

## 使用

将对应 ComfyUI 渠道的地址改为画布站点的完整同源地址加 `/api/generation`。工作流和生成参数不用修改。顶部「生成队列」按钮会在新标签页打开 `/queue`，画布和创作台均可进入。

任务先写入 SQLite 持久卷，再返回提交成功。两个 worker 各同时执行一个任务，剩余任务先入先出排队。任务页显示分配的 worker、节点进度、错误和结果链接，支持取消与手动重试；每页包括全部活动任务及 100 条历史记录，可翻页找回旧结果。失败任务重试会保留原记录，连续点击同一条记录只创建一个重试子任务；该子任务失败时应在子任务记录上再次重试。

关闭浏览器不取消服务端任务；重新打开任务页可取回结果。画布项目和素材仍是各浏览器本地数据，不会自动跨浏览器同步。节点百分比是现有前端估算；任务页显示当前节点步数，不等于整体进度。

## 部署

参考根目录 `docker-compose.generation-queue.yml`。先创建两个 ComfyUI 实例（相同插件、模型和工作流能力），分别用 `--cuda-device 0` 和 `--cuda-device 1`。**必须共享持久 input 目录**，output、temp、user 目录应各自独立；历史结果链接包含 worker 路由标记，不能随意交换 worker ID。

环境变量：

- `CANVAS_BIND`：私有接口 IP（默认回环地址）。
- `CANVAS_ORIGIN`：浏览器访问的准确 Origin，含端口，无尾斜杠。
- `COMFY_NETWORK`：两个 ComfyUI 所在的 Docker 网络名。
- `GENERATION_WORKERS`：例如 `[{"id":"gpu0","url":"http://comfyui-gpu0:8188"},{"id":"gpu1","url":"http://comfyui-gpu1:8188"}]`。

服务端变量为 `GENERATION_ALLOWED_ORIGIN`、`GENERATION_WORKERS`、`GENERATION_DB_PATH=/data/queue.sqlite`、`GENERATION_PUBLIC_PREFIX=/api/generation`、`PORT=3002`。只允许固定配置的上游，不接受浏览器提供上游 URL。仅一个调度进程可管理此数据库和这组 worker。

前端开启 `SERVER_CONFIG_ENABLED=true`、`GENERATION_QUEUE_ENABLED=true`，Nginx 使用 `nginx.generation-queue.conf`。持久卷保留实例配置与 SQLite 数据；不要使用 `docker compose down -v`。现有部署应复用原有配置卷，勿按示例创建空卷覆盖实例配置。

本服务面向可信私网用户，Origin 校验用于阻止浏览器跨站写入，不是用户身份认证；不要将队列和 ComfyUI 端口直接公开到公网。

## 故障与运维

- 调度器重启：读取 SQLite 后核对 worker queue/history，继续追踪已派发任务，不重新提交。
- worker 离线：保留归属和状态，恢复后再核对，其他可用 worker 继续领任务。
- 已确认接收的任务从 worker 丢失：标为中断，手动重试从头生成，不恢复采样断点。
- **提交结果不确定**：例如请求超时但 worker 可能仍在验证工作流，保持派发中并占住该 worker，禁止直接重试。需先检查该 worker 日志和队列、确认原请求结果；服务不会猜测成功或自动重复生成。这种状态下取消意图会保留，待找到目标任务后精确取消。
- 手动取消只针对任务 ID，完成与取消竞态时保留已完成结果；不会执行无 ID 的全局中断。
- 备份 SQLite 应使用 SQLite 在线备份，或停止调度器后同时备份数据库和 WAL；素材还需单独备份 ComfyUI input/output 目录。
- 运行中修改 worker ID/目录或清除 worker 历史会影响恢复核对；先排空任务并备份。
- 模型文件可共用，但内存和显存并不自动合并。53GiB 主机内存上的 H3 双实例采用 `--cache-none --disable-pinned-memory` 降低主机缓存占用，吞吐量必须实测，不能保证单条生成加速。

## 验证

`node --test web/server/generation-queue.test.mjs` 覆盖双 worker FIFO、重启恢复、延迟接收、失败重试、取消竞态、上游离线、历史分页、WS 进度、上传和 Range 输出路由。前端队列页和取消测试位于 `web/src/pages/queue/__tests__` 与 `web/src/services/api/__tests__`。

部署后检查 `/api/generation/health`、`/api/generation/jobs`、`/queue`；提交多于 worker 数量的测试任务，确认两项执行、其余等待，重启调度器后不重复派发，分别打开结果。真实 H3 验收保持画质参数不变并记录 RAM/显存与完成时间。
