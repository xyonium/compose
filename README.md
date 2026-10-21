# firecrawl

这个分支是部署 firecrawl 的专用分支，与 main 完全独立（orphan branch），只包含部署所需文件。现居 [xyonium/compose](https://github.com/xyonium/compose) 仓库。

> **分支经安全清洗重建（2026-10，单 commit 起点）**：域名、registry 主机名、内网
> 主机名一律不入库——对外域名走 `${FIRECRAWL_DOMAIN}`，私服 mirror 走
> `${JCR_REGISTRY}`，MinerU 地址走 `${MINERU_BASE_URL}`，真实值全部由部署平台
> 项目 env 注入（见下方凭据表）。清洗前历史（含 2026-09 自 xyonium/firecrawl 迁入的
> digest 链）已销毁，仅 backup bundle 留存仓库 backups/（不进 git）。

| 文件 | 用途 | 谁来改 |
|---|---|---|
| `docker-compose.yaml` | **预合并生成文件**：上游 compose + 平台自定义层合并后的最终结果，且 firecrawl 系镜像已按 digest 钉版，部署平台直接使用它（`${VAR}` 变量保留，由平台的项目 env 注入） | **只由机器人生成**，手改会被覆盖 |
| `docker-compose.upstream.yaml` | 上游 [firecrawl/firecrawl](https://github.com/firecrawl/firecrawl) 的原样拷贝 | **只由机器人改** |
| `docker-compose.portainer.yaml` | 我们的全部自定义（镜像源、restart、traefik、reverse-proxy 网络、api 启动 patch、数据卷） | **要调整部署只改这个文件** |
| `research-proxy/` | research 上游 shim 源码（FastAPI）：桥接 papers-service（/papers/*）+ reach-mcp（/reach/read_url，mcpo）+ GitHub API，让 cloud-only 的 research papers / similar / read / code search 端点自托管可用。镜像由本分支的 `research-proxy-image` workflow 构建到 ghcr 并把 digest 钉回 compose | 手改源码，推送后自动出图+钉版 |
| `papers-service/` | paper-search-mcp 的替代（FastAPI，端口 3200）：research-proxy 的 /papers/* 上游。检索直连公开学术 API（镜像构建时打进 [paper-search](https://github.com/xyonium/paper-search) 仓库 tool.py 的全部直连适配器，含 scholar 三级链），read 轻量直连，读不了 404 由 shim 落 reach-mcp。镜像由 `papers-service-image` workflow 构建+钉版 | 手改源码，推送后自动出图+钉版；tool.py 升级后手动 workflow_dispatch |
| `pdf-ocr/` | PDF OCR 适配器源码（FastAPI）：实现 RunPod MU serverless 契约，转发到自托管 MinerU，让扫描件/图片型 PDF 走自己的 GPU。镜像由 `pdf-ocr-image` workflow 构建+钉版 | 手改源码，推送后自动出图+钉版 |

### research-proxy 速览

- api 服务设 `RESEARCH_PROXY_URL=http://research-proxy:3100` 后才会挂载
  `/v2/search/research/*` 与 `/v2/search/developer` 路由；MCP 的 research 工具组与
  search 的 `developer` category 全部走它
- 需在项目 env 配：`GITHUB_TOKENS`（逗号分隔多 token 轮询，code search
  10 req/min/token）、`SEMANTIC_SCHOLAR_API_KEY`（可选但强烈建议，否则 S2 易 429）
- `/papers/*` 上游走本栈 papers-service（`PAPERS_BASE_URL` 默认
  `http://papers-service:3200`）；`/reach/read_url` 仍走 mcpo（`REACH_BASE_URL` 默认
  `http://mcpo:8000`，经共享网络 `reverse-proxy` 访问）
- 细节见 `research-proxy/README.md`

### papers-service 速览

- paper-search-mcp 已于 2026-09 退役：research-proxy 的 `/papers/*` 上游从 mcpo 切到
  本服务（形状完全一致，shim 只换 base URL）。mcpo 上只剩 reach-mcp 还在用
- 检索复用 paper-search 仓库 tool.py 的 19 个直连源（构建时打进镜像，与 OWUI 工具同源
  同版本）；read 覆盖 arxiv/semantic/pubmed/pmc/europepmc/hal/crossref/openalex/iacr，
  其余 404 → shim 自动落 reach
- stack env 可配（全可选）：`SEMANTIC_SCHOLAR_API_KEY` `NCBI_API_KEY` `CORE_API_KEY`
  `IEEE_APIKEY` `ZENODO_ACCESS_TOKEN` `ZHIHUIYA_APIKEY`，以及 scholar 链用的
  `FIRECRAWL_BASE_URL`/`TAVILY_BASE_URL`/`APIFY_ROTATOR_BASE_URL`（默认值已指向
  mcpo/api-key-rotator，通常不用动）
- 细节见 `papers-service/README.md`

### pdf-ocr 速览

- firecrawl 的扫描件 OCR 只会说 RunPod MU 契约且 URL 硬编码 `api.runpod.ai/v2/`；
  api 启动 sed 把它改指 `http://pdf-ocr:3200/runpod/v2/`，本服务适配到 MinerU `/file_parse`
- 只在"需要 OCR"时被调用（扫描件/图片型 PDF，<19MB）；文本型 PDF 走容器内 Rust 提取，不经过它
- 适配器任何失败都返回 502 → firecrawl 自动降级容器内 pdf-parse，行为安全
- 细节见 `pdf-ocr/README.md`

## 环境变量：超越上游文档的实战理解

上游 `.env.example` 只说了"是什么"，以下是本栈实测出来的"到底怎么配"：

| 变量 | 实战理解 |
|---|---|
| `PARSE_UPLOAD_REF_SECRET` | 两阶段 parse 上传（`/v2/parse/upload-url` → PUT → `/v2/parse?uploadRef=`）的 HMAC 签名密钥。**不配则 upload-url 报错，但 multipart 直传 `/v2/parse` 不需要它**。本栈 api 容器 `ENV=local`（上游 compose 默认值），解锁了内存 storage driver，无需 GCS；签名 ref 结构为 `base64(json).hmac`，含 50MB 上限与过期时间。已实测全流程可用 |
| `PDF_RUST_EXTRACT_ENABLE` | 上游默认**不开**（stringbool）。本栈默认 `true`：用镜像内的 firecrawl-rs 原生 Rust 提取文本型 PDF，质量优于 pdf-parse 兜底 |
| `RUNPOD_MU_API_KEY` / `RUNPOD_MU_POD_ID` | **只需非空占位值**（默认 `local`）。真正生效的是 api 启动命令里的 sed：把 dist 里硬编码的 `https://api.runpod.ai/v2/` 改指本栈 pdf-ocr；Bearer 被适配器直接忽略 |
| `MINERU_BASE_URL` / `MINERU_BACKEND` | pdf-ocr 的上游：自托管 MinerU 地址与 backend（默认 `pipeline`）。`MINERU_BASE_URL` **无默认（必填）**——真实主机名不入库，由项目 env 注入；为空则 OCR 全 502 降级 pdf-parse，pdf-ocr 启动日志有 warning |
| `PDF_MU_V2_*` | **别配**。上游 v2 是 fire-and-forget 影子实验，结果只进日志，且仍以 v1 配置为前提 |
| `CLOUD_SERVICE` | **千万别在 MCP 上设 `true`**：虽能把 parse 工具切成 hosted 两阶段上传，但会连带开启 OAuth + SAFE_MODE，无凭据时 getClient 直接 Unauthorized，全部免 key 用法报废 |
| `RESEARCH_PROXY_URL` | 不设则 api 根本不挂载 `/v2/search/research/*` 与 `/v2/search/developer` 路由（不是报错，是路由不存在） |

其他容易误判的事实：

- **categories ≠ 专用后端**：`/v2/search` 的 `github`/`research`/`pdf` category 是纯查询改写
  （`site:github.com` / 14 个学术站点 / `filetype:pdf`），底层仍走 SearXNG；
  只有 `developer` category 走 research-proxy
- **PDF 管线顺序**：firecrawl-rs（Rust，文本型 PDF 零配置）→ MU OCR（pdf-ocr→MinerU，仅扫描件）
  → pdf-parse（纯 JS 兜底，总在）。任一级失败自动降级下一级
- **MCP 的 parse 工具**：local 模式下 `filePath` 在 **MCP 容器**文件系统上解析，客户端本地路径必 ENOENT。
  工具描述已注入 REMOTE PARSE NOTE 引导 agent 改用 HTTP multipart `POST /v2/parse`；
  NOTE 里的端点域名由容器 env `${FIRECRAWL_DOMAIN}` 生成（2026-10 起不再硬编码）

## 平台项目 env 凭据表

**必填 3 个**（缺一部署即降级/失败）：

| 变量 | 说明 | 形态示例 |
|---|---|---|
| `FIRECRAWL_DOMAIN` 🆕 | 对外 FQDN。api 与 firecrawl-mcp 两组 traefik 路由的 Host、MCP 启动 patch 写入 dist 的 parse 端点全部由它派生 | `firecrawl.example.com` |
| `JCR_REGISTRY` 🆕 | 私服镜像 mirror 主机名。**只写主机名**（不带协议不带路径）；全部 11 个镜像 ref 为 `${JCR_REGISTRY}/…` | `registry.company.example` |
| `MINERU_BASE_URL` 🆕 | pdf-ocr 转发的自托管 MinerU 完整 URL（带端口）。无默认——不配则扫描件 OCR 静默降级 pdf-parse | `http://mineru.internal.example:8800` |

**既有密钥/开关保持不变**：`PARSE_UPLOAD_REF_SECRET`、research-proxy 的 `GITHUB_TOKENS` /
`SEMANTIC_SCHOLAR_API_KEY`、papers-service 的六个可选学术 API key、`UNPAYWALL_EMAIL`
等——均照上节表格及旧项目 env 原样填入。

为什么是预合并单文件：预合并后任何平台只需要一个 compose 文件即可部署，不依赖各平台对
多文件合并 / additional paths 的支持差异（Arcane、手动 `docker compose` 都一样）。

## 部署配置（Arcane）

compose 用本分支的 `docker-compose.yaml`（预合并单文件）；变量配在项目 env（.env）里，不进 git。

2026-10 安全清洗后首备/换机部署：项目 env 除旧变量原样照填外，**新增上表 3 个必填变量**
（`FIRECRAWL_DOMAIN` / `JCR_REGISTRY` / `MINERU_BASE_URL`），否则镜像拉不下来、路由对不上。

从旧仓库（xyonium/firecrawl 的 portainer-stack 分支）切换过来的历史步骤（已完成的迁移参考）：

- 先把旧部署的 env 变量复制出来
- 在 Arcane 新建项目，compose 内容取本分支的 `docker-compose.yaml`，env 原样填入
- compose 里 `name: firecrawl` 已固定项目名，数据卷（firecrawl_redis 等）会自动挂回，**数据不丢**

切换完成后记得启用同步（见下节）；机器人推送更新后按惯例同步到 Arcane 并重建。

## 同步机制

同步工作流在 compose 仓库 `main` 分支的 `.github/workflows/sync-firecrawl.yml`
（GitHub 定时任务只跑默认分支，所以工作流放 main，操作后推回本分支）。
**⚠️ 定时调度当前刻意注释未启用**——等项目切换到本仓库后，到 main 分支把该文件里
`schedule:` 两行的注释去掉即开启（每月 5 日 03:42 UTC / 北京 11:42）；`workflow_dispatch`
手动同步随时可用，在 Actions 页面选 **Sync firecrawl compose** → Run workflow。
旧 fork（xyonium/firecrawl）main 上的 `portainer-stack-sync.yml` 与本仓库无关，fork 删除后自然失效，无需处理。

同步逻辑：

1. 拉取上游最新 compose → `docker-compose.upstream.yaml`
2. 与本分支的 override 合并（`docker compose config --no-interpolate`，保留 `${VAR}` 模板）
3. **镜像 digest 钉版**：4 个 firecrawl 系上游镜像（`firecrawl` / `playwright-service` /
   `nuq-postgres` / `firecrawl-mcp-server`）按 ghcr 原名解析 digest，纯字面替换写回
   `${JCR_REGISTRY}/...` 模板行（`...@sha256:...`）。`workflow_dispatch` 的 `pin_mode`
   输入：`latest`（默认，解析上游最新——即升级通道）/ `keep`（保留旧产物里的 digest，
   用于不升级只验证合并的受控运行）。3 个自研服务镜像不在此处钉——由本分支各自的
   build workflow 钉版。
   钉 digest 后镜像更新变成 compose 文件的 diff：新 digest → 文件变化 → 平台重建拉新镜像，
   digest 历史留在 git 里可回滚。
   redis / rabbitmq / foundationdb 是稳定第三方镜像，刻意保持浮动 tag 不钉。
4. 校验合并结果：反向断言（不得出现 certresolver/真实域名）+ 关键配置哨兵 +
   python 结构 smoke（YAML 解析 + 7 个钉版镜像 + env 模板保留），
   再加仓库级 leakage gate（真实域名/标识串残留即失败），通过且有变化才提交推送

上游若做了与 override 不兼容的改动（比如删除/重命名某个 service），Action 会**失败并通知**，
线上保持旧版本不受影响——不会半夜悄悄挂掉。修好后在 Actions 页面手动 Re-run 即可。

回滚：分支上 revert 对应的 sync commit，平台侧重新部署即可（digest 历史都在 git 里）。

注意：若仓库长期无活动，GitHub 可能自动暂停定时任务（会提前发邮件提醒），重新 enable 即可。
