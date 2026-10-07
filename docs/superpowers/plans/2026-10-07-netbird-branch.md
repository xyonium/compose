# netbird 分支实施计划（脚本渲染同步 + Agent Network）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `netbird` orphan 分支（官方脚本渲染同步 + 三文件合并 + Agent Network 全功能），并在 main 上落地配套 sync workflow 与索引。

**Architecture:** GitHub Action 里 `source` 官方 `getting-started.sh`（去掉 `init_environment` 入口）只调渲染函数：option 1 渲染出 base compose（dashboard + netbird-server，docker1 固定证书风格标签），option 0+proxy 渲染后 python 提取 proxy 服务片段；手写的 override 完成镜像 mirror、env inline、密钥外置、私有模式定制；三文件 `docker compose config --no-interpolate` 合并 + 3 镜像钉 digest 产出部署文件。

**Tech Stack:** bash / python3+PyYAML / docker compose v2 / GitHub Actions。

**Spec:** [docs/superpowers/specs/2026-10-07-netbird-agent-network-design.md](../specs/2026-10-07-netbird-agent-network-design.md)

## Global Constraints

- 镜像一律走 mirror `jcr.savorcare.com/docker/netbirdio/{netbird-server,dashboard,reverse-proxy}`；**GitHub runner 与本机都不可访问该 mirror**，digest 从 docker.io 解析后 sed 回写。
- secrets 不进 git：`config.yaml` 三个密钥洗成 `__GENERATE_AT_DEPLOY__`，`NB_PROXY_TOKEN` 以 `${NB_PROXY_TOKEN}` 模板保留（合并用 `--no-interpolate`）。
- 定时 `schedule:` 保持注释禁用（与其他分支一致），只开 `workflow_dispatch`。
- bot 提交身份：`github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`。
- commit message 沿用仓库中文惯例（如 `sync: upstream compose + image digests (YYYY-MM-DD)`）。
- 本机无 docker daemon：本地钉 digest 用 registry HTTP API（Task 3 给出已验证命令）；workflow 里用 `docker buildx imagetools inspect`（runner 有 docker）。
- 域名固定 `netbird.savorcare.com`，目标主机 docker1（固定证书 `tls=true`，无 certresolver）。

## Review Focus

1. **上游脚本结构变化**（函数改名/`init_environment` 入口变化）→ 渲染前 `type` 检查 5 个函数，缺失即失败（Task 1/5/7 哨兵）。
2. **上游 proxy 服务字段漂移**（端口/卷/env_file 改名）→ 片段提取自动跟进，merged 反向哨兵不含旧假设、正向哨兵含 `51820`/`netbird_proxy_certs`（Task 3/5）。
3. **digest 解析失败**（docker hub 限流 / tag 消失）→ sed 后必须 `grep -q image@digest`，且 digest 非空检查（Task 3/5）。
4. **`config.yaml` 洗密钥漏字段**（上游新增密钥字段）→ 反向断言：文件不得残留 `base64` 形态长串（`[A-Za-z0-9+/]{40,}` 正则），正向断言 3 个占位符（Task 1/5）。
5. **compose 版本合并语义差异**（runner 的 compose 版本与本地 v5.6.0 不同）→ workflow 合并后跑独立解析 + 全套哨兵；反向断言 `env_file`/`./config.yaml` 不得出现（Task 5/7）。

---

### Task 1: netbird orphan 分支创建 + 上游产物渲染（本地）

**Files:**
- Create（worktree `../compose-netbird` 内）: `docker-compose.upstream.yaml`、`docker-compose.upstream-proxy.yaml`、`config.yaml`、`dashboard.env`、`proxy.env`

**Interfaces:**
- Produces: 四个 bot 文件，供 Task 3 合并；渲染流程与 Task 5 的 workflow 步骤逐字一致（workflow 照抄本任务命令）。

- [ ] **Step 1: 创建 orphan 分支 worktree**

```bash
cd /home/eli/compose
git worktree add ../compose-netbird --orphan netbird 2>/dev/null || {
  # git < 2.42 不支持 --orphan 的 fallback
  git worktree add --no-checkout ../compose-netbird && cd ../compose-netbird && git checkout --orphan netbird && git rm -rf . 2>/dev/null; cd /home/eli/compose
}
```
验证：`cd ../compose-netbird && git branch --show-current` → `netbird`，`ls -A` 只剩 `.git`。

