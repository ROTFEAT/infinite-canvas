# 自托管服务器配置

本 fork 提供可选的共享实例配置。启用后，所有访问同一实例的浏览器共享渠道、工作流、模型选择及生成默认值；修改自动保存到服务器持久卷。已打开的其他浏览器通过刷新读取更新，首版不做实时推送。

原 Dockerfile 和默认 Compose 继续使用浏览器本地配置。共享模式需要使用本 fork 构建的前端镜像和配套配置服务，不能只给旧镜像添加环境变量。

## 数据边界

- 共享的是 `AiConfig`，含渠道、工作流、默认模型、尺寸、时长等。
- `apiKey`、渠道的 `apiKey`/`comfyuiProxyToken`、WebDAV 凭据留在浏览器。相同渠道 ID 的端点被修改时，不把原凭据附加到新端点。
- 画布、生成记录、素材、主题和语言不由本服务保存。它们继续使用既有本地存储/WebDAV 功能。
- 工作流 JSON 和脚本按用户原样共享。不要在工作流或 URL 内嵌凭据；字段过滤不能识别任意自定义内容中的秘密。
- 所有能访问该实例的人均可读取和修改共享配置。这是受信任的单实例服务，不是多用户权限系统。

## 部署

默认绑定本机 loopback。若供 Tailscale 内设备访问，把绑定地址设置为服务器 Tailscale 地址，Origin 设置为浏览器实际使用的协议、主机和端口，不带末尾斜杠。

```bash
export CANVAS_BIND_IP=127.0.0.1
export CANVAS_PORT=3000
export INSTANCE_CONFIG_ORIGIN=http://localhost:3000
docker compose -f docker-compose.server-config.yml up -d --build
```

配置服务不向宿主机发布端口，由 Nginx 代理同源 `/api/instance-config`；它没有 CORS 支持。Origin 与请求头检查用于防止跨站写入，不能替代身份认证。公网部署必须在整站反向代理提供认证与 HTTPS，不能直接把此 Compose 暴露公网。

首次启动会提示“使用当前浏览器配置初始化”。服务不会自动用空浏览器的默认配置覆盖服务器。若需导入旧导出的配置，先在原本的浏览器打开该实例并完成初始化，然后使用现有“配置 → 导入配置”功能导入，等待“配置已保存到服务器”。换浏览器只需打开同一地址；有认证的 ComfyUI 渠道仍需在新浏览器设置其本地凭据。

## 保存与冲突

启动时等待读取服务器配置，读取失败则提示重试，不静默回退到旧本地配置。修改后约 500ms 合并保存。保存期间离开页面会触发浏览器标准未保存提示。

网络或服务错误保留本地修改并提示“重试保存”。多个浏览器同时修改时使用 revision 检查：旧版本写入返回 409，界面提示读取服务器版本，并在覆盖本地未保存配置前确认。可以先通过原配置导出功能备份尚未保存的更改，再读取服务器版本、重新应用更改。

首版不自动合并不同浏览器的字段。服务仅运行一个进程/副本来管理一个数据目录，不支持多个服务共享同一卷。

## 持久卷与备份

文件为命名卷 `instance-config-data` 内的 `/data/instance-config.json`，使用临时文件及原子 rename，权限 0600。重建容器时卷仍保留。不要用 `docker compose down -v` 删除该卷。JSON 包含 `version`、`revision` 和 `config`；损坏或不支持的格式返回错误，服务不会重置或覆盖原文件。

可在服务停止后备份/恢复这个卷。备份可能包含私有服务器地址和工作流，勿提交到公共 GitHub 仓库。回退纯前端模式时使用原 Compose；服务器文件保留，原浏览器缓存配置也保留。

## 开发与验证

```bash
# 终端一
CONFIG_DATA_DIR=/tmp/canvas-config-dev INSTANCE_CONFIG_ORIGIN=http://localhost:3000 \
  node web/server/instance-config-server.mjs
# 终端二
cd web
bun install --frozen-lockfile
VITE_SERVER_CONFIG_ENABLED=true bun run dev --host 127.0.0.1
```

配置服务环境变量：`CONFIG_HOST`（默认 `127.0.0.1`）、`CONFIG_PORT`（默认 `3003`）、`CONFIG_DATA_DIR`（默认 `./data`）、`INSTANCE_CONFIG_ORIGIN`（允许写入的精确来源）。Vite 在显式启用时将配置请求代理到 `127.0.0.1:3003`。

```bash
node --test web/server/instance-config-server.test.mjs
cd web
bun run test src/services/api/__tests__/instance-config.test.ts src/components/layout/__tests__/instance-config-gate.test.tsx src/stores/__tests__/use-config-store.test.ts
```

若本机使用 Node 25，Vitest/happy-dom 与实验性原生 localStorage 冲突时，可为测试命令加 `NODE_OPTIONS=--no-experimental-webstorage`。运行容器使用 Node 22。
