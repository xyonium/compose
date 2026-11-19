# papers-service

**paper-search-mcp 的替代实现**——research-proxy（`../research-proxy/`）的 `/papers/*` 上游。
自托管 firecrawl 的 research 端点原先由 mcpo 承载的 paper-search-mcp 提供论文数据；
本服务用更可靠的方式实现同一组端点形状，paper-search-mcp 就此退役。

## 端点（与 mcpo/paper-search-mcp 形状一致，research-proxy 零改动可切）

| 端点 | 请求体 | 返回 |
|---|---|---|
| `POST /papers/search_{source}` | `{"query", "max_results"}` | `{"papers": [...]}` |
| `POST /papers/get_crossref_paper_by_doi` | `{"doi"}` | paper dict（裸） |
| `POST /papers/read_{source}_paper` | `{"paper_id"}` | `{"result": "全文文本"}` |
| `POST /papers/download_with_fallback` | `{"source", "paper_id", "doi", "title", "use_scihub", "scihub_base_url"}` | PDF 字节（`X-Download-Via` 标来源）；失败 404+`attempts` |
| `GET /healthz` | — | 源清单 + tool.py 版本 |
`POST /papers/search_szlib` 是登录型：未登录返回 200
`{"papers": [], "login_required": {...}}`（带 `login_url` / `login_token` / `expires_in`）；
完成浏览器登录后把 `szlib_login_token` 和同一个 `szlib_session` 放回请求体重试。
`search_papers` 的 `sources=all` **不含** szlib；只有显式 `sources=szlib` 才会调用。

item 形状（research-proxy `_paperhit_from_mcp` 消费的就是这些键）：
`title / authors("; "分隔字符串) / published_date / abstract / paper_id(裸 id, 无前缀) / doi / source / pdf_url / url / citations`。

## 检索：复用 paper-search 仓库 tool.py 的直连适配器

