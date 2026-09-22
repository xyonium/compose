# sub2api

这个分支是 Portainer 部署 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) 的专用分支，与 main 完全独立（orphan branch），只包含部署所需文件：

| 文件 | 用途 | 谁来改 |
|---|---|---|
| `docker-compose.yaml` | **预合并生成文件**：上游 compose + Portainer override 合并后的最终结果，且 sub2api 主镜像已按 digest 钉版，Portainer 直接部署它（`${VAR}` 变量保留，仍由 Portainer 的 stack env 注入） | **只由机器人生成**，手改会被覆盖 |
| `docker-compose.upstream.yaml` | 上游 [deploy/docker-compose.yml](https://github.com/Wei-Shaw/sub2api/blob/main/deploy/docker-compose.yml) 的原样拷贝 | **只由机器人改** |
| `docker-compose.portainer.yaml` | 我们的全部自定义（镜像 mirror、traefik、reverse-proxy 网络、项目名固定） | **要调整部署只改这个文件** |

## 自定义内容（相对上游）

- 三个镜像全部走私服 mirror：`jcr.savorcare.com/docker/{weishaw/sub2api,postgres:18-alpine,redis:8-alpine}`
- sub2api 摘掉宿主端口映射（上游默认 `0.0.0.0:8080`），改走 traefik：`https://sub2api.savorcare.com`，
  websecure + web 双 entrypoint，`myresolver` 泛域名证书，容器端口显式钉 8080
- 顶层 `name: sub2api` 固定项目名：数据卷恒为 `sub2api_{sub2api_data,postgres_data,redis_data}`，
  重建 stack 时自动挂回，不随 stack 名变化
- postgres / redis 不暴露宿主端口（上游本就如此）；数据卷保持命名卷（上游默认）

## Portainer 配置

仓库地址 `https://github.com/xyonium/compose.git`，分支 `refs/heads/sub2api`，
Compose path 保持默认的 `docker-compose.yaml`。

### stack env 必填项

| 变量 | 说明 |
|---|---|
| `POSTGRES_PASSWORD` | **必填**，不设 compose 直接拒绝启动（上游 `:?` 断言） |
| `JWT_SECRET` | 强烈建议固定（`openssl rand -hex 32`），否则重启后登录态全失效 |
| `TOTP_ENCRYPTION_KEY` | 用了 2FA 就**必须**固定（`openssl rand -hex 32`），否则重启后所有 TOTP 失效 |
| `ADMIN_PASSWORD` | 首次启动自动建管理员（`ADMIN_EMAIL` 默认 admin@sub2api.local） |
| `REDIS_PASSWORD` | 可选；设上后 redis 开 requirepass，应用侧自动带上 |

其余几十项 `GATEWAY_*` / `SECURITY_*` / OAuth 变量全部有默认值，一般不用动；
要调时参考上游 [deploy/.env.example](https://github.com/Wei-Shaw/sub2api/blob/main/deploy/.env.example)，
**加在 Portainer stack env 里，不要改 compose 文件**。

部署后建议开启 **Automatic updates**（polling 或 webhook），机器人推送后 stack 自动更新。

## 同步机制

同步工作流在 compose 仓库 `main` 分支的 `.github/workflows/sync-sub2api.yml`
（GitHub 定时任务只跑默认分支，所以工作流放 main，操作后推回本分支）。
**⚠️ 定时调度当前刻意注释未启用**——启用方法：到 main 分支把该文件里 `schedule:` 两行的注释去掉
（每月 5 日 03:57 UTC / 北京 11:57，与 firecrawl 错开）；`workflow_dispatch` 手动同步随时可用，
在 Actions 页面选 **Sync sub2api compose** → Run workflow。

同步逻辑：

1. 拉取上游最新 compose → `docker-compose.upstream.yaml`
2. 与本分支的 override 合并（`docker compose config --no-interpolate`）
3. **镜像 digest 钉版**：从 docker.io 解析 `weishaw/sub2api:latest` 的当前 digest 写进生成文件。
   因为 CE 版 Portainer 没有 re-pull image，tag 不变的镜像永远不会自动更新；
   钉 digest 后镜像更新变成 compose 文件的 diff，redeploy 时自然会拉新镜像。
   postgres / redis 是稳定第三方镜像且带版本号 tag，刻意保持浮动不钉。
4. 校验合并结果（自解析 + 关键配置哨兵检查），通过且有变化才提交推送

上游若做了与 override 不兼容的改动（比如删除/重命名某个 service），Action 会**失败并通知**，
stack 保持旧版本不受影响——不会半夜悄悄挂掉。修好后在 Actions 页面手动 Re-run 即可。

回滚：分支上 revert 对应的 sync commit 再让 Portainer redeploy 即可（digest 历史都在 git 里）。

注意：若仓库长期无活动，GitHub 可能自动暂停定时任务（会提前发邮件提醒），重新 enable 即可。