- [ ] **Step 2: 拉脚本、去入口、函数哨兵**

```bash
cd ../compose-netbird
curl -fsSL https://github.com/netbirdio/netbird/releases/latest/download/getting-started.sh -o /tmp/nb-gs.sh
sed -i 's/^init_environment$//' /tmp/nb-gs.sh
grep -q "^init_environment$" /tmp/nb-gs.sh && echo "FAIL: entrypoint not stripped" || echo "OK stripped"
( source /tmp/nb-gs.sh; for fn in initialize_default_values configure_domain configure_reverse_proxy generate_configuration_files render_proxy_env; do type $fn >/dev/null || { echo "FAIL: missing $fn"; exit 1; }; done; echo "OK functions" )
```
预期：`OK stripped` + `OK functions`。若函数缺失 → 停，上游改了脚本结构，需人工评估。

- [ ] **Step 3: 第一次渲染（base，option 1）**

```bash
( source /tmp/nb-gs.sh
  export NETBIRD_DOMAIN=netbird.savorcare.com NETBIRD_NON_INTERACTIVE=true
  export NETBIRD_REVERSE_PROXY_TYPE=1 NETBIRD_TRAEFIK_EXTERNAL_NETWORK=reverse-proxy
  export NETBIRD_TRAEFIK_ENTRYPOINT=websecure NETBIRD_TRAEFIK_CERTRESOLVER=
  initialize_default_values; configure_domain; configure_reverse_proxy
  mkdir -p /tmp/nb-base && cd /tmp/nb-base && generate_configuration_files )
```
验证：`/tmp/nb-base/docker-compose.yml` 存在；`grep -c "certresolver" /tmp/nb-base/docker-compose.yml` → `0`；`grep "reverse-proxy" /tmp/nb-base/docker-compose.yml` 非空；`grep "traefik:" /tmp/nb-base/docker-compose.yml` → 无该服务行（`grep -cE "^  traefik:"` → `0`）。
（trustedPeers 警告属预期，忽略。）

- [ ] **Step 4: 第二次渲染（full，option 0 + proxy）并提取片段**

```bash
( source /tmp/nb-gs.sh
  export NETBIRD_DOMAIN=netbird.savorcare.com NETBIRD_NON_INTERACTIVE=true
  export NETBIRD_REVERSE_PROXY_TYPE=0 NETBIRD_ENABLE_PROXY=true NETBIRD_LETSENCRYPT_EMAIL=ops@savorcare.com
  initialize_default_values; configure_domain; configure_reverse_proxy
  mkdir -p /tmp/nb-full && cd /tmp/nb-full && generate_configuration_files
  PROXY_TOKEN=__SET_ME__ render_proxy_env > proxy.env )
```
提取（python3，PyYAML 本机已装）：
```python
import yaml
full = yaml.safe_load(open('/tmp/nb-full/docker-compose.yml'))
frag = {'services': {'proxy': full['services']['proxy']},
        'volumes': {'netbird_proxy_certs': full['volumes']['netbird_proxy_certs']}}
yaml.dump(frag, open('docker-compose.upstream-proxy.yaml','w'),
          default_flow_style=False, allow_unicode=True, sort_keys=False, width=120)
```
验证：片段中 `services.proxy.image` 含 `netbirdio/reverse-proxy`、`ports` 含 `51820`、`volumes.netbird_proxy_certs` 键存在、`labels` 含 `HostSNI`（来自上游，稍后被 override 覆盖）。

- [ ] **Step 5: 落定 bot 文件 + 洗密钥**

```bash
cp /tmp/nb-base/docker-compose.yml docker-compose.upstream.yaml
cp /tmp/nb-base/dashboard.env dashboard.env
cp /tmp/nb-base/config.yaml config.yaml
cp /tmp/nb-full/proxy.env proxy.env
sed -i -E 's/(authSecret: )"[^"]*"/\1"__GENERATE_AT_DEPLOY__"/; s/(sessionCookieEncryptionKey: )"[^"]*"/\1"__GENERATE_AT_DEPLOY__"/; s/(encryptionKey: )"[^"]*"/\1"__GENERATE_AT_DEPLOY__"/' config.yaml
```
验证：`grep -c "__GENERATE_AT_DEPLOY__" config.yaml` → `3`；`grep -cE '"[A-Za-z0-9+/]{40,}=?"' config.yaml` → `0`（无残留 base64 密钥形态）。

