# authentik

这个分支是部署 [goauthentik/authentik](https://github.com/goauthentik/authentik)（IdP/SSO）
的专用分支，与 main 完全独立（orphan branch），只包含部署所需文件：

| 文件 | 用途 | 谁来改 |
|---|---|---|
| `docker-compose.yaml` | **预合并生成文件**：上游 compose + 平台自定义层合并后的最终结果，server/worker 主镜像已按 digest 钉版，部署平台直接使用它（`${VAR}` 变量保留，由平台的项目 env 注入） | **只由机器人生成**，手改会被覆盖 |
| `docker-compose.upstream.yaml` | 上游官方安装文件 <https://goauthentik.io/docker-compose.yml> 的原样拷贝 | **只由机器人改** |
| `docker-compose.portainer.yaml` | 我们的全部自定义（镜像 mirror、traefik、reverse-proxy 网络、卷、项目名固定） | **要调整部署只改这个文件** |

部署目标：**docker1**，经 traefik 反代到 `https://auth.savorcare.com`。

## 自定义内容（相对上游）

- 镜像全部走私服 mirror：`jcr.savorcare.com/ghcr/goauthentik/server`、
  `jcr.savorcare.com/docker/library/postgres:16-alpine`
- **主镜像写死版本 tag（当前 2026.8.3）**：authentik 是有状态服务，大版本升级必须先看
  [上游 release notes](https://docs.goauthentik.io/docs/releases/)，升级方法见下文「升级」
- server 摘掉宿主端口映射（上游默认 `9000`/`9443`），改走 traefik：
  `https://auth.savorcare.com`，**docker1 风格**——websecure 入口已全局 TLS + 固定证书文件，
  路由只写 `tls=true`，不写 certresolver；web 入口挂 `http2https` 跳转中间件
  （docker1 的 traefik 栈已定义）；容器端口显式钉 9000
- 清掉三个服务的 `env_file: .env`：仓库里没有这个文件（上游 compose 面向手动部署），
  变量一律由部署平台的项目 env 注入；留着它 `docker compose config` 会因找不到文件报错
- `./data` 绑定挂载转命名卷 `data`（server/worker 共享，实际卷名恒为 `authentik_data`）；
  `./custom-templates`、`./certs` 两个挂载去掉（自定义模板/证书需要时改 override 加回）；
  worker 的 `/var/run/docker.sock` 保留（上游默认，managed outpost 要用）
- 顶层 `name: authentik` 固定项目名：数据卷不随平台项目名变化，重建项目自动挂回
- postgresql 保持上游：命名卷 `database`、healthcheck、`POSTGRES_PASSWORD` 的 `:?` 断言
- 2026 版起上游已无 redis，共三服务：postgresql / server / worker

## 部署配置（Arcane）

新建项目，compose 用本分支的 `docker-compose.yaml`；变量配在项目 env（.env）里，不进 git。

### 项目 env 必填项

上游对两个变量有 `:?` 断言，不设 compose 直接拒绝启动。生成方式均为 `openssl rand -hex 32`：

| 变量 | 说明 |
|---|---|
| `PG_PASS` | **必填**，postgresql 超级用户密码 |
| `AUTHENTIK_SECRET_KEY` | **必填**，authentik 加密密钥（session/凭据加密），丢失 = 所有加密数据不可解，务必备份 |
| `PG_DB` / `PG_USER` | 可选，默认都是 `authentik` |
| `AUTHENTIK_EMAIL__HOST` 等 | 可选，SMTP 系列（找回密码邮件），全量变量见[上游文档](https://docs.goauthentik.io/docs/install-config/install/docker-compose) |

### 初始管理员

首启后访问 `https://auth.savorcare.com/if/flow/initial-setup/` 按官方引导创建 admin。

### 升级

1. 看上游 [release notes](https://docs.goauthentik.io/docs/releases/) 确认无跨版本注意事项
2. 改 `docker-compose.portainer.yaml` 里两处 `2026.8.3` → 新版本，push
3. 手动跑一次同步 workflow（Actions → **Sync authentik compose** → Run workflow），
   bot 重新合并并按新 tag 钉 digest 推回（`docker-compose.yaml` 是 bot 产物，
   只改 override 不跑同步的话线上文件不会变）
4. 平台侧按惯例同步项目并重建

## 同步机制

同步工作流在 compose 仓库 `main` 分支的 `.github/workflows/sync-authentik.yml`
（GitHub 定时任务只跑默认分支，所以工作流放 main，操作后推回本分支）。
**⚠️ 定时调度当前刻意注释未启用**——启用方法：到 main 分支把该文件里 `schedule:` 两行的
注释去掉；`workflow_dispatch` 手动同步随时可用。

同步逻辑：拉上游 compose → 与 override 合并 → 从合并产物提取当前 tag，按
`ghcr.io/goauthentik/server:<tag>` 解析 digest 钉版 → 哨兵校验 → 有变化才提交推回。
上游做了与 override 不兼容的改动时 Action **失败并通知**，线上保持旧版本不受影响。
回滚：在本分支 revert 对应 sync commit，平台侧重新部署（digest 历史都在 git 里）。
