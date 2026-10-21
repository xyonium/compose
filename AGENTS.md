# AGENTS.md — xyonium/compose 维护指南

本仓库集中管理公司基础设施的容器化部署栈（域名、主机名已脱敏）。本文档由 Claude Code
时期的项目 memory 迁移整编（原文归档在 [docs/claude-memory/](docs/claude-memory/)），
后续由 DSH 维护。

## 安全原则（2026-10 起，全分支强制）

**域名、registry 主机名、真实 IP/网段、内网主机名一律不入库。** 任何分支新增
compose/文档/workflow 前先过这一关：

1. **env 化是默认**：部署时才知道的值（外部域名、私服 registry、证书目录、WG 端口等），
   在 `docker-compose.portainer.yaml` 里写成 `${VAR}`，由部署平台项目 env 注入；
   分支 README 放凭据表列出。机器人 sync 时 `--no-interpolate` 保留模板
   （范式见 netbird 分支及其 README 的 5 env 表）。
2. **文档用占位符**：人类读的 README/spec/历史文档里，域名一律写
   `*.example.com`（RFC 2606），registry 写 `${JCR_REGISTRY}` 或泛称「私服 mirror」,
   主机名写「部署主机/边界防火墙」。历史文档出现真实域名是旧账，改到就顺手洗掉。
3. **leakage gate 兜底**：每个 sync workflow 最后必须有
   `git grep -niE '<真实域名词干>|<其他公司标识>'`（或同类串）失败即拒提交；新分支
   sync 从 [sync-netbird.yml](.github/workflows/sync-netbird.yml) 抄这一步（实际串
   在该 workflow 里，别入库进本文档——文档自身也要能过同一 gate）。
4. **sync 只走 workflow_dispatch**：项目分支 push **不会**触发任何 GH Action
   （定时全注释，netbird 分支无 build workflow），推送零自动化副作用；要跑 sync 在
   对应 main 分支手动 `gh workflow run sync-<branch>.yml`，跑完看 leakage gate 是否绿。
5. **上报即修复**：任何 agent 在自己产生的文件里写出真实域名/真实 IP/私仓域名，
   视为事故，本次会话内整改 + 在 commit message 里点名。

> 已全部按此原则完成清洗重建（均单 commit 起点、旧历史销毁、仅 backup bundle 保留）：
> **netbird**（2026-10-20，5 env 化 `NETBIRD_DOMAIN` / `JCR_REGISTRY` / `NETBIRD_CERT_DIR` / `NB_PROXY_TOKEN` / `NB_RELAY_AUTH_SECRET`，
> 分支无 build workflow，`getting-started.sh` 渲染时渲染两次 + leakage 总闸 + byte-diff 验证）；
> **authentik**（2026-10-20，2 env 化 `AUTHENTIK_DOMAIN` / `JCR_REGISTRY`，
> workflow 一次干跑即绿、插值 byte-diff 逐字节一致）；
> **firecrawl**（2026-10-21，3 env 化 `FIRECRAWL_DOMAIN` / `JCR_REGISTRY` / `MINERU_BASE_URL`，
> 外加 3 个自研服务 build workflow 镜像行 env 化 + 本地 leakage gate；
> 4 base 镜像 digest 故意冻结在部署值、升级留给 pin_mode=latest 的受控运行；
> mcp patch 新旧脚本 A/B 验证产物字节一致）；
> **sub2api**（2026-10-21，2 env 化 `SUB2API_DOMAIN` / `JCR_REGISTRY`，certresolver 去旧账改 `tls=true + http2https`，
> 首次 keep sync 验证 runner 产物与预期 digest `411d9ca5...` 一致、byte-diff 只剩上游语义差）。

### 迁移踩坑清单（netbird 2026-10-20 实战）

workflow_dispatch 实跑 5 次才跑通，这些是推给下一个分支前**必须先对齐**的点：

1. **上游 `getting-started.sh` 对 example.com 有黑名单**——改用
   `netbird.your-domain.example` 这类带私域子域的占位（仍属 RFC 占位语义）。
2. **shell 哨兵 loop 里含 `${VAR}` 的 needle 必须单引号**——`set -u` 下双引号
   字符串里的 `${}` 会被 shell 展开成 `unbound variable`。
3. **bind 路径插值是 compose-go 的 bug**（`paths/resolve.go:113`）：长语法
   `type: bind` 的 `source: ${VAR}` 在归一化时被误判为相对路径拼 cwd；短语法
   `${VAR}:/path:ro` 则被归一化成 named volume。**唯一可用形态是长语法
   `source: /${VAR}`**——`IsAbs=true` 避开拼接，部署展开成 `//etc/...`（linux
   容忍双斜杠）。部署平台 env 值**必须不带前导 `/`**。分支 README 凭据表必须
   单独注明值格式。