- [ ] **Step 6: Commit**

```bash
git add docker-compose.upstream.yaml docker-compose.upstream-proxy.yaml config.yaml dashboard.env proxy.env
git commit -m "feat: 上游渲染产物（脚本 option1 base + option0 proxy 片段，密钥脱敏）"
```

---

### Task 2: override 文件（docker-compose.portainer.yaml）

**Files:**
- Create: `../compose-netbird/docker-compose.portainer.yaml`

**Interfaces:**
- Consumes: Task 1 的两个 upstream 文件（合并输入）。
- Produces: 唯一手改文件；Task 3 合并、Task 5 workflow 均假定其内容不变。

- [ ] **Step 1: 写入以下完整内容**（合并语义已实测：`!reset null` 清 env_file；`!override` 整体替换 volumes/networks/labels；labels 列表追加合并）

```yaml
# 平台自定义层：与 docker-compose.upstream.yaml + docker-compose.upstream-proxy.yaml 合并使用
# 合并产物 docker-compose.yaml 由 main 分支的 sync-netbird.yml 工作流生成
#（bot 维护，勿手改）；要调整部署只改本文件。
#
# 自定义内容：
#   1. 镜像全部走私服 mirror（jcr.savorcare.com 的 docker hub 代理）
#   2. 密钥外置：config.yaml → netbird_config 命名卷（灌注见 README）；
#      NB_PROXY_TOKEN → 平台项目 env（${NB_PROXY_TOKEN} 模板保留）
#   3. dashboard env 内联（无密钥）+ 开启 Agent Network 区块（非 ONLY 模式）
#   4. traefik docker1 风格固定证书（标签由上游 option 1 渲染自带 tls=true），
#      这里只补 web 入口 http2https 跳转
#   5. proxy 私有模式：无 traefik 路由（agent 流量走 WG 隧道直连），
#      ACME 关闭，TLS 用 docker1 同步的泛域名证书（/wildcard-certs 挂载）

name: netbird

services:
  dashboard:
    image: jcr.savorcare.com/docker/netbirdio/dashboard:latest
    env_file: !reset null
    environment:
      NETBIRD_MGMT_API_ENDPOINT: https://netbird.savorcare.com
      NETBIRD_MGMT_GRPC_API_ENDPOINT: https://netbird.savorcare.com
      AUTH_AUDIENCE: netbird-dashboard
      AUTH_CLIENT_ID: netbird-dashboard
      AUTH_CLIENT_SECRET: ""
      AUTH_AUTHORITY: https://netbird.savorcare.com/oauth2
      USE_AUTH0: "false"
      AUTH_SUPPORTED_SCOPES: openid profile email groups
      AUTH_REDIRECT_URI: /nb-auth
      AUTH_SILENT_REDIRECT_URI: /nb-silent-auth
      NGINX_SSL_PORT: "443"
      LETSENCRYPT_DOMAIN: none
      NETBIRD_AGENT_NETWORK_ENABLED: "true"
    labels:
      - "traefik.http.routers.netbird-http.rule=Host(`netbird.savorcare.com`)"
      - "traefik.http.routers.netbird-http.entrypoints=web"
      - "traefik.http.routers.netbird-http.middlewares=http2https"

  netbird-server:
    image: jcr.savorcare.com/docker/netbirdio/netbird-server:latest
    # !override 整体替换上游 volumes：./config.yaml bind → netbird_config 命名卷
    volumes: !override
      - netbird_data:/var/lib/netbird
      - netbird_config:/etc/netbird

  proxy:
    image: jcr.savorcare.com/docker/netbirdio/reverse-proxy:latest
    env_file: !reset null
    environment:
      NB_PROXY_DEBUG_LOGS: "false"
      NB_PROXY_MANAGEMENT_ADDRESS: http://netbird-server:80
      NB_PROXY_ALLOW_INSECURE: "true"
      NB_PROXY_DOMAIN: netbird.savorcare.com
      NB_PROXY_ADDRESS: :8443
      NB_PROXY_TOKEN: ${NB_PROXY_TOKEN}
      NB_PROXY_CERTIFICATE_DIRECTORY: /certs
      NB_PROXY_ACME_CERTIFICATES: "false"
      NB_PROXY_FORWARDED_PROTO: https
      NB_PROXY_PROXY_PROTOCOL: "false"
      NB_PROXY_PRIVATE: "true"
      # 固定 WG 端口配合宿主 UDP 映射（单账号部署适用）
      NB_PROXY_WG_PORT: "51820"
      # docker1 证书同步目录（含 *.netbird.savorcare.com），实际路径以 README 为准
      NB_PROXY_WILDCARD_CERT_DIR: /wildcard-certs
    # !override 整体替换上游 labels：私有模式不暴露任何 traefik 路由
    labels: !override
      - "traefik.enable=false"
    # !override 重定向网络：与 server 同网，管理面内网直连
    networks: !override
      - reverse-proxy
    volumes:
      - netbird_proxy_certs:/certs
      - /opt/traefik/certs:/wildcard-certs:ro

volumes:
  netbird_config:
```