镜像构建时 Dockerfile 把 [xyonium/paper-search](https://github.com/xyonium/paper-search)
的 `tool.py` ADD 进 `/srv/vendor/tool.py`（`PAPER_SEARCH_REF` build-arg，工作流自动
解析成 main 的 commit sha）。该文件是 OWUI 工具的同一套实现——搜索适配器一处维护，
OWUI 侧和本服务行为天然一致。

支持的 `search_{source}`（未知源 → 404，research-proxy 记错误后继续）：

- **直连免 key**：arxiv, semantic, pubmed, pmc, openalex, crossref, europepmc,
  core, hal, dblp, zenodo, openaire, iacr, doaj
- **key-gated**（没配 key 返回 `[]` 不报错）：ieee（IEEE_APIKEY）、
  zhihuiya（ZHIHUIYA_APIKEY）
- **显式专用**：szlib（深圳图书馆/读秀，经 `szlib-mcp` 的 `POST /api/search`）。
  需真实浏览器登录：首次调用返回 `login_required{login_url,login_token,expires_in}`，
  浏览器完成验证后带 `szlib_login_token`（和同一个 `szlib_session`）重试。
  **不进 `all`、不进默认扇出**；`paper_id` 为 `szlib:<sha1>`，只有元数据。
- **google_scholar 三级链**（任一级都没配返回 `[]`）：
  firecrawl（FIRECRAWL_BASE_URL）→ tavily extract advanced（TAVILY_BASE_URL）
  → Apify actor（APIFY_ROTATOR_BASE_URL）
- **firecrawl / tavily**：通用 web 搜索源（需对应 BASE_URL）

## read：本服务自带的轻量直连实现

`read_{source}_paper` 覆盖：arxiv / semantic / pubmed / pmc / europepmc / hal /
iacr（PDF→pymupdf、efetch、fullTextXML）+ biorxiv（**全文级**：details API +
`{doi}.full.pdf` 直链，拿不到退元数据）+ medrxiv / doaj / crossref / openalex
（元数据级 markdown，见 `app/readers.py`）。

**读不了的源或论文一律 404** → research-proxy 自动落 `reach/read_url`
（jina 风格抓取，reach-mcp 仍在 mcpo 上，**不**随 paper-search-mcp 退役）。

## download_with_fallback：OA 下载链（OWUI tool 路径 2 的上游）

照搬 paper-search-mcp `download_with_fallback` 的设计（源码参读其 0.1.4 安装包），
paper-search-mcp 退役后承接 `download_paper_to_knowledge` 的 OA 兜底链：

1. **source-native 直下**：arxiv / iacr / biorxiv 直链
2. **OA 仓储**：openaire → core → europepmc → pmc（按 DOI/标题搜，复用 toolwrap
   里 tool.py 的直连检索适配器取 pdf_url）
3. **Unpaywall**：`best_oa_location` → `oa_locations`（需 `UNPAYWALL_EMAIL`）
4. **Sci-Hub**（可选）：embed/iframe 解析，仅当请求体 `use_scihub=true` 且带
   `scihub_base_url`

每个下载点过**标题身份闸**（全文 token 覆盖率 ≥60% 才收；论文集含目标文即放行；
扫描版提取失败不拦）——不匹配自动落下一级。响应是 PDF 字节 + `X-Download-Via`
头（`native:arxiv` / `repository:unpaywall` / `scihub`…），调用方直接上传，无共享卷。

## 环境变量

| 变量 | 用途 |
|---|---|
| `SEMANTIC_SCHOLAR_API_KEY` | S2 检索/read 提额（强烈建议；匿名共享池常 429） |
| `NCBI_API_KEY` | pubmed/pmc 提额 |
| `CORE_API_KEY` | core 检索（不配走匿名） |
| `IEEE_APIKEY` / `ZHIHUIYA_APIKEY` / `ZENODO_ACCESS_TOKEN` | 对应 key-gated 源 |
| `FIRECRAWL_BASE_URL` | scholar 链 tier1 + dblp Anubis 兜底，如 `http://mcpo:8000/firecrawl` |
| `TAVILY_BASE_URL` | scholar 链 tier2 + tavily 源，如 `http://api-key-rotator:8788/tavily` |
| `APIFY_ROTATOR_BASE_URL` | scholar 链 tier3，如 `http://api-key-rotator:8788/apify` |
| `MCPO_API_KEY` | mcpo 的 `--api-key`（firecrawl 走 mcpo 时需要） |
| `SZLIB_URL` | szlib-mcp 地址，默认 `http://szlib-mcp:8765`；两个容器必须共享 Docker 网络 |
| `UNPAYWALL_EMAIL` | download_with_fallback 的 Unpaywall 请求标识（匿名有配额限制） |
| `PAPER_SEARCH_TOOL_PATH` | 本地开发时覆盖 tool.py 路径（默认 `/srv/vendor/tool.py`） |

## 构建与部署

镜像由 `../.github/workflows/papers-service-image.yml` 在 push 到本分支
（paths: `papers-service/**`）时构建推 `ghcr.io/xyonium/firecrawl-papers-service`
并把 digest 钉回两个 compose 文件。compose 服务块见 `../docker-compose.portainer.yaml`
（`papers-service`，端口 3200，内部服务不过 traefik）。

**tool.py 自动更新**：paper-search 仓库 push `tool.py` → 它的
`.github/workflows/notify-compose.yml` 发 `repository_dispatch(paper-search-updated)` →
compose main 的 `relay-paper-search-updated.yml` 中继成 `workflow_dispatch(ref: firecrawl)`
（`repository_dispatch` 只在默认分支匹配，构建工作流在 firecrawl 分支）→
本工作流重建（`PAPER_SEARCH_REF` 解析成 main 的 sha），冒烟 `/healthz` 的
`toolVersion` 与 tool.py 的 version 一致后，才把新 digest 钉回 compose 文件。
需要 paper-search 仓库 secret `COMPOSE_DISPATCH_TOKEN`（fine-grained PAT，
`xyonium/compose` contents:write）；没配时 notify 只告警。
手动升级/兜底：在 Actions 页对 `Build papers-service image` 跑 `workflow_dispatch`。

**漂移检测**（不需要 PAT）：镜像带 `org.xyonium.paper-search-ref` /
`org.xyonium.paper-search-version` 标签；宿主机 cron 跑仓库根的
`scripts/check-paper-search-drift.sh` 比对 main，落后退出码 1（cron 行见脚本头）。

## 本地开发/测试

```bash
pip install -r requirements.txt
PAPER_SEARCH_TOOL_PATH=/home/eli/paper-search/tool.py \
    python3 -m pytest tests/ -q                      # 契约测试（mock 网络）
PAPER_SEARCH_TOOL_PATH=/home/eli/paper-search/tool.py \
    uvicorn app.main:app --port 3200                 # 起服务
curl -s localhost:3200/healthz
curl -s -X POST localhost:3200/papers/search_arxiv \
    -H 'content-type: application/json' \
    -d '{"query":"graph neural network","max_results":2}'
```