4. **末尾 smoke test 不能用 `docker compose config`**——它会对 bind 源路径做
   存在性检查，runner 上没有 `${VAR}` 指向的真实目录。改 python 三件套：YAML 结构
   + 镜像 pin 数 + env 模板保留（见 sync-netbird.yml 末尾段）。
5. **LE email 黑名单同款问题**：`ops@example.com` 也可能触发上游校验；netbird
   用 `ops@your-domain.example`。
6. **首次 sync 前必须 dry-run一次 workflow_dispatch**——push ≠ 实测的坑（交互
   脚本行为、shell 展开、compose 路径归一化）只有 runner 环境才暴露，前 4 次失败
   是常态，按日志逐个 fix。
7. **byte-diff 部署前金标准**：sync 成功后，本地把新 `docker-compose.yaml` 按
   真实 env 插值（CERT_DIR 注意 `/${VAR}` 展开得 `//etc/...`，先
   `.replace('//', '/')`），与改造前旧产物做 `difflib.unified_diff`。**只剩
   digest 变化和 YAML 序列化风格差（空行/折行/字段顺序）才可部署**。

迁移顺序建议（netbird、authentik、firecrawl 已完成）：**sub2api**。

firecrawl 分支迁移时的增补教训（2026-10-21）：

8. **digest 冻结策略**：清洗当天发现 4 个 base 镜像 digest 全部漂移——不要顺手升级
   （升级=独立变更事件）。首次手写 merged 产物时沿用部署 digest；sync 工作流加
   `pin_mode` 输入（`latest`=升级通道 / `keep`=保留合并产物既有 digest 只验证合并）。
9. **leakage gate 写进分支 workflow 时会自匹配**：gate 的 `git grep` 也扫 workflow
   文件自身，真实串 pattern 必须用 `[s]avorcare` 这类字符类自排除写法。
10. **钉版回写对 `docker-compose.yaml` 要幂等从容**：build workflow 钉自研镜像时，
    merged 产物可能过渡性没有该镜像的模板行（清洗重建时手写）——assert lit in text
    只对 portainer（权威文件）硬失败，merged 缺行则交给 main 的 sync 重建兜底。
11. **node -e patch 里嵌 env 表达式时想清楚求值时机**：写进 dist 的是 patch 进程
    实参求值结果（容器启动时 env 已注入）——表达式**不要包在字符串里**，否则
    dist 明文落 `process.env.X` 而描述在 runtime 才取值，两种写法 A/B diff 验证
    时确认目标形态。
12. **sync latest 首次运行必暴露 patch anchor drift**：底座 freeze 期累计的上游
    mcp-server 版本漂移不一定在 pin digest 时会全部命中 13 锚点——脚本按设计静默
    跳过（`Patched [...]` 数组名变短就差在 `cloud-only strip 没生效`），不要当
    成功。跑完一定要抽 dist 验关键字符串（`Keyless sessions get no Alexandria`
    `firecrawl_find_tools` `research_passages describe` 等）；漂移就 revert 该
    latest commit、单独开案改 patch 并重 A/B 验。

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

- **镜像一律走私服 mirror**，registry 主机名按[安全原则](#安全原则2026-10-起全分支强制)
  走 `${JCR_REGISTRY}` env（迁移中的分支暂写真实主机名，迁移完成必须 env 化）。
  **GitHub Actions runners 无法访问该 mirror**（只有用户主机网络可达），别设计 runner
  直连 mirror 的方案；bot 钉 digest 时从 docker.io 原 repo 解析，写回 mirror 镜像行。
- traefik 走外部网络 `reverse-proxy`，使用部署主机同步的泛域名证书（`tls=true`
  固定证书风格，无 certresolver；遗留文字里的 certresolver `myresolver` 属旧账）。
- 部署平台（Arcane / 原 Portainer CE）**没有 re-pull image**：主镜像必须钉 digest，靠 compose
  diff 驱动更新；稳定的第三方镜像浮动不钉。
- secrets 一律在部署平台的项目 env 里，**不进 git**。
- 部署平台已迁往 **Arcane**：**push ≠ 自动部署**。agent 的 ~2min 轮询只是轻量 sync，不触发部署；
  真正部署靠 GitOps sync 周期（`@every 500m` ≈ 8.3h）或在 Arcane UI 手动点 Sync。agent 消费
  预合并单文件 `docker-compose.yaml`，物化后 compose up。
- 本机直连 github.com 的 git/TLS 偶发握手失败，重试即可；api.github.com 与
  raw.githubusercontent.com 稳定。

## firecrawl 分支

自托管 firecrawl（对外域名按安全原则走 env，不入库）。布局：三文件 + 三个自研服务目录
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

部署上游 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)（对外域名
走 env，不入库）。**2026-10-21 安全清洗重建（单 commit 起点）**：域名走
`${SUB2API_DOMAIN}`、registry 走 `${JCR_REGISTRY}`，证书风格对齐 `tls=true + http2https`
（certresolver 去旧账）。三文件模式同上，另多一个机器人维护的 `.env.example`
（上游原样拷贝，查变量的权威参考）。自定义：镜像全走 mirror、摘宿主端口改走 traefik、
顶层 `name: sub2api` 固定项目名（数据卷恒为 `sub2api_*`，重建自动挂回）。

