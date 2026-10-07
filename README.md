# compose

集中管理自托管服务的 compose 部署栈。**每个开源项目一个 orphan 分支**，main 只放索引和同步工作流。
部署平台为 Arcane（各 docker 主机）；compose 文件本身平台无关，手动 `docker compose` 也能用。

## 分支索引

| 分支 | 上游项目 | 目标主机 | 对外地址 | 说明 |
|---|---|---|---|---|
| [`firecrawl`](https://github.com/xyonium/compose/tree/firecrawl) | [firecrawl/firecrawl](https://github.com/firecrawl/firecrawl) | dockerno1 | https://firecrawl.savorcare.com | 含 research-proxy / papers-service / pdf-ocr 三个自研配套服务（源码随分支，镜像由分支内 workflow 构建钉版）。2026-09 自 xyonium/firecrawl 的 portainer-stack 分支迁入，历史完整 |
| [`sub2api`](https://github.com/xyonium/compose/tree/sub2api) | [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) | dockerno1 | https://sub2api.savorcare.com | API 网关（上游 compose 在 deploy/docker-compose.yml） |
| [`authentik`](https://github.com/xyonium/compose/tree/authentik) | [goauthentik/authentik](https://github.com/goauthentik/authentik) | docker1 | https://auth.savorcare.com | IdP/SSO（上游 compose 为官方安装文件 goauthentik.io/docker-compose.yml；主镜像写死版本 tag，升级手改 override；traefik 用 docker1 固定证书风格，无 certresolver） |
| [`netbird`](https://github.com/xyonium/compose/tree/netbird) | [netbirdio/netbird](https://github.com/netbirdio/netbird) | docker1 | https://netbird.savorcare.com | VPN + Agent Network（上游无静态 compose：Action source 官方 getting-started.sh 渲染生成，option 1 出 base、option 0 提取 proxy 片段为第二个 upstream 文件；traefik 固定证书风格，proxy 私有模式走 WG 隧道不经 traefik） |

部署细节（项目 env 必填项、切换/回滚方法）都在各分支的 README。

## 分支内文件分工（三文件模式）

| 文件 | 用途 | 谁来改 |
|---|---|---|
| `docker-compose.upstream.yaml` | 上游 compose 原样拷贝 | 只由机器人改 |
| `docker-compose.portainer.yaml` | 全部自定义（镜像 mirror、traefik、网络、卷、启动 patch） | **只手改这个** |
| `docker-compose.yaml` | 预合并产物，主镜像钉 digest，部署平台直接使用 | 只由机器人生成，手改会被覆盖 |

个别分支另有同步的上游参考文件（如 sub2api 分支的 `.env.example`），同样只由机器人改。
netbird 分支在此基础上多一个 `docker-compose.upstream-proxy.yaml`（官方脚本第二种模式
渲染后提取的 proxy 片段，bot 维护；合并输入从两份变三份）和三个渲染参考件
（`config.yaml` 密钥已脱敏 / `dashboard.env` / `proxy.env`）。

为什么预合并成单文件：预合并后任何平台只需要一个 compose 文件即可部署，不依赖各平台对
多文件合并 / additional paths 的支持差异，Arcane、手动 `docker compose` 都一样。
（override 文件名里的 "portainer" 是历史遗留——仓库最早的部署平台是 Portainer，
文件内容与流程已平台无关。）

## 同步机制

- 每个项目分支对应 main 上的一个 `.github/workflows/sync-<branch>.yml`
  （GitHub 定时任务只跑默认分支，所以工作流集中在 main，checkout/推送目标是各自分支）
- **⚠️ 定时调度当前全部刻意注释未启用**。启用方法：编辑对应 workflow 取消 `schedule:` 两行注释；
  手动同步随时可用（Actions 页面选对应 **Sync \* compose** → Run workflow）
- 同步逻辑四步：拉上游 compose → `docker compose config --no-interpolate` 与 override 合并
  → 主镜像钉 digest（镜像更新靠 compose diff 驱动：新 digest → 文件变化 → 平台重建拉新镜像，
  digest 历史留在 git 里可回滚）→ 哨兵校验通过且有变化才提交推送
- 上游做了与 override 不兼容的改动时 Action **失败并通知**，线上保持旧版本不受影响
- 回滚：在分支上 revert 对应 sync commit，平台侧重新部署（digest 历史都在 git 里）

## 部署接入（Arcane）

新建项目，compose 用目标分支的 `docker-compose.yaml`（预合并单文件）。
**密钥和变量一律配在项目 env（.env），不进 git**。
机器人推送更新后按惯例同步到 Arcane 并重建（仓库是 compose 文件的权威来源，
Arcane 里的项目内容以本仓库为准）。

## 新增一个项目分支的 SOP

1. `git checkout --orphan <project> && git rm -rf .`
2. 下载上游 compose 为 `docker-compose.upstream.yaml`
3. 写 `docker-compose.portainer.yaml`（镜像走 `jcr.savorcare.com/{ghcr,docker}/` mirror、
   traefik 接 `reverse-proxy` 外部网络、顶层 `name:` 固定项目名、按需改卷、
   上游的 `env_file: .env` 记得清掉）。
   **traefik 标签按目标主机的风格写**：dockerno1 用 myresolver 泛域名证书；
   docker1 用固定证书文件，只写 `tls=true`，web 入口挂 `http2https` 中间件
4. 本地预合并 + 钉 digest + 校验，生成 `docker-compose.yaml`：
   ```bash
   docker compose -f docker-compose.upstream.yaml -f docker-compose.portainer.yaml \
     config --no-interpolate > docker-compose.yaml
   # 钉 digest 用 docker buildx imagetools inspect 解析后 sed 回写（参考 sync workflow 里的写法）
   ```
5. 写分支 README（文件分工表、项目 env 必填项、自定义摘要），commit，push 分支
6. main 上复制一个现有 sync workflow 改名 `sync-<project>.yml`，按注释改：
   分支名（checkout ref / push）、上游 compose URL、钉版镜像与 digest 解析方式、
   哨兵 token、最终校验用的哑变量（按上游 `:?` 断言）
7. 本 README 索引表加一行
8. 在目标主机的部署平台建项目指过来

## 注意事项

- **ghcr 包权限**：firecrawl 分支的 3 个镜像构建 workflow（push 触发，随分支走）会把镜像推到
  `ghcr.io/xyonium/firecrawl-{pdf-ocr,research-proxy,papers-service}`。这三个 package 是用户命名空间下的
  存量包，需在各自 Package settings → Manage Actions access 里把 `compose` 仓库加为 write，
  否则 workflow 推镜像 403（不推源码改动则不会触发，日常无感）
- 若仓库长期无活动，GitHub 可能自动暂停定时任务（会提前发邮件提醒），重新 enable 即可
