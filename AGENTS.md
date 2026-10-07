# AGENTS.md — xyonium/compose 维护指南

本仓库集中管理 savorcare.com 体系的容器化部署栈。本文档由 dockerno1 上 Claude Code 时期
的项目 memory 迁移整编（原文归档在 [docs/claude-memory/](docs/claude-memory/)），
后续由 DSH 维护。

## 仓库结构：每项目一个 orphan 分支

- **main**：索引 README + 每项目一个同步 workflow（`sync-firecrawl.yml`、`sync-sub2api.yml`、
  `sync-authentik.yml`）。GitHub Actions 的 schedule 只在默认分支跑，所以同步任务集中在 main。
- **项目 orphan 分支**（`firecrawl`、`sub2api` …）：互相完全独立，只含该项目部署文件。

## 通用约定（所有项目分支适用）

### 三文件模式

| 文件 | 用途 | 谁来改 |
|---|---|---|
| `docker-compose.upstream.yaml` | 上游 compose 原样拷贝 | 只由同步机器人改 |
| `docker-compose.portainer.yaml` | 全部自定义（镜像 mirror、traefik、卷、健康检查放宽等） | **手改只动这个文件** |
| `docker-compose.yaml` | 机器人预合并产物（主镜像钉 digest），部署平台直接消费 | 只由机器人生成，手改会被覆盖 |

### 基础设施

- 镜像一律走私服 mirror `jcr.savorcare.com/{ghcr,docker}/`。注意：**GitHub Actions runners
  无法访问该 mirror**（只有用户主机网络可达），别设计 runner 直连 mirror 的方案。
- traefik 走外部网络 `reverse-proxy`，`*.savorcare.com` 泛域名证书，certresolver `myresolver`。
- 部署平台（Arcane / 原 Portainer CE）**没有 re-pull image**：主镜像必须钉 digest，靠 compose
  diff 驱动更新；稳定的第三方镜像浮动不钉。
- secrets 一律在部署平台的项目 env 里，**不进 git**。
- 部署平台已迁往 **Arcane**：**push ≠ 自动部署**。agent 的 ~2min 轮询只是轻量 sync，不触发部署；
  真正部署靠 GitOps sync 周期（`@every 500m` ≈ 8.3h）或在 Arcane UI 手动点 Sync。agent 消费
  预合并单文件 `docker-compose.yaml`，物化后 compose up。
- 本机直连 github.com 的 git/TLS 偶发握手失败，重试即可；api.github.com 与
  raw.githubusercontent.com 稳定。

## firecrawl 分支

自托管 firecrawl（`firecrawl.savorcare.com`）。布局：三文件 + 三个自研服务目录
（`research-proxy/`、`papers-service/`、`pdf-ocr/`，各自有 README）+ 三个镜像构建
workflow（推 `ghcr.io/xyonium/firecrawl-*`，用户命名空间 package，需给本仓库授 write）。

> 历史：本分支带 37 提交历史自旧仓库 xyonium/firecrawl 迁入（回滚链未断）。
> **旧 firecrawl 仓库将退役，一切引用以本仓库 firecrawl 分支为准。**

关键事实：

- **firecrawl-mcp 不构建自本地源码**，是上游镜像 + compose command 里 `node -e` 运行时
  patch dist（禁用云专有的 find_tools/Alexandria 引导、裁剪工具描述等 13 处删减型 patch，
  锚点漂移即静默跳过、永不 crash）。改 patch 必须遵守下面的双层验证清单。
- **rabbitmq 健康检查已放宽**：冷启动实测 ~27s，超过上游 ~20s 窗口会导致 api 停 created；
  overlay 放宽为 start_period 30s / retries 12。
- **三构建 workflow 并发撞车**：单次 push 同时改 3 个 workflow 文件会三路并发构建，pin-commit
  push 互相拒绝 → 串行 `gh run rerun <id>` 恢复即可（缓存命中，重跑很快）。
- 上游演进方向：nuq 队列引擎引入 FoundationDB 可选后端（默认 pg）；api 容器由
  harness.js 一把梭（无独立 worker 服务）。
- 研究栈（research-proxy shim 桥接 papers-service + reach-mcp(mcpo) + GitHub API；
  papers-service 替代 paper-search-mcp；pdf-ocr 转发自托管 MinerU）完整演进史与实测结论见
  [docs/claude-memory/paper-search-de-mcpo-plan.md](docs/claude-memory/paper-search-de-mcpo-plan.md)。

### mcp patch 双层验证清单（踩过两次坑，必须遵守）

firecrawl-mcp 的启动 patch 藏在 `node -e '...'` 单引号体里，改后必须两层都验：

1. **JS 逻辑层**：在钉版镜像的 dist 副本上跑 patch 片段，验证锚点唯一、ESM 语法、幂等。
2. **compose/sh 传递层**：用 `python3 yaml.safe_load` 直读 YAML 提取**完整 command 串**
   （`docker compose config` 会把字面 `$` 显示成 `$$`，不能当真实值），模拟
   `$$X→$X`、未定义 `${VAR}→空` 后再验证锚点仍匹配，最后在钉版镜像 + 全新 dist 上真实启动
   并验证 tools/list。

禁区：单引号体内**禁撇号**（can't/don't 也不行）、禁反引号；patch 锚点里任何 `${...}`
形态必须写成 `$${...}`（否则被 compose 插值清空、静默不匹配）。

## sub2api 分支

部署上游 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)
（`https://sub2api.savorcare.com`）。三文件模式同上，另多一个机器人维护的 `.env.example`
（上游原样拷贝，查变量的权威参考）。自定义：镜像全走 mirror、摘宿主端口改走 traefik、
顶层 `name: sub2api` 固定项目名（数据卷恒为 `sub2api_*`，重建自动挂回）。
上游的 `docker-compose.local.yml`（绑定挂载变体）**刻意不跟踪**。

部署平台项目 env **必填**三个安全凭据（上游 docker-deploy.sh 原本交互生成，平台部署
没有这一步，必须自己生成）：`openssl rand -hex 32` × 3 ——
`POSTGRES_PASSWORD`（不设直接拒启动）、`JWT_SECRET`（不固定则重启后登录态全失效）、
`TOTP_ENCRYPTION_KEY`（不固定则重启后所有 2FA 失效）。明细见该分支 README 凭据表。

## 参考档案

- [docs/claude-memory/](docs/claude-memory/) — Claude Code 时期的 4 份项目 memory 原文
  （仓库约定、firecrawl 部署体系、mcp patch 清单、paper-search 去 mcpo 计划）
- [docs/superpowers/specs/2026-09-22-compose-repo-design.md](docs/superpowers/specs/2026-09-22-compose-repo-design.md) — 本仓库初始设计稿