部署平台项目 env **必填**三个安全凭据（上游 docker-deploy.sh 原本交互生成，平台部署
没有这一步，必须自己生成）：`openssl rand -hex 32` × 3 ——
`POSTGRES_PASSWORD`（不设直接拒启动）、`JWT_SECRET`（不固定则重启后登录态全失效）、
`TOTP_ENCRYPTION_KEY`（不固定则重启后所有 2FA 失效）。明细见该分支 README 凭据表。

## netbird 分支

NetBird 全功能（VPN 管理 + Agent Network Beta）。**分支经安全清洗重建（2026-10，
单 commit 起点）**：域名、拓扑、IP、主机名一律不入库，占位域名为
`netbird.example.com`，真实域名部署时走项目 env `${NETBIRD_DOMAIN}`。三文件模式的
变体（四文件），上游同步机制与其他分支不同：

- **上游无静态 compose**：`sync-netbird.yml` source 官方 `getting-started.sh`
  （`sed` 去掉末尾 `init_environment` 入口）只调渲染函数生成文件——不起容器、不部署。
  渲染两次：option 1（外部 traefik）出 `docker-compose.upstream.yaml`；
  option 0+proxy 出完整栈，yq 提取 proxy 服务为 `docker-compose.upstream-proxy.yaml`。
  proxy 定义因此始终跟踪上游，非手抄。**渲染用占位域名**——上游产物天然脱敏；
  bot 步骤末尾有 leakage gate 总闸（见安全原则第 3 条）。
- **域名/私仓/证书路径全 env 化**：override 把上游 4 组 traefik router label 按同 key
  全覆盖为 `` Host(`${NETBIRD_DOMAIN}`) ``；4 个镜像走 `${JCR_REGISTRY}`；泛域名证书
  目录走 `${NETBIRD_CERT_DIR}`。合并产物 `--no-interpolate` 保留模板，由部署平台
  项目 env 注入。**平台项目 env 必填 5 个**：`NETBIRD_DOMAIN` / `JCR_REGISTRY` /
  `NETBIRD_CERT_DIR` / `NB_PROXY_TOKEN` / `NB_RELAY_AUTH_SECRET`（详见分支 README 凭据表）。
- **密钥外置**：`config.yaml` 三个随机密钥洗成占位符入库（上游不支持 env 展开），
  真实文件由 `scripts/bootstrap-config.py <真实域名>` 全域替换占位域名后灌
  `netbird_config` 命名卷；`NB_PROXY_TOKEN` 两阶段 bootstrap（先部署再
  `admin token create` 换真 token）。
- traefik 固定证书风格（渲染时 `NETBIRD_TRAEFIK_CERTRESOLVER=` 留空，只出 `tls=true`）；
  override 只补 web 入口 `http2https` 跳转。
- proxy 私有模式（`NB_PROXY_PRIVATE=true`）：**无任何 traefik 路由**，agent 流量走
  WireGuard 隧道直连 proxy（身份=WG 源 IP 映射）；TLS 用 `${NETBIRD_CERT_DIR}` 泛域名
  证书 bind 进 `/wildcard-certs`。ACME/pp-v2 都关闭。
- 反向哨兵是重点：合并产物不得出现 `./config.yaml` bind、内建 traefik、certresolver、
  `HostSNI(*)`、pp-v2、env_file、`NETBIRD_AGENT_NETWORK_ONLY`、任何真实域名。

## 参考档案

- [docs/claude-memory/](docs/claude-memory/) — Claude Code 时期的 4 份项目 memory 原文
  （仓库约定、firecrawl 部署体系、mcp patch 清单、paper-search 去 mcpo 计划）
- [docs/superpowers/specs/2026-09-22-compose-repo-design.md](docs/superpowers/specs/2026-09-22-compose-repo-design.md) — 本仓库初始设计稿
