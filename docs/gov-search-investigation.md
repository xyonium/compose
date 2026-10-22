# Firecrawl 云端 "gov" 数据源（Government Index）调研报告

日期：2026-10-22 ｜ 测试途径：部署主机上的 api-key-rotator 容器（`/firecrawl` 前缀自动注入云端 key，调用方免 key）+ firecrawl-mcp 3.33.4 dist 源码 + 官方文档。

背景：self-host firecrawl-mcp 的 `firecrawl_gov_search` 依赖云端专有后端（OSS API 无此路由，必然 404），部署侧 compose 启动 patch（#14）将其禁用。本调研实测云端 gov 能力，为"是否恢复该工具"提供依据。

## 1. 端点存在性 ✅

- **HTTP 端点**：`GET` 或 `POST https://api.firecrawl.dev/v2/search/gov`
  - 出处：firecrawl-mcp 3.33.4 dist（`src/gov.ts` 段）`BASE2 = "/v2/search/gov"`，工具 `firecrawl_gov_search` 以 `client.http.get(...)` 调用；官方文档 [docs.firecrawl.dev/features/gov](https://docs.firecrawl.dev/features/gov) 同时给出 GET/POST 两种形式。
- **参数**（严格校验，多一个字段就 400）：

  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `query` | string，必填 | 自然语言法律/监管问题或检索词，可带辖区/机构/引用号 |
  | `k` | int 1–100，默认 10 | 返回条数（实测 k=100 正常返回 100 条） |

- 错误形态：缺 `query` → `400 {"success":false,"error":"Invalid query parameters",...}`；带未知字段（如 `limit`、`jurisdiction`）→ `400 Unrecognized keys`。

## 2. 实测调通 ✅

测试方式：`curl http://<rotator容器IP>:8788/firecrawl/v2/search/gov?query=...&k=N`（rotator 自动注入云端 key；容器只暴露在内部 docker 网络，未发布宿主端口）。

**样例（截断）：**

```
GET /firecrawl/v2/search/gov?query=clean%20air%20act&k=5
→ HTTP 200, 1.43s
{"success":true,"data":{"web":[
  {"url":"https://epa.gov/clean-air-act-overview/clean-air-act-text",
   "title":"Clean Air Act Text | US EPA",
   "description":"...The Clean Air Act, like other laws enacted by Congress, was incorporated into the United States Code as Title 42, Chapter 85...",
   "position":1},
  {"url":"https://govinfo.gov/content/pkg/STATUTE-84/pdf/STATUTE-84-Pg1676.pdf",
   "title":"PUBLIC LAW 91-604-DEC. 31, 1970 ...","position":4}, ...]}}
```

**返回结构**：与 `/v2/search` 的 web 组同形——每条命中仅 4 个字段：`url` / `title` / `description`（长摘录）/ `position`；经 `categories:["gov"]` 走 `/v2/search` 时多一个 `"category":"gov"`。
**没有**结构化的发布机构、辖区、生效日期字段——这些只能从 URL 域名和摘录文本推断。实测延迟 0.6–1.9s。

## 3. 能力范围（实测命中 + 文档）

| 类别 | 实测证据 |
|---|---|
| 联邦法典 US Code | ✅ `govinfo.gov/link/uscode/42/7401`（42 USC 7401 原文） |
| CFR / eCFR | ✅ `ecfr.gov/current/title-21/...part-11`（含 Agency/Citation 段） |
| 国会法案 / Statutes at Large（含历史版本） | ✅ `govinfo.gov` P.L. 91-604（1970 CAA 修正案） |
| 法院判决 | ✅ `supremecourt.gov` 判决原文 PDF + docket PDF、`justice.gov` 检察总长简报（Loper Bright） |
| Federal Register（拟议/最终规则） | ✅ `federalregister.gov/documents/...`（带 docket 时间线） |
| regulations.gov docket 文档 | ✅ `regulations.gov/document/NHTSA-2026-...` |
| 州法 / 州监管机构 | ✅ `leginfo.legislature.ca.gov`（州民法典条文）、`cppa.ca.gov`（CCPA 法规 PDF） |
| 机构指南/出版物 | ✅ epa.gov、fda.gov、faa.gov、transportation.gov、nist.gov、ftc.gov、sec.gov（EDGAR 申报）等 |
| 地方（local） | 文档声称覆盖，未单独实测 |
| **非美国法律** | ❌ 查 "UK Data Protection Act 2018" / "GDPR Article 5" 只返回美国机构*评述这些法律*的二手材料，拿不到英国/EU 原文。官方文档也明说 "The index focuses on US material" |

- **辖区/机构过滤**：无结构化参数；只能靠 query 里写自然语言（如 "California Civil Code 1798"、"42 USC 7401"）——实测带 `jurisdiction=state` 直接 400。
- **生效/废止日期**：结果对象无日期字段；日期只存在于摘录文本里（如判决 PDF 标题含 "06/28/2024"、FR docket 时间线、eCFR 的 `/current/` URL 语义即"现行版本"）。官方文档明确警告：命中≠现行有效法律，引用前必须核对 issuer/jurisdiction/version。

**vs `web search + site:gov` 的实质优势**：

1. **免费**（web search 每次 2 credits）；
2. 法律语料调优排序：同一 query（Loper Bright）gov 索引前三全是官方一手来源（supremecourt.gov 判决、DOJ 简报、docket PDF），而普通 web 搜索混入 oyez.org、scotusblog.com 等第三方；
3. 命中的是联邦+州+地方的**法律/法规专用索引**（govinfo、ecfr、federalregister、regulations.gov、州立法站），`site:gov` 只按域名过滤、无此召回侧重；
4. 摘录是定位到条文的片段，普通 web 搜索返回的是整页抓取的高亮块。

## 4. 与 `categories:["gov"]` 的关系 ✅ 同一后端、同样免费

- 文档原文："The same search is also available on /search as categories: [\"gov\"], with results in data.web."
- **实测**：`POST /v2/search {"query":"Loper Bright...","categories":["gov"],"limit":3}` 返回命中与 `GET /v2/search/gov` **完全相同**（同 URL、同排序），仅多 `category:"gov"` 字段。
- 约束：`gov`（和 `developer`）不能与其他 categories 组合（客户端校验 + 服务端约束）。
- **计费实测**（决定性证据）：
  - 基线 `GET /v2/team/credit-usage` ×3：`remainingCredits=1288`
  - 连续执行：9 次 `GET /search/gov` + 1 次 `categories:["gov"]` POST + 1 次普通 web 搜索
  - 复测：`remainingCredits=1286`（**只少了 2**，恰为那次普通 web 搜索的成本）
  - gov POST 响应体内 `"creditsUsed":0`，普通搜索 `"creditsUsed":2`
- **mcp 描述属实**：dist 中 "government search is free" 与官方文档 "Government Index searches are free and use no credits" 一致。
- **额外发现**：gov 端点**无需 API key 即可调用**（不带 Authorization 头直连云端 → HTTP 200）；带 key 只是提高速率上限。SDK：`firecrawl` ≥4.44.1 / `firecrawl-py` ≥4.49.2 有 `govSearch`/`gov_search`。

## 5. 结论建议

**gov 能力本身质量高、且真免费**：对"美国法律/监管一手文本"问答（FDA/EPA/CAA/CFR/USC/州法/判例/FR 规则），召回质量明显优于普通 web 搜索 + site:gov，响应字段虽简单（url/title/description/position）但够引导后续 scrape 精读原文。

对"是否值得在 self-host mcp 里保留 gov 工具走云端 key"的建议——**值得恢复**：

1. **可以恢复 `firecrawl_gov_search`（或等价地在 `firecrawl_search` 放开 `categories:["gov"]`）**，理由：
   - 零 credits 成本；
   - 对科研/开发场景有实际用例：引用美国联邦法规（21 CFR Part 11 电子记录、CAA、HIPAA 类合规问题）、查 FDA/EPA 一手指南时比 web 搜索快且权威；
   - 失败面可控：云端路由失败时上游已有降级话术（"use general search for non-US questions or missing coverage"）。
2. **走 rotator `/firecrawl` 前缀**（有 key、速率上限高、有审计日志）；keyless 理论上也可直连，但速率上限低且无审计，不建议作为主路径。
3. 若不改 patch 保持禁用也**不构成实质损失**：同一能力经 rotator 用一行 curl 即可拿到（`GET /firecrawl/v2/search/gov?query=...&k=10`），只是失去 agent 自动选路便利。

倾向性结论：**恢复 gov 工具（走 rotator 前缀）收益 > 成本**。恢复的前提是把 mcp 的 gov 客户端 base URL 指向 rotator（mcp dist 里 `src/gov.ts` 走 `FIRECRAWL_API_URL`，直接指到自建 api 会 404，需要 env 覆盖或小 patch 确认），并按 mcp patch 双层验证清单回归锚点。

## 附：排查方向（若未来调用失败）

- rotator 侧：`docker logs api-key-rotator` 看 `profile=firecrawl matched=true ... status=...`；本次所有测试请求均为 status=200、轮转了多个 key。
- 云端侧：直连 `https://api.firecrawl.dev/v2/search/gov?query=test` 不带 key 验证端点存活（免 key）。
- 计费断言回归：`/v2/team/credit-usage` 前后差值法（注意 rotator 轮转 11 key，但 remaining 是团队级视图，delta 可信）。

## 参考

- [Firecrawl Government Index 文档](https://docs.firecrawl.dev/features/gov)
- [Firecrawl Search API 参考（gov category）](https://docs.firecrawl.dev/api-reference/endpoint/search)
- 本地源码证据：firecrawl-mcp 3.33.4 dist（`src/gov.ts`：`BASE2="/v2/search/gov"`；SEARCH_PROFILE_INSTRUCTIONS："government search is free"）
