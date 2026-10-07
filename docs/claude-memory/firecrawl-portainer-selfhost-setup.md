---
name: firecrawl-portainer-selfhost-setup
description: 用户自托管 firecrawl 的完整部署体系（deploy 分支 + 同步机器人 + digest 钉版；从 Portainer 向 Arcane 迁移中）
metadata: 
  node_type: memory
  type: project
  originSessionId: 8f3fd829-e988-40d2-bfca-a83a94349987
  modified: 2026-09-29T05:06:18.827Z
---

用户（xyonium，GitHub 曾用名 ER-EPR）自托管 firecrawl，域名 firecrawl.savorcare.com，走 traefik（external network `reverse-proxy`），镜像全部经私有 mirror `jcr.savorcare.com`（拉透缓存 ghcr/docker，缺 digest 时会回源；**GitHub Actions runners 无法访问该 mirror**，只有用户主机网络可达）。

**2026-09-28 重大重构：分支改名 + 目录合并**（fork: xyonium/firecrawl）：
- `portainer-stack` orphan 分支已改名 **`deploy`**（GitHub rename API，旧名仅网页 URL 重定向，**git smart protocol 已不可解析旧名**——Portainer 里配的旧 ref 会同步失败，必须重指向 `refs/heads/deploy`）。
- worktree `/home/eli/firecrawl-portainer` 已删除，全部工作统一在 `/home/eli/firecrawl` 的 `deploy` 分支进行。**GitHub 默认分支必须保持 main**（月度同步 bot 的 scheduled workflow 只在默认分支跑）。
- `docker-compose.portainer.yaml` 已改名 **`docker-compose.deploy.yaml`**（避开 `docker-compose.override.yaml` 魔法自动加载名）。main 的同步 workflow 改名 `deploy-sync.yml`。
- 用户正在**从 Portainer 迁往 Arcane**（分支名即为此去平台化；README 的"Portainer 配置"一节保留作重指向指引，Arcane 对接时更新）。
- 已知竞态：三个镜像构建 workflow（papers-service/pdf-ocr/research-proxy-image）并发时会在 pin-commit push 上撞车（concurrency 组按 workflow 分）。单次 push 同时改 3 个 workflow 文件会同时触发三路构建，两路 push 被拒 → **串行 `gh run rerun <id>` 失败的 run 即可恢复**（构建缓存命中，重跑很快）。

deploy 分支文件布局（沿承 portainer-stack 时代）：`docker-compose.yaml`（机器人生成的预合并成品，firecrawl 系镜像钉 ghcr digest）、`docker-compose.upstream.yaml`（上游原样拷贝）、**`docker-compose.deploy.yaml`（唯一手改文件**，含镜像源/traefik/reverse-proxy/api 启动时 sed patch llmExtract.js 换 gemini-2.5-flash-lite）+ `research-proxy/`、`papers-service/`、`pdf-ocr/` 三个自研服务（各自 README）。分支 README 有完整文档。

main 分支 `.github/workflows/deploy-sync.yml`：每月 5 日 03:42 UTC 跑，拉上游 compose → 合并 → 钉 digest → 哨兵校验 → 提交到 deploy 分支。

原 Portainer CE 2.39 时代的事实（迁移 Arcane 时仍可能参考）：没有 re-pull image，所以用 digest 钉版让镜像更新走 compose diff；additional paths 只在创建 stack 时可见；改分支在 stack 页 Advanced configuration → RefField；2.45 起有 Edit git settings；interval 用 Go duration（月度=720h）。

上游 compose 变化方向：队列引擎 nuq 引入 FoundationDB 可选后端（`NUQ_BACKEND=fdb`，experimental，默认 pg）；api 容器由 harness.js --start-docker 一把梭（无独立 worker 服务）。

**2026-09-28 排查结论（mcp crash loop + api 停 created）**：
- **Arcane 已实际接管本 stack 部署**，但 **push ≠ 自动部署**：agent 每 ~2min 的 `POST /api/git-repositories/sync` 只是轻量轮询，不触发部署；真正的部署是 GitOps sync（agent 日志 `Creating GitOps sync` / 定时任务 `@every 500m` ≈ 8.3h），要么等周期、要么在 Arcane UI 手动点 Sync（2026-09-28 实测：bot 提交后 6h 无动作，用户 UI 操作时才触发）。agent 消费生成品单文件 docker-compose.yaml（single file sync mode），物化到 `arcane_arcane-data` volume 的 `projects/firecrawl/{compose.yaml,.env}` 后 compose up。agent API 在宿主 :3553，Bearer AGENT_TOKEN 也不够（401），别试着逆向它。
- **firecrawl-mcp 服务不构建自本地源码**（../firecrawl-mcp 不存在；../firecrawl-mcp-server 只是参考 clone），是上游镜像 + compose command 里 `node -e` 运行时 patch dist。往打包产物注入文本必须按 JS 字符串上下文转义（`JSON.stringify(s).slice(1,-1)`）：2026-09-28 上游镜像在模板字面量之外新增了双引号 `.describe("Query for web...")` 且位置靠前，String.replace 首匹配落入双引号串，裸 `"` 注入直接炸掉整个 dist/index.js → SyntaxError crash loop。
- **api 停 created 的根因**：depends_on rabbitmq `service_healthy` 的冷启动竞态——全栈重建时 rabbitmq 启动实测 ~27s，上游 healthcheck 窗口 ~20s（start_period 5s + retries 3×5s）→ 判 unhealthy → compose 中止启动。overlay 已放宽为 start_period 30s / retries 12（start_period 只豁免早期失败，首次成功即转 healthy，不拖慢正常启动）。

**2026-09-29 mcp 工具面收敛（13 个 runtime patch）**：find_tools 禁用（Alexandria 目录云专有，自托管恒报错）+ scrape/search 主描述里的 Alexandria 引导段删除（scrape 1249→795 字）。参数级 .describe 的 alexandria 残留有意保留（死代码无害）。research 工具参数描述补全（#11）。**结论性事实：自托管 find_tools/alexandria 路径全死；check_crawl_status 有意保留（断线恢复唯一入口，与 crawl 同 schema 同实现）；research 4 工具与 developer_search 结构差异大不可合并（MCP 静态 schema 决定）；fork 不值得——patch 全是删减型，锚点漂移即静默跳过，永不会 crash。**

研究栈（沿承，细节见 [[paper-search-de-mcpo-plan]]）：research-proxy shim 桥接 papers-service + reach-mcp(mcpo) + GitHub API；papers-service 是 paper-search-mcp 的替代（tool.py 直连适配器打进镜像）；pdf-ocr 适配 RunPod MU 契约转发自托管 MinerU。papers-service 的 /apify 前缀 env 已随 2026-09-28 redeploy 落地。

**Why:** 这些上下文（mirror 网络可达性、分支布局约定、git 旧名不可解析、并发撞车处理法）不在任何单个文件里，排查部署问题时需要。
**How to apply:** 涉及该 fork 的部署/同步/镜像问题，先看 deploy 分支 README；改部署只改 `docker-compose.deploy.yaml`；不要建议依赖商业版功能或 GH runner 直连 mirror 的方案；分支已叫 deploy，别再用 portainer-stack 名字操作。
