# AGENTS.md

本文件写给在 **firecrawl 部署分支**（orphan，与 main 独立）上改研究栈的 agent。
只记「改之前必须知道的事实」：哪些实现只有一份、哪些字段后端看不到、哪些"没结果"
是预期。部署背景见 `README.md`，服务细节见 `papers-service/README.md`。

## 硬约束

1. **检索适配器只有一份**：`papers-service` 不复制、不改写任何检索适配器。唯一实现是
   `xyonium/paper-search` 的 `tool.py`，镜像构建时由 `papers-service/Dockerfile` 用
   `ADD https://raw.githubusercontent.com/xyonium/paper-search/${PAPER_SEARCH_REF}/tool.py`
   打进 `/srv/vendor/tool.py`。`PAPER_SEARCH_REF` **必须是 commit sha**（ADD 远程文件
   按 URL 字符串缓存，传分支名不会刷新）；由 `.github/workflows/papers-service-image.yml`
   解析 paper-search main 后传入。

2. **后端只消费每源适配器**：`papers-service/app/toolwrap.py` 的 `SEARCH_DISPATCH`
   直接调 `tool.py` 的 `t._arxiv_search(...)` 等，不经过 `search_papers` 编排层。
   因此编排层字段（`ignored_sources` / `admin_alert` / DOI 去重 / `duplicates_removed`）
   在后端不可见，**属预期**，不要"修"。

3. **key-gated 源未配 key 返回 `[]` 而非报错**（ieee / zhihuiya / firecrawl / tavily /
   google_scholar 三级链）。"未配置"不是故障；research-proxy 当空结果正常合并。

4. **镜像一律 digest 钉版**：`docker-compose.portainer.yaml` 是唯一手改入口；
   `docker-compose.yaml` 是生成物，不要手改。workflow 的 `paths` 只含
   `papers-service/**`（+ 自身），`tool.py` 更新不会触发，靠 `repository_dispatch`
   或手动 `workflow_dispatch`。

5. **mcp 版本**：papers-service 固定 `mcp==1.27.2`（升级必须跑
   `papers-service/tests/test_contract.py` + 真实 `/papers/search_papers` 冒烟）；
   OWUI 容器现为 `mcp 2.3.0`；`tool.py` ≥2.9.10 已同时兼容 mcp 1.x/2.x，
   `requirements.txt` 里旧的"与 OWUI 容器内版本一致"约束已过期。

6. **OWUI 部署不归 compose**：`paper-search` 仓库的
   `scripts/deploy_owui_tool.py --check` 比对 OWUI 工具表版本，漂移退出码 1；
   OWUI 侧用该脚本同步，不要在本仓库复制第二份工具实现。

## tool.py 自动更新链路

```
paper-search main  push tool.py
  └─ paper-search .github/workflows/notify-compose.yml
       │  repository_dispatch: paper-search-updated
       ▼
     compose main .github/workflows/relay-paper-search-updated.yml
       │  workflow_dispatch(ref: firecrawl)   ← repository_dispatch 只在默认分支匹配
       ▼
     compose firecrawl .github/workflows/papers-service-image.yml
       ├─ PAPER_SEARCH_REF = paper-search main 的 sha
       ├─ 构建并 push ghcr.io/xyonium/firecrawl-papers-service
       ├─ 冒烟：docker run 后 GET /healthz，toolVersion 必须等于该 sha 的 tool.py version
       └─ 把新 digest 钉回 docker-compose.portainer.yaml（+ docker-compose.yaml 若命中）
```

- 前置：`paper-search` 仓库 secret `COMPOSE_DISPATCH_TOKEN`（fine-grained PAT，仅
  `xyonium/compose` 的 `contents: write`）。未配置时 notify 工作流只告警、不失败。
- `repository_dispatch` 只匹配默认分支上的工作流，而构建工作流住在 firecrawl 分支，
  所以 main 上有一跳中继（`relay-paper-search-updated.yml`，用 GITHUB_TOKEN 触发
  firecrawl 的 workflow_dispatch）。**删掉中继会让 dispatch 静默无 run**（204 但
  total_count=0，2026-11-19 实测）。
- 无 PAT / 手动升级：Actions → **Build papers-service image** → Run workflow（ref: firecrawl）。
- 旁路漂移检测（不需要 PAT）：镜像带 `org.xyonium.paper-search-ref` 标签，宿主机 cron 跑
  `scripts/check-paper-search-drift.sh`（0=一致，1=落后，2=无法判定），cron 行见脚本头部。

## firecrawl-mcp 启动 patch（最易漂移）

- 位置：`docker-compose.portainer.yaml` 的 `firecrawl-mcp.command`；启动时把 `/app` 拷到
  `/tmp/app-root`，对 `dist` 做替换后再 `exec`。改补丁只改 portainer，
  `docker-compose.yaml` 是 sync 生成物。
- 2026-11-19 适配 3.37.0：gov 用**括号平衡扫描**定位调用段（支持嵌套/多参数，保留
  `.catch` 链），fetch 里 `r.ok` 失败时构造 `err.response` 继续走 400→UserError；
  `blankConst` 支持 `var|const|let`、引号感知；清空 4 个 `ALEXANDRIA_*` 常量、scrape 的
  `alexandria` param 描述、带 `TERMS_GUIDANCE` 的整行；`WARN patch drift` 覆盖常量/
  param/句子（缺锚点只告警、不 crash；已打过的不误报）。
- 启动日志出现 `WARN patch drift` = 锚点又漂了：拉对应 digest 的镜像，按 main AGENTS 的
  mcp patch 双层验证清单更新，别只看 `Total patched`。
- 改完 portainer 后跑 `sync-firecrawl`（`pin_mode=keep`）才会进 `docker-compose.yaml`。

## 验收

- Actions 运行的 **Smoke test /healthz** 日志里 `toolVersion=<x>` 与
  `tool.py version = <x>` 一致。
- 部署后在能访问服务网络的机器上：
  `curl -s http://papers-service:3200/healthz | jq .toolVersion`。
- 改动 `requirements.txt` / tool.py 兼容逻辑后至少跑：
  `cd papers-service && PAPER_SEARCH_TOOL_PATH=/path/to/paper-search/tool.py python3 -m pytest tests/ -q`