- [ ] **Step 2: 验证 YAML 可解析**

Run: `python3 -c "import yaml; yaml.safe_load(open('../compose-netbird/docker-compose.portainer.yaml'))"`
（注意：PyYAML 不认 `!reset`/`!override` tag，需 `yaml.safe_load` 加 loader 或改用
`python3 -c "import yaml; yaml.load(open('...'), Loader=yaml.BaseLoader)"`——用 BaseLoader。）
Expected: 无异常。

- [ ] **Step 3: Commit**

```bash
git add docker-compose.portainer.yaml
git commit -m "feat: 平台自定义层（mirror、密钥外置、agent network、固定证书）"
```

---

### Task 3: 合并 + 钉 digest + 哨兵 → docker-compose.yaml

**Files:**
- Create: `../compose-netbird/docker-compose.yaml`

**Interfaces:**
- Consumes: Task 1/2 全部产物。
- Produces: 部署平台直接消费的最终文件；哨兵清单被 Task 5 workflow 复用。

- [ ] **Step 1: 三文件合并**

```bash
cd ../compose-netbird
COMPOSE=/tmp/nbtest/docker-compose   # 设计期已下载的 v5.6.0 standalone；若无则重新下载
$COMPOSE -f docker-compose.upstream.yaml -f docker-compose.upstream-proxy.yaml \
  -f docker-compose.portainer.yaml config --no-interpolate > docker-compose.yaml
```
预期：无报错产出。

- [ ] **Step 2: 钉 3 个镜像 digest（本机用 registry API；已验证）**

对 `netbird-server`、`dashboard`、`reverse-proxy` 三个仓库各执行：

```bash
repo=netbirdio/netbird-server   # 依次换 dashboard / reverse-proxy
token=$(curl -fsSL "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
digest=$(curl -fsSI -H "Authorization: Bearer $token" \
  -H "Accept: application/vnd.oci.index.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://registry-1.docker.io/v2/${repo}/manifests/latest" | grep -i docker-content-digest | awk '{print $2}' | tr -d '\r')
[ -n "$digest" ] || { echo "FAIL: empty digest for $repo"; exit 1; }
image="jcr.savorcare.com/docker/${repo}"
sed -i -E "s#${image}(:[[:alnum:]_.-]+)?(@sha256:[[:xdigit:]]{64})?[[:space:]]*\$#${image}@${digest}#" docker-compose.yaml
grep -q "${image}@${digest}" docker-compose.yaml || { echo "FAIL: pin $image"; exit 1; }
```

- [ ] **Step 3: 哨兵校验**

正向：
```bash
for needle in "name: netbird" "netbird.savorcare.com" \
  "container_name: netbird-server\$" "container_name: netbird-dashboard" "container_name: netbird-proxy" \
  "jcr.savorcare.com/docker/netbirdio" "@sha256:" "traefik.enable" "http2https" "reverse-proxy" \
  "netbird_data" "netbird_config" "netbird_proxy_certs" 'NB_PROXY_TOKEN: \${NB_PROXY_TOKEN}' \
  "NETBIRD_AGENT_NETWORK_ENABLED" "NB_PROXY_PRIVATE" "3478" "51820"; do
  grep -qE "$needle" docker-compose.yaml || { echo "FAIL missing $needle"; exit 1; }
done
grep -c "@sha256:" docker-compose.yaml   # 必须 = 3
```
反向（每个都不得出现）：
```bash
for bad in "./config.yaml" "netbird-traefik" "certresolver" 'HostSNI(`\*`)' "pp-v2" "env_file" "NETBIRD_AGENT_NETWORK_ONLY"; do
  grep -qF "$bad" docker-compose.yaml && { echo "FAIL found $bad"; exit 1; }
done
echo "sentinels OK"
```

