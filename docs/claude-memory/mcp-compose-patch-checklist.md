---
name: mcp-compose-patch-checklist
description: firecrawl-mcp 运行时 patch 的双层验证清单（JS 逻辑层 + compose/sh 传递层），撇号坑已两次踩中
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1d70aec2-755d-4fd3-a6ae-8589841ca1a5
  modified: 2026-09-29T07:06:31.540Z
---

firecrawl-mcp 的启动 patch 藏在 docker-compose.deploy.yaml 的 `node -e '...'` 里，改它必须做**两层**验证，只测第一层已经翻车一次（2026-09-28，`0c24ca8b`）：

1. **JS 逻辑层**：在钉版镜像的 dist 副本上跑 patch 片段，验证锚点唯一、ESM 语法（.mjs）、幂等。
2. **compose/sh 传递层**：从 `docker compose config` 提取**完整 command 串**（不是手抄片段），原样作为 `sh -c` 的单个 argv 在钉版镜像 + 全新 dist 副本上执行，确认 patch 全部应用且服务真的启动、tools/list 正确。

**Why:** 脚本体包在单引号里，sh 单引号内无任何转义——JS 内容里出现 `'`（英文缩写 can't/don't/it's）直接终结脚本体，容器 crash loop。写 patch 时任何文本（注释、describe 内容）都禁用撇号；patch #9 注释里早就写了 no apostrophes，patch #11 的注释自己又踩了。同理：禁反引号与 `${`（compose 插值层）、禁 `\n` 之外的转义歧义。

**How to apply:** 改 firecrawl-mcp patch 后的 e2e 必须覆盖**全部三层**：(1) JS 语法（`new Function`）+ 撇号=0；(2) **compose 插值层**——从 YAML 提取 command 后模拟 `$$X→$X`、未定义 `${VAR}→空` 再验证锚点仍能匹配 dist（2026-09-29 两次翻车：`node -e` 单引号体内的撇号截断脚本；patch 锚点里写了 `${ALEXANDRIA_SEARCH_LEAD}` 被 compose 插值清空成 4 个换行、静默不匹配）。patch 锚点字符串里**任何** `${...}` 形态都必须写成 `$${...}`；(3) 钉版镜像+全新 dist 容器真实启动 + tools/list 验证。提取 command 用 `python3 yaml.safe_load` 直读 YAML；`docker compose config` 输出会把字面 `$` 显示为 `$$`，不能当真实值。相关体系见 [[firecrawl-portainer-selfhost-setup]]。
