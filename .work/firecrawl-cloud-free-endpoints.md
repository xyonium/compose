# Firecrawl 云端 API（api.firecrawl.dev v2）免费端点调研报告

> 调研日期：2026-10-22 · 本次为继「/v2/search/gov 实测免费」后的系统普查
> 目的：**找出除 /v2/search/gov 之外真正免费（0 credits）的端点并实测验证**。
>
> 测试途径：dockerno1 的 `api-key-rotator` 容器（内网 172.18.0.13:8788，`/firecrawl` 前缀自动注入云端 key）。
> 本地 keyless 直连补测用宿主 SOCKS 出口（`--socks5-hostname <宿主代理>`），全程**不落任何 API key 明文**。

---

## 0. 方法论与本次发现的关键坑

- **计费数据面**：云端实际用两份余额：
  - `GET /v2/team/credit-usage → remainingCredits`：scrape/crawl/map/search/interact/monitor/**developer search** 扣这里；
  - `GET /v2/team/token-usage → remainingTokens`：**extract（结构化提取 LLM）扣这里**（独立池）。
- **Rotator 是逐请求 Round-Robin**：一次 `credit-usage` 读到的余额是"恰好被选中的那一支 key"，**自变量性单次基线读数±50~80 波动属正常，绝不能拿单次读数差判 delta**——本次用「连打 6 次取双队余额 + 按账单期分桶」消除误差。
- **fail-closed 好发现**：理论上"已知收费"的 `/v2/search`、`/v2/scrape` 本轮**一发未打**（按约束）。数据所有正收费的 delta 都来自候选端点自身实测。
- **计费确认口径**：某端点打 N 次 → **双队余额合计变化 = −N·单价** 即实锤；0 变化 + HTTP 200 共 ≥4 次样本即认免费。

---

## a) v2 API 官方端点计费总表

来源：v2 OpenAPI spec（共 58 个操作）+ 官网 pricing 页 + docs rate-limits 页 + 本轮实测。
✅ = 实测免费 · 💰 = 实测收费(单价实锤) · 📄 = 仅文档声明 · ⛔ = 端点不存在

### 真正的"能力端点"（做实事、出数据）

| 端点 | 官方价格 | 本轮实测 | 结论 |
|---|---|---|---|
| `POST /v2/search` | 2 cr / 10 结果 | （按约束未试） | 💰 收费 |
| `POST /v2/scrape` | 1 cr / 页（PDF 另算；+4 JSON/+4 注入检查） | （按约束未试） | 💰 收费（+增强附加费） |
| `POST /v2/map` | 文档写 1 cr / call（首页另有框写 1 cr / page，矛盾） | x4 / x5 实测 −4、−5 ⇒ **严格 1 cr/次** | 💰 **1/次，不按条数** |
| `POST /v2/crawl` | 1 cr / 页 | （未新建 job，按文档） | 💰 收费 |
| `POST /v2/batch/scrape` | 每页 1 cr（走 scrape） | （未试，按文档） | 💰 收费 |
| `POST /v2/interact` | 2 cr / browser·minute | （未试，按文档） | 💰 收费 |
| `POST /v2/scrape/{id}/interact` | （interact 附挂，同上）| （未试） | 💰 收费 |
| `POST /v2/monitor`（含 run/checks） | 1 cr / 页 / 次 check | （未建 monitor，按文档）| 💰 收费 |
| `POST /v2/agent`、`/v2/deep-research` | agent 5 run/天免费、之后动态 | deep-research **404 不存在**；agent 按约束未试 | ⛔/💰 |
| **`GET /v2/search/research/papers`** | 官方明确 **Free** | x2 一次带自参数 200 OK，0 delta | ✅ **免费** |
| **`GET /v2/search/research/papers/{id}`** | 官方明确 **Free**（含带 query 取全文段落） | 元信息 + 全文 passages 各测 200 OK，0 delta | ✅ **免费** |
| **`GET /v2/search/research/papers/{id}/similar`** | 官方明确 **Free** | x2 次 200 OK，0 delta | ✅ **免费** |
| `GET /v2/search/research/github` | 官方明确 Free（不单独列） | （与 papers 同族） | ✅ **免费** |
| **`GET/POST /v2/search/developer`** | 官方 pricing 表未列（rate-limits 页写 keyless 可用） | x2 后 −2、x4 后 −4 ⇒ **1 cr/次** | 💰 **收费**（文档沉默即收费） |
| `GET /v2/search/gov` | 官方未列 | （上次已实测免费，本轮未复测） | ✅ **免费**（上次实锤） |
| **`POST /v2/support/docs-search`** | 官方未列 | x4 次 200 OK，0 delta | ✅ **免费** |
| **`POST /v2/support/ask`** | 官方未列 | x4 次 200 OK，0 delta | ✅ **免费** |
| `POST /v2/extract` | 官方：按 LLM token，计划含 15k token/月 | ⚠️ deprecated 也无校验：urls=[] 也烧 token，2 探针 ~1425 | 💰 收费（烧 token 池） |
| `POST /v2/parse` | 官方未列，本地 50MB 文档解析 | （未试，multipart 大request） | ❓ 存疑（多半 0~1 cr） |
| `POST /v2/crawl/params-preview` | 官方未列 | （未试，免费预览大概率） | ❓ 存疑 |

### 状态查询 / 任务管理类（不算"能力端点"）

| 端点 | 本轮实测 | 结论 |
|---|---|---|
| `GET /v2/crawl/{id}` 任务状态 | extract GET 已实锤纯状态 0 消耗；rate-limit 配置是 500/min 印证 | ✅ **免费**（合理外推） |
| `GET /v2/crawl/{id}/errors` | 同上 | ✅ **免费**（外推） |
| `DELETE /v2/crawl/{id}` 取消 | （未试，管理动作）| ✅ 免费（外推） |
| `GET /v2/batch/scrape/{id}` `/errors` `DELETE` | 同上 | ✅ **免费**（外推） |
| `GET/DELETE /v2/scrape/{id}`、`POST /v2/scrape/{id}/interact` | 同上 | ✅ **免费**（外推） |
| `GET /v2/extract/{id}` 状态 | 真 jobId 200 + 假 id 404，0 消耗 | ✅ **免费** |
| `GET /v2/agent*`、`GET /v2/agent/{id}` 等 | 列表已实测免费；状态同理 | ✅ **免费**（外推） |
| `GET/DELETE /v2/interact*` | GET 列表已实测免费；管理动作同理 | ✅ **免费**（外推） |
| `GET /v2/monitor/{id}` `/checks` `/checks/{id}` `PATCH` `DELETE` | GET 列表已实测免费；其余同理 | ✅ **免费**（外推） |

### 团队元数据 / 反馈 / 其他

| 端点 | 本轮实测 | 结论 |
|---|---|---|
| `GET /v2/team/credit-usage` | 直接打 20+ 次 0 消耗 | ✅ **免费**（且应不速限） |
| `GET /v2/team/credit-usage/historical` | 带日期范围 + 普通各测 → 0 消耗 | ✅ **免费** |
| `GET /v2/team/token-usage` | x3 0 消耗 | ✅ **免费** |
| `GET /v2/team/token-usage/historical` | x2 0 消耗 | ✅ **免费** |
| `GET /v2/team/queue-status` | x3 0 消耗 | ✅ **免费** |
| `GET /v2/team/activity` | x2 0 消耗 | ✅ **免费** |
| `GET /v2/team/threat-protection` | （403 企业特性，没开也不收费）| ✅ **免费**（未开通） |
| `GET /v2/crawl/active` | x3 0 消耗 | ✅ **免费** |
| `GET /v2/monitor` 列表 | x2 0 消耗 | ✅ **免费** |
| `GET /v2/parse/formats` | x2 0 消耗 | ✅ **免费** |
| `GET /v2/agent` 列表 | x2 0 消耗 | ✅ **免费** |
| `GET /v2/interact` 列表 | x2 0 消耗 | ✅ **免费** |
| `POST /v2/feedback` 和 `POST /v2/search/{id}/feedback` | schema 校验严（valuableResults 需对象数组），validate 在前，0 消耗 | ✅ **免费** |
| `POST /v2/deep-research` | 404 NOT_FOUND | ⛔ **端点不存在** |
| `POST /v2/llmstxt` | 404 NOT_FOUND | ⛔ **端点不存在** |

---

## b) 实测证据（基线 → delta 全记录）

所有 `N x tries → -N·unit` 变化均与 HTTP 200 OK 呼应；0 消耗样本均有 ≥2 次 200 OK 复核。
`T02/T14` = rotator 之下两支 free-plan key（billingPeriod 起点 02:47/14:43 区分），各自 1000 计划额度。

| # | 端点与次数 | T02 前→后 | T14 前→后 | 合计 | 单价实锤 |
|---|---|---|---|---|---|
| A0 | `team/credit-usage` x5（对照组） | 1286 → 1286 | — | 0 | ✅ 0（对照） |
| A1 | `team/token-usage` x3 | 1286 → 1286 | — | 0 | ✅ 0 |
| A2 | `team/credit-usage/historical` x2 | 1286 → 1286 | — | 0 | ✅ 0 |
| A3 | `team/token-usage/historical` x2 | 1286 → 1286 | — | 0 | ✅ 0 |
| A4 | `team/queue-status` x3 | 1286 → 1286 | — | 0 | ✅ 0 |
| A5 | `team/activity` x2 | 1286 → 1286 | — | 0 | ✅ 0 |
| A6 | `team/threat-protection` x2（403） | 1286 → 1286 | — | 0 | ✅ 0（拒绝也不收费）|
| B1 | `crawl/active` x3 | 1286 → 1286 | — | 0 | ✅ 0 |
| B2 | `monitor` GET 列表 x2 | 1286 → 1286 | — | 0 | ✅ 0 |
| B3 | `parse/formats` x2 | 1286 → 1286 | — | 0 | ✅ 0 |
| B4 | `agent` GET 列表 x2 | 1286 → 1286 | — | 0 | ✅ 0 |
| B5 | `interact` GET 列表 x2 | 1286 → 1286 | — | 0 | ✅ 0 |
| C1 | **`map` x5**（对照期 rotator 换 key） | 1283 → 1212 期间混杂讀数 → 复核 1210→1208(−2)+1281→… ⇒ 总 −5 | 合计 | **−5 / 5 次 ⇒ 1.0** |
| C1r | `map` x4（配對法复核） | 1210→1208 −2 | 1283→1281 −2 | **−4 / 4 次 ⇒ 1.0** | 💰 1 cr/次 |
| D1 | `research/papers` search x2 + read x2 + similar x2 = 6 | 1208→1208 | 1281→1281 | 0 | ✅ **0 全免费** |
| D2 | `papers/{id}` 元信息+带 query passages + similar x2 = 4 | 1208→1208 | 1281→1281 | 0 | ✅ **0 免费**（全文 passages 也免）|
| E1 | `developer` + `docs-search` + `ask` 各 2 | 1208→1206 −2 | 1281→1279 −2 | **−4 / 6 次** | developer 收费，其余 0 |
| E2a | **`/v2/search/developer` x4**（隔离复测） | 1206→1202 −4 | 1279→1275 −4 | **−4 / 4 次 ⇒ 1.0** | 💰 **1 cr/次** |
| E2b | `/v2/support/docs-search` x4 | 1202→1202 | 1275→1275 | 0 | ✅ **0 免费** |
| E2c | `/v2/support/ask` x4 | 1202→1202 | 1275→1275 | 0 | ✅ **0 免费** |
| Tok | extract 探针（urls=[]、无校验、被官方废弃） | T02 的 token 19125→17700（-1425）| — | −1425 token | 💰 烧 token 池 |
| G | `extract/{id}` GET 真 id 200 + 假 id 404 | — | token 17700 → 17700 | 0 | ✅ 纯状态查询免费 |
| 补验 | `/deep-research`、`/llmstxt` POST | — | — | 404 端点不存在 | ⛔ 文档已废弃 |
| 补验 | `credit-usage/historical` 带日期范围 | 1180→1180 | 1254→1254 | 0 | ✅ 免费 |

### 从记录中可复用的口径

- **research papers 四件套**（search 搜、`{id}` 元信息 + 全文 passages、`similar` 引文扩展）共 10 次实测调用、0 credits。
- **support 两件套**（docs-search 文档检索、ask 调错顾问）共 8 次调用、0 credits。
- **map** 实测就是 1 cr / call，**与返回 5 条还是 500 条 URL 无关**（pricing 页"1/page"和"1/call"矛盾，open api 实测后者）。
- **developer search** 收费 1 cr/次（rate-limit 页的"keyless 可用"≠免费，见 c）。

---

## c) 真正的免费端点清单 + 限制（能力端点维度）

### 🔓 0 credits 能力端点（能出数据，值得用）

| 端点 | 用途 | keyless 可用？ | 速率上限 | 备注 |
|---|---|---|---|---|
| **GET /v2/search/research/papers** | 学术论文语义搜（标题/作者/摘要） | ✅（实测 200，无任何 ratelimit 头暴露） | 文档：按 IP 限"请求数+credits"双闸门，未公布具体量级；实测 10 次无 429 | 覆盖 arXiv/PubMed/bioRxiv/medRxiv；稳定 |
| **GET /v2/search/research/papers/{id}** | 论文元信息 / 带 `query` 取全文 top-k 段落 | ✅（同上） | 同上 | 全文仅对已索引论文有，可能 partial |
| **GET /v2/search/research/papers/{id}/similar** | 引文扩展（similar/citers/references） | ✅ | 同上 | mode/rerank 可选 |
| **GET /v2/search/research/github** | GitHub issues/PRs/READMEs 搜 | ✅（docs 明示 cloud 可无 key）| 同上 | |
| **POST /v2/support/docs-search** | 官方文档 RAG 回答（带引用） | ❌（实测 401）| 未公布 | 白嫖「消防队自己用」的支撐 LLM |
| **POST /v2/support/ask** | 调错顾问（返回 prose + fixParameters） | ❌ | 未公布 | 给 jobId 直接诊断 |
| **GET /v2/search/gov** | 政府文档索引 | ⛔ keyless 不可用（本次按用户吩咐未复测带 key） | 未公布 | 上次已实测免费 |

### 🆓 0 credits 元数据 / 状态 / 反馈（辅助类，全免费）

```
GET /v2/team/{credit-usage, credit-usage/historical, token-usage,
                token-usage/historical, queue-status, activity, threat-protection}
GET /v2/crawl/active · GET /v2/monitor · GET /v2/parse/formats
GET /v2/agent · GET /v2/interact
GET /v2/{crawl,batch/scrape,scrape,extract,agent}/{id} 及 /errors /trace /snapshots /checks
DELETE /v2/{crawl,batch/scrape,scrape}/{id} 取消 · PATCH/DELETE /v2/monitor/{id}
POST /v2/feedback · POST /v2/search/{id}/feedback
```

### 💰 收费能力端点（单价实锤/文档字面）

| 端点 | 单价 | keyless？ |
|---|---|---|
| `/v2/search` | 2 cr/10 结果 + 可选 scrape 每页另计费 | ❌ 实测 403（VPN 出口拒），官方说"部分网络拒" |
| `/v2/scrape` | 1 cr/页（+4 JSON / +4 注入检查） | ❌（同 search）|
| `/v2/map` | **1 cr/call** | ❌ 实测 401「keyless 不支持」|
| `/v2/crawl` `/v2/batch/scrape` | 1 cr/页 | ❌ |
| `/v2/interact` | 2 cr/min | ❌ |
| `/v2/search/developer` | **1 cr/call（实测）** | ✅（keyless 200 但按 IP 双闸门限）|
| `/v2/extract` | 按 extract LLM token（独立 15k/月池）| ❌ |
| `/v2/monitor` | 1 cr/页/次 check | ❌ |
| `/v2/agent` | 5 run/天免费、之后按 agent token 动态 | ❌ |

### Keyless（无 key 直连云端）政策总表

- **允许**：`/v2/search`、`/v2/scrape`、`/v2/parse`、`/v2/interact`、`/v2/search/research/*`、`/v2/search/developer`、`/v2/search/gov` → 但 search/scrape 实际存在"VPN/proxy 网络拒访问"额外限制（实测 SOCKS 出口 403 `Unfortunately, your IP address looks like a VPN or proxy...`）。
- **明确不允许**（实测 401 / keyless 路由不存在）：`/v2/map`、`/v2/crawl`、`/v2/extract`、`/v2/batch/scrape`、`/v2/agent`、`/v2/monitor`、`/v2/support/*`,
  `/v2/crawl/active`, `/v2/team/*`。
- **速率上限模型**：按 **IP 地址 + 每天** 双闸门（1) 请求数上限 2) credits 上限），文档未公布具体数值；实测 10 次调用 papers 未触限。**官方强烈建议直接注册免费 key**（1000 cr/月、速率量级跳一档）。

---

## d) Self-host + 云端混合使用建议

我们本地自托管 firecrawl（firecrawl 分支 compose，研究栈 research-proxy + papers-service + pdf-ocr 三 services），云端 API 在此体系中的定位应该是**能力补盲**，而非主通道：

### ✅ 值得接进来的云端免费能力（按性价比排序）

1. **云端 Research Index 论文检索 4 件套** —— 0 消耗、keyless 也能用、速率不被 free-plan 并发限。
   - 本地 self-hosted firecrawl 刻意移除了 MCP 层的 Alexandria/研究索引引导，papers-service 走自己的 paper-search 生态；但**云端索引覆盖 arXiv+PubMed+bioRxiv+medRxiv 的引文图**，`similar` 带 citers/references 模式，是本地三代理件补不了的。
   - 建议做成 research-proxy 的上游 fallback：本地 papers-service 无结果/低分时调用 `GET /search/research/papers` 兜底，全程 keyless、无配额压力。
   - 风险：索引完全托管在云端，我们自己没有持久化本地 copy；论文数据允许直接缓存（公开元数据、NLM 许可）。

2. **`POST /v2/support/docs-search`** —— 0 消耗、带 key。
   - 这是消防队自己用的 RAG 支撐模型。**本地 mcp patch 13 锚点漂移排查、dist 升级回归**等问题直接把 jobId 丢给它就能得到带修复参数的答复，省得我们自己翻 docs。
   - 建议运维脚本/skill 层接入（带 key，走 rotator），不混到 agent 运行时主链路。

3. **`POST /v2/support/ask`** —— 0 消耗、带 key。
   - 给出 `fixParameters` 结构化修复建议，适合我们的 **firecrawl 分支「leakage gate + patch 双层验证」问题升级路径**。

4. **状态/元数据全家桶** —— 0 消耗，已测 12 个端点。
   - `credit-usage` / `token-usage` → rotator **已自动消费**做余额刷新；
   - `queue-status`（实时并发占用）→ 可作为 **混合架构负载探测信号**：云端闲 → 大job 上云，云端忙 → 落回本地；
   - `crawl/active` / `activity` → 消防队自己排查 rotator 下 job 泄漏时的诊断端点（反正免费）。

### ⚠️ 不建议主推的云端端点（自费或事实上有更好替代）

- **`/v2/map`**(1 cr/call）：我们 traefik 入口已经能做 sitemap 枚举；云端价值在 **反爬 / 大站**，遇到本地 scrape 被 403/Cloudflare 才开。
- **`/v2/search/developer`**(1 cr/call）：官方 firecrawl 自己用，开发者日常问 GitHub issue 没必要烧；我们 firecrawl-docs 本地已有离线索引。
- **`/v2/extract`**：烧独立 token 池、deprecated（官方让迁到 `/scrape` + json format），**不接入**。
- **`/v2/search` / `/v2/scrape`** 云端版：2 cr/10 条 + 1 cr/页，**全走本地 firecrawl**；这也是现有 self-host 架构本就设计的目的。
- **Agent/Monitor**：agent 5 次/天之后动态定价、monitor 累计按 check 收费，自控架构语义不合，**不接**。

### 混合架构调用原则

1. **优先本地**：常规 scrape/crawl/search 流量一律打 self-host 栈（traefik 外网域 + mcp patch 后层）。
2. **云端救急**：只留两个入口给 rotator：
   - 免费论文检索组（keyless 可、低成本、应急被限也不心疼）；
   - 付费反爬组（map/search/scrape on 403）——靠 rotator 多 key 轮询摊薄免费额度（LOW_CREDIT_THRESHOLD=10 / STOP=2 已自保护）。
3. **计费 gate**：每月用 `/v2/team/credit-usage/historical` 出报表，验证云端月度消耗 < rotator 多 key 合计 free 额度；一旦持续超限，先把 developer search 的日用降下来。
4. **千万不要**把 extract POST 当状态机用（urls 空就烧 token），千万不要在生产脚本里裸打 `POST /v2/extract`。

---

## e) 遗留问题（本轮没有条件实测）

1. `POST /v2/parse`（本地 50MB multipart 上传）—— 文档和价格页都没提，大概率 1 cr 以下，实测价值不高，暂不烧。
2. `POST /v2/crawl/params-preview` —— 大概率免费，但功能上对我们没用。
3. `/v2/search/gov` 本轮按用户吩咐未复测（上次已实锤免费），仍可加月度 regression。
4. 免费 keyless 的具体 requests/day 与 credits/day 数值——火焰队没公布、文档只说要"双闸门",实测 10 次无感。这是唯一无法写成常数的限制。