- [ ] **Step 4: 独立解析验证**

Run: `NB_PROXY_TOKEN=dummy $COMPOSE -f docker-compose.yaml config --quiet`
Expected: 无输出无报错。

- [ ] **Step 5: Commit + push 分支**

```bash
git add docker-compose.yaml
git commit -m "feat: 预合并产物（3 镜像钉 digest $(date -u +%F)）"
git push origin netbird
```

---

### Task 4: 分支 README

**Files:**
- Create: `../compose-netbird/README.md`

**Interfaces:**
- Produces: 部署/bootstrap 的唯一操作文档（平台 env 仅 `NB_PROXY_TOKEN` 必填）。

- [ ] **Step 1: 写 README，必备章节**

1. 项目简介：NetBird 全功能（VPN 管理 + Agent Network Beta），docker1，`https://netbird.savorcare.com`。
2. 文件分工表（四文件模式说明 + `config.yaml`/`dashboard.env`/`proxy.env` 三个 bot 参考件）。
3. 平台项目 env：仅 `NB_PROXY_TOKEN`（首次填占位，部署后换真 token，步骤见下）。
4. 首次 bootstrap（按序）：DNS A 记录；OPNSense 证书含 `*.netbird.savorcare.com` 并同步到 docker1；
   UDP 3478/51820 端口预检；从分支 `config.yaml` 模板生成真实配置
   （3×`openssl rand -base64 32`，`encryptionKey` 保留尾部 `=`；`reverseProxy.trustedPeers`
   填 docker1 traefik 在 reverse-proxy 网络的源地址）灌入 `netbird_netbird_config` 卷；
   Arcane 建项目部署；`docker exec netbird-server /go/bin/netbird-server admin token create
   --name "default-proxy" --config /etc/netbird/config.yaml` 取 token 填入项目 env 重建；
   `/setup` 建管理员。
5. Agent Network 验证：Providers → endpoint → Policies → overlay 内 curl → Usage & Logs。
6. 自定义摘要：mirror、固定证书标签、http2https、密钥外置、proxy 私有模式 +
   静态泛域名证书挂载（`/opt/traefik/certs` 为占位路径，以 docker1 实际同步落盘为准）。
7. 回退方案（默认不启用）：proxy 公网暴露需加 `HostSNIRegexp` TCP passthrough +
   ACME + pp-v2，做法记录。
8. 回滚：revert sync commit + Arcane 重新同步。

- [ ] **Step 2: Commit + push**

```bash
git add README.md && git commit -m "docs: 分支 README（bootstrap/env/回滚）" && git push origin netbird
```

---

### Task 5: main 的 sync-netbird.yml

**Files:**
- Create: `.github/workflows/sync-netbird.yml`（main 分支，/home/eli/compose）

**Interfaces:**
- Consumes: Task 1 的渲染命令（逐字复用，仅替换提取/钉版工具）、Task 3 的哨兵清单。
- Produces: 定时/手动同步入口。

- [ ] **Step 1: 写 workflow**

结构与现有三个 sync workflow 一致（header 注释、permissions、concurrency `netbird-sync`、
checkout ref netbird），schedule 保持注释：

```yaml
  # schedule:
  #   - cron: "27 4 5 * *" # 每月 5 日 04:27 UTC（北京 12:27，与 authentik 再错开 15 分钟）
```

核心 run 步骤按序（全部是 Task 1/3 已验证命令的 runner 版）：

1. **Render upstream artifacts**：下载脚本 → 去入口 → 函数哨兵 → 两次渲染
   （env 与 Task 1 逐字相同）→ python 提取片段（`python3 -c "import yaml" ||
   pip install --quiet pyyaml` 兜底）→ 洗 `config.yaml` → 覆盖分支内 4+3 个 bot 文件。
2. **Merge, pin image digests and validate**：三文件合并 → 用
   `docker buildx imagetools inspect <repo>:latest --format '{{.Manifest.Digest}}'`
   依次钉 `netbirdio/netbird-server`、`netbirdio/dashboard`、`netbirdio/reverse-proxy`
   （sed 写法照抄 sync-sub2api.yml，含非空检查与 grep 回验）→ Task 3 的全套正/反向哨兵 →
   `NB_PROXY_TOKEN=dummy docker compose -f docker-compose.yaml config --quiet`。
