# sub2api

这个分支是部署 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) 的专用分支，
与 main 完全独立（orphan branch），只包含部署所需文件。**分支 2026-10 安全清洗重建
（单 commit 起点）**：域名、registry 主机名一律不入库——下文以 `sub2api.example.com`
指代访问域名、`${JCR_REGISTRY}` 指代私服镜像 mirror 主机名，真实值部署时由平台项目
env 注入。

| 文件 | 用途 | 谁来改 |
|---|---|---|
| `docker-compose.yaml` | **预合并生成文件**：上游 compose + 平台自定义层合并后的最终结果，sub2api 主镜像已按 digest 钉版，部署平台直接使用它（`${VAR}` 变量保留，由平台的项目 env 注入） | **只由机器人生成**，手改会被覆盖 |
| `docker-compose.upstream.yaml` | 上游 [deploy/docker-compose.yml](https://github.com/Wei-Shaw/sub2api/blob/main/deploy/docker-compose.yml) 的原样拷贝 | **只由机器人改** |
| `docker-compose.portainer.yaml` | 我们的全部自定义（镜像 mirror、traefik、reverse-proxy 网络、项目名固定） | **要调整部署只改这个文件** |
| `.env.example` | 上游 [deploy/.env.example](https://github.com/Wei-Shaw/sub2api/blob/main/deploy/.env.example) 的原样拷贝，全部变量的权威参考——查变量看它，不用翻上游 | **只由机器人改**（随同步更新） |

上游另有 `docker-compose.local.yml`（绑定挂载 `./data` 等宿主目录的变体，配
`docker-deploy.sh` 交互式部署用，脚本里的 `mkdir -p data postgres_data redis_data`
就是为那个文件建的目录），**本分支不跟踪它**——命名卷版才是平台部署场景的对应文件。

部署目标：**部署主机**，经 traefik 反代到 `https://${SUB2API_DOMAIN}`
（本文示例写作 `sub2api.example.com`）。

## 自定义内容（相对上游）

- 三个镜像全部走私服 mirror：`${JCR_REGISTRY}/docker/{weishaw/sub2api,postgres:18-alpine,redis:8-alpine}`（registry 主机名走项目 env）
- sub2api 摘掉宿主端口映射（上游默认 `0.0.0.0:8080`），改走 traefik：
  `https://${SUB2API_DOMAIN}`，**部署主机风格**——websecure 入口已配泛域名证书文件，
  路由只写 `tls=true`，不写 certresolver；web 入口挂 `http2https` 跳转中间件
  （部署主机的 traefik 栈已定义）；容器端口显式钉 8080
- 顶层 `name: sub2api` 固定项目名：数据卷恒为 `sub2api_{sub2api_data,postgres_data,redis_data}`，
  重建项目时自动挂回，不随项目名变化
- postgres / redis 不暴露宿主端口（上游本就如此）；数据卷保持命名卷（上游默认）

## 部署配置（Arcane）

新建项目，compose 用本分支的 `docker-compose.yaml`；变量配在项目 env（.env）里，不进 git。

### 项目 env

| 变量 | 说明 |
|---|---|
| `SUB2API_DOMAIN` | **必填**，对外访问域名。compose 内 2 条 traefik Host 路由（websecure 主路由 + web 跳转路由）由它派生 |
| `JCR_REGISTRY` | **必填**，私服镜像 mirror 主机名。**只写主机名**（不带协议不带路径）；3 个镜像 ref 为 `${JCR_REGISTRY}/docker/…` |
| `POSTGRES_PASSWORD` | **必填**（上游 `:?` 断言，不设拒绝启动）；`openssl rand -hex 32` 生成 |
| `JWT_SECRET` | 强烈建议固定，否则重启后登录态全失效；`openssl rand -hex 32` 生成 |
| `TOTP_ENCRYPTION_KEY` | 用了 2FA 就**必须**固定，否则重启后所有 TOTP 失效；`openssl rand -hex 32` 生成 |
| `ADMIN_PASSWORD`（及 `ADMIN_EMAIL`） | 首次启动自动建管理员账号；**自己显式设上，别依赖上游默认值**（上游在加固这块，默认行为随版本变化） |
| `REDIS_PASSWORD` | 可选；设上后 redis 开 requirepass，应用侧自动带上 |

注意：上游的 [docker-deploy.sh](https://github.com/Wei-Shaw/sub2api/blob/main/deploy/docker-deploy.sh)
有一步交互式引导，用 `openssl rand -hex 32` 自动生成上表三个安全凭据
（"Generated secure credentials"）。**平台部署没有这一步——这三个值必须自己生成好填进
项目 env**，生成方式与上游一致。

其余几十项 `GATEWAY_*` / `SECURITY_*` / OAuth 变量全部有默认值，一般不用动；
要调时查本分支的 `.env.example`，**加在项目 env 里，不要改 compose 文件**。

机器人推送更新后按惯例同步到 Arcane 并重建。

## 同步机制

同步工作流在 compose 仓库 `main` 分支的 `.github/workflows/sync-sub2api.yml`
（GitHub 定时任务只跑默认分支，所以工作流放 main，操作后推回本分支）。
**只走 workflow_dispatch 手动触发**——分支 push 不会触发任何自动化，定时调度刻意注释
（如需启用：到 main 分支把该文件 `schedule:` 两行取消注释，每月 5 日 03:57 UTC /
北京 11:57，与其他 sync 错开）。

工作流有一个 `pin_mode` 输入：

- `latest`（默认，升级通道）：解析 `weishaw/sub2api:latest` 当前 digest 钉版
- `keep`：保留生成文件里既有 digest，只做合并与校验——清洗重建、override 调整等
  「不升级只验证」的场景用它

同步逻辑：拉上游 compose + `.env.example` → 与 override `--no-interpolate` 合并
（`${VAR}` 模板保留）→ 按 pin_mode 从 docker.io 解析/保留 digest 钉版 → 哨兵校验
（含 leakage 总闸：任何文件残留真实域名/公司标识即失败，实际 pattern 定义在 workflow
里，不入库）→ 有变化才提交推回。

上游若做了与 override 不兼容的改动（比如删除/重命名某个 service），Action 会
**失败并通知**，线上保持旧版本不受影响——不会半夜悄悄挂掉。修好后在 Actions 页面
手动 Re-run 即可。

回滚：在本分支 revert 对应的 sync commit，平台侧重新部署即可（digest 历史都在 git 里）。