3. **Commit and push if changed**：照抄现有 workflow 的 git 段，`git add` 列表为
   `docker-compose.upstream.yaml docker-compose.upstream-proxy.yaml docker-compose.yaml
   config.yaml dashboard.env proxy.env`。

- [ ] **Step 2: 验证**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/sync-netbird.yml'))" && grep -c "netbird.savorcare.com" .github/workflows/sync-netbird.yml`
Expected: 解析通过；域名出现次数 ≥ 2（两次渲染 env）。

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/sync-netbird.yml
git commit -m "feat: netbird 分支同步工作流（脚本渲染 + 片段提取 + 钉版 + 哨兵）"
```

---

### Task 6: main 索引更新

**Files:**
- Modify: `/home/eli/compose/README.md`（分支索引表 + 三文件模式说明改四文件口径）
- Modify: `/home/eli/compose/AGENTS.md`（新增 netbird 小节）

- [ ] **Step 1: README 索引表加行**

```
| [`netbird`](https://github.com/xyonium/compose/tree/netbird) | [netbirdio/netbird](https://github.com/netbirdio/netbird) | docker1 | https://netbird.savorcare.com | VPN + Agent Network（上游无静态 compose，Action source 官方 getting-started.sh 渲染生成；多一个 bot 提取文件 docker-compose.upstream-proxy.yaml） |
```
并把"分支内文件分工（三文件模式）"小节标题/说明改为通用口径，注明 netbird 多一个
upstream 片段文件 + 三个 bot 参考件。

- [ ] **Step 2: AGENTS.md 加 netbird 小节**

参照 firecrawl/sub2api 小节风格，要点：脚本渲染同步机制（source 渲染、不起容器）、
四文件模式、密钥外置（config 命名卷 + NB_PROXY_TOKEN 项目 env）、docker1 固定证书、
proxy 私有模式无 traefik 路由、泛域名证书来自 OPNSense 同步挂载。

- [ ] **Step 3: Commit + push main**

```bash
git add README.md AGENTS.md
git commit -m "docs: 索引与 AGENTS 收录 netbird 分支"
git push origin main
```

---

### Task 7: workflow 逻辑端到端干跑（幂等验证）

**Files:**
- 无新文件；在 `/tmp/nb-e2e` 全新目录模拟。

**Interfaces:**
- Consumes: Task 5 workflow 的全部 run 步骤、Task 1-3 已提交的分支产物。

- [ ] **Step 1: 模拟 workflow**

在 `/tmp/nb-e2e` 检出 `netbird` 分支，逐字执行 workflow 的 Render/Merge/Pin/Validate
步骤（钉版用 runner 同款逻辑在本机以 registry API 替代，预期 digest 相同——
`latest` tag 短期内不变；若恰好上游发版导致 digest 变化，以 registry API 结果为准并
接受该 diff 为正当更新）。

- [ ] **Step 2: 对比**

Run: `git -C /tmp/nb-e2e diff --stat`（对 branch 内已提交文件）
Expected: 无实质 diff（允许 digest 因上游发版不同——此时说明同步逻辑正是为此工作）。

- [ ] **Step 3: 汇总验收清单**

向用户报告：分支文件列表、merged 文件哨兵结果、digest 值、dry-run 结果；
提示后续人工动作（Arcane 建项目、DNS、OPNSense 证书、bootstrap 步骤在分支 README）。
```

---

## Self-Review 记录

- **Spec coverage**：spec 的文件布局（T1/T2/T3）、workflow（T5）、README/bootstrap（T4）、
  索引/AGENTS（T6）、验证计划（T3/T7）、回滚（T4 README 章节 8）均有对应任务。
  spec 的"回退方案（passthrough）"落在 T4 README 章节 7，不落 compose（默认不启用）✓。
- **Step scan**：每个步骤的命令均为已本地验证的逐字命令；无 TBD。
- **Type consistency**：文件名/服务名/卷名/环境变量名在任务间一致
  （`docker-compose.upstream-proxy.yaml`、`netbird_config`、`NB_PROXY_TOKEN` 等）。
- **Review Focus**：5 项均有对应哨兵/验证步骤。
- **Proportion**：两个全文文件（override、README 章节要求）是决策载体本身；
  workflow 以步骤摘要+精确命令给出而非全文转录。
