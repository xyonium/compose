# netbird 分支设计：官方脚本渲染同步 + Agent Network 全功能

日期：2026-10-07
状态：待审阅

## 背景与目标

仓库新增 `netbird` orphan 分支，部署 NetBird 全功能（常规 VPN 管理 + Agent Network Beta）。
上游没有静态 compose 文件——官方安装入口是交互式脚本 `getting-started.sh`
（`https://github.com/netbirdio/netbird/releases/latest/download/getting-started.sh`，
内嵌 Dex IdP，1782 行自包含 bash）。本设计回答一个问题：如何把"脚本生成"接入仓库既有的
三文件同步模式，同时最大化跟踪上游变更、最小化手抄。

决策摘要：**在 Action 里 source 脚本、只调渲染函数（不部署），渲染两次**——
option 1（外部 traefik）产出 base compose；option 0（内建 traefik + proxy）产出完整栈，
从中用 yq/python **提取** proxy 服务片段作第二个 upstream 文件。三文件合并出最终产物。

- 目标主机：docker1（traefik 固定证书风格：`tls=true`，无 certresolver，证书由
  OPNSense 经同步脚本下发，将包含 `*.netbird.savorcare.com`）
- 域名：`netbird.savorcare.com`
- Dashboard：完整 NetBird + Agent Network 区块（`NETBIRD_AGENT_NETWORK_ENABLED=true`，
  **不用**官方 preset 的 `NETBIRD_AGENT_NETWORK_ONLY=true`）

## 关键调研结论（全部经源码/实测验证）

1. **脚本可无人值守、可只渲染不部署**。所有交互项都有环境变量（`NETBIRD_DOMAIN`、
   `NETBIRD_REVERSE_PROXY_TYPE`、`NETBIRD_NON_INTERACTIVE=true` 等）；模板全为内嵌
   heredoc；脚本末尾唯一入口是 `init_environment`——`sed` 删掉后 `source`，手动依次调
   `initialize_default_values → configure_domain → configure_reverse_proxy →
   generate_configuration_files`，纯文本渲染，不触碰 docker daemon、不起容器、
   不执行 `docker compose up`、不等待就绪（域名指向生产机时等待循环会死等，必须跳过）。
2. **密钥位置**：`config.yaml` 内嵌 3 个随机密钥（relay `authSecret`、
   `sessionCookieEncryptionKey`、store `encryptionKey`），`combined/cmd/config.go` 的
   `LoadConfig` 就是 `os.ReadFile + yaml.Unmarshal`，**不支持环境变量展开**，也没有
   顶层 env 覆盖。`proxy.env` 的 `NB_PROXY_TOKEN` 必须由运行中的 server 执行
   `admin token create` 生成。`dashboard.env` 无密钥。
3. **Agent Network 流量路径**（`agent-network/README.md` + docs）：proxy 是一个
   **WireGuard peer**（内嵌 userspace netstack，无需 TUN/NET_ADMIN），agent 流量
   "flows only over the encrypted NetBird tunnel"，endpoint "only reachable from inside
   your overlay"。**traefik 不在 agent 数据路径上**；身份来自 WG 源 IP 映射，
   经任何 L4/L7 代理转发都会破坏（官方 pp-v2 标签就是为公网 passthrough 保源 IP）。
4. **proxy 证书机制**（`proxy/cmd/proxy/cmd/root.go`）：支持
   `NB_PROXY_WILDCARD_CERT_DIR`——目录内 `<name>.crt`/`<name>.key` 证书对，
   自动从 SAN 提取通配符模式，配 `certwatch` 热更新。**docker1 同步来的
   `*.netbird.savorcare.com` 证书直接挂进 proxy 即可，ACME、traefik TCP passthrough、
   PROXY protocol 全部不需要**。
5. **dashboard 环境变量**（`docker/init_react_envs.sh`）：`NETBIRD_AGENT_NETWORK_ENABLED`
   （显示区块）与 `NETBIRD_AGENT_NETWORK_ONLY`（锁纯 agent 面板）都支持，默认均 false。
6. **资源要求**：官方 quickstart 最低 1 vCPU / 2GB RAM（整栈独立 VM 口径）。
   我们复用 docker1 现有 traefik，新增 3 个容器（dashboard / netbird-server / proxy），
   proxy 内存随并发 LLM 流量增长，docker1 预留 ≥1 vCPU + 1.5GB 内存余量即可。
7. **option 0 与 option 1 渲染差异**（实测 diff）：option 0 的 gRPC 路由多
   `/management.ProxyService/` 前缀（供**远程** proxy 经公网注册用；我们的 proxy 与
   server 同栈内网直连 `:80`，不需要）；option 0 的 config.yaml 多
   `trustedPeers: 172.30.0.10/32`（内建 traefik IP，对 docker1 无意义）。

## 分支文件布局（`netbird` orphan 分支）

| 文件 | 内容 | 维护者 |
|---|---|---|
| `docker-compose.upstream.yaml` | 脚本 option 1 渲染原样产物（dashboard + netbird-server） | bot |
| `docker-compose.upstream-proxy.yaml` | 脚本 option 0+proxy 渲染后提取的 proxy 服务 + `netbird_proxy_certs` 卷（YAML 往返丢注释，可接受） | bot |
| `docker-compose.portainer.yaml` | 全部定制（唯一手改文件） | 手改 |
| `docker-compose.yaml` | 三文件 `config --no-interpolate` 合并产物 + 3 镜像钉 digest | bot |
| `config.yaml` | 渲染参考模板，3 个密钥洗成占位符 | bot |
| `dashboard.env` | 渲染参考（无密钥） | bot |
| `proxy.env` | 渲染参考（`NB_PROXY_TOKEN=__SET_ME__`） | bot |
| `README.md` | 文件分工、env 必填项、bootstrap、回滚 | 手改 |

## sync workflow（main：`sync-netbird.yml`）

触发：`workflow_dispatch` + 定时注释（与其他 workflow 错开 15 分钟：每月 5 日 04:27 UTC）。
concurrency group `netbird-sync`。

步骤：

1. checkout `netbird` 分支。
2. 拉取 release 版 `getting-started.sh`（`releases/latest/download/`，跟随正式 release），
   `sed -i 's/^init_environment$//'` 去掉入口。哨兵前置：`type` 检查四个函数存在
   （`initialize_default_values`/`configure_domain`/`configure_reverse_proxy`/
   `generate_configuration_files`）——上游重构脚本结构时大声失败。
3. **第一次渲染（base）**，子 shell：
   `NETBIRD_DOMAIN=netbird.savorcare.com`、`NETBIRD_NON_INTERACTIVE=true`、
   `NETBIRD_REVERSE_PROXY_TYPE=1`、`NETBIRD_TRAEFIK_EXTERNAL_NETWORK=reverse-proxy`、
   `NETBIRD_TRAEFIK_ENTRYPOINT=websecure`、`NETBIRD_TRAEFIK_CERTRESOLVER=`（空 →
   只生成 `tls=true`，docker1 固定证书风格）。
   产出 → `docker-compose.upstream.yaml`、`dashboard.env`、`config.yaml`（洗密钥）。
4. **第二次渲染（proxy 片段）**，子 shell：
   `NETBIRD_REVERSE_PROXY_TYPE=0`、`NETBIRD_ENABLE_PROXY=true`、
   `NETBIRD_LETSENCRYPT_EMAIL=ops@savorcare.com`（option 0 必填，值只落在被丢弃的
   内建 traefik 命令行里）。
   提取（yq 或 python3+yaml，runner 均自带）：
   `{services: {proxy: ...}, volumes: {netbird_proxy_certs: ...}}` →
   `docker-compose.upstream-proxy.yaml`。**不提取 networks 块**（proxy 网络由 override
   重定向到 reverse-proxy）；另以 `PROXY_TOKEN=__SET_ME__ render_proxy_env > proxy.env`
   生成参考件。
5. `config.yaml` 洗密钥：3 个密钥值 sed 替换为 `__GENERATE_AT_DEPLOY__` 占位，
   哨兵确认替换发生且文件不含 base64 密钥形态。
6. 合并 + 钉版 + 校验：
   - `docker compose -f upstream -f upstream-proxy -f portainer config --no-interpolate`；
   - 钉 3 个镜像 digest：`netbirdio/netbird-server`、`netbirdio/dashboard`、
     `netbirdio/reverse-proxy`（docker.io 解析 `latest` → sed 回写
     `jcr.savorcare.com/docker/netbirdio/*` 行，沿用现有 workflow 的行尾锚定写法）；
   - 哨兵见下节；
   - `NB_PROXY_TOKEN=dummy docker compose -f docker-compose.yaml config --quiet`
     独立解析验证。
7. 有变化才提交推回 `netbird` 分支。

### 哨兵清单

正向（merged 必须出现）：`name: netbird`、`netbird.savorcare.com`、
`container_name: netbird-server`（行尾锚定防误匹配）、`container_name: netbird-dashboard`、
`container_name: netbird-proxy`、`jcr.savorcare.com/docker/netbirdio/` ×3 + `@sha256:` ×3、
`traefik.enable`、`http2https`、`reverse-proxy`、`netbird_data`、`netbird_config`、
`netbird_proxy_certs`、`NB_PROXY_TOKEN`、`NETBIRD_AGENT_NETWORK_ENABLED`、
`NB_PROXY_PRIVATE`、`3478`、`51820`。
反向（merged 不得出现）：`./config.yaml`、`netbird-traefik`、`certresolver`、
``HostSNI(`*`)``、`pp-v2`、`env_file`、`NETBIRD_AGENT_NETWORK_ONLY`。
结构（中间产物）：upstream base 含 dashboard+netbird-server 且**无** `traefik` 服务；
片段含 `services.proxy` 与 `netbird_proxy_certs`。

## override（`docker-compose.portainer.yaml`）定制点

以下合并语义全部经 compose v5.6.0 实测：

- 顶层 `name: netbird`（卷名恒为 `netbird_*`）。
- 三镜像改 `jcr.savorcare.com/docker/netbirdio/{netbird-server,dashboard,reverse-proxy}:latest`
  （tag 浮动，digest 由 bot 钉）。
- **dashboard**：`env_file: !reset null` → inline environment（`dashboard.env` 全部内容
  + `NETBIRD_AGENT_NETWORK_ENABLED: "true"`）；labels 纯追加三条——web 入口
  `http2https` 跳转路由（authentik 同款，compose 标签按列表追加合并，无 key 冲突）。
- **netbird-server**：`volumes: !override` → `netbird_data:/var/lib/netbird` +
  `netbird_config:/etc/netbird`（命名卷替代 `./config.yaml` bind——密钥不进 git、
  合并产物单文件可部署）。
- **proxy**：
  - `env_file: !reset null` → inline environment：`NB_PROXY_TOKEN: ${NB_PROXY_TOKEN}`
    （`--no-interpolate` 保留模板，Arcane 项目 env 注入）、`NB_PROXY_PRIVATE=true`、
    `NB_PROXY_ACME_CERTIFICATES=false`、`NB_PROXY_PROXY_PROTOCOL=false`、
    `NB_PROXY_WG_PORT=51820`（固定 WG 端口，配合宿主 UDP 映射；单账号部署适用）、
    `NB_PROXY_WILDCARD_CERT_DIR=/wildcard-certs`，其余静态项照抄 proxy.env 参考件；
  - `labels: !override` → 仅 `traefik.enable=false`（防御性；`!reset` 对 labels 会吞值，
    实测用 `!override`）；
  - `networks: !override` → `[reverse-proxy]`（与 server 同网，管理面内网直连）；
  - `volumes` 追加 `/opt/traefik/certs:/wildcard-certs:ro`（docker1 证书同步目录，
    **实际路径部署时确认**，README 落实）。
- 新增顶层卷 `netbird_config`。

注意：`labels: !reset` + 换行列表会把列表吞掉（实测），labels 必须用 `!override`；
`env_file` 用 `!reset null`（authentik 已验证）；`volumes`/`networks` 用 `!override`。

## proxy 流量与 TLS 方案

- agent（peer）→ WG 隧道 → proxy 内嵌 netstack 的 per-account inbound listener
  （`:8443`），TLS 在 proxy 终止，SNI 命中 `NB_PROXY_WILDCARD_CERT_DIR` 里的
  `*.netbird.savorcare.com` 静态证书。traefik 完全不参与。
- proxy 加入 WG：宿主 UDP `51820` 映射（直连优化）+ server 内嵌 relay 兜底。
- proxy → 管理面：`http://netbird-server:80`（reverse-proxy 网络内直连）。
- **不配置任何 proxy 的 traefik 路由**（无私有模式下的公网表面）。
- 回退方案（仅当部署验证发现 endpoint DNS/证书不按预期工作时再启用）：给 proxy 加
  `HostSNIRegexp(`^.+\.netbird\.savorcare\.com$`)` 的 TCP passthrough + proxy 自 ACME
  （tls-alpn-01），记录于 README；默认不启用。

## 部署 bootstrap（README 一次性步骤）

1. DNS：`netbird.savorcare.com` A 记录指 docker1；`*.netbird.savorcare.com` 公网泛解析
   可选（overlay 内 endpoint 解析由 NetBird DNS 负责，公网记录仅在启用 passthrough
   回退方案时需要）。
2. OPNSense：证书申请加 `*.netbird.savorcare.com`，同步到 docker1（路径写入 README）。
3. docker1 预检：UDP 3478（STUN）、UDP 51820（proxy WG）未被占用。
4. 生成真实 `config.yaml`：从分支模板复制，3 个占位符用 `openssl rand -base64 32`
   生成（`encryptionKey` 保留 base64 尾 `=`）；模板里 `trustedHTTPProxies` 的
   `172.30.0.10/32` 是上游为内建 traefik 写的死值，替换为 docker1 traefik 在
   reverse-proxy 网络的源地址段；`trustedPeers` 键模板不存在，需要时手工新增同值条目，
   灌入 `netbird_config`
   卷（`docker run --rm -v netbird_netbird_config:/cfg -v $PWD:/src alpine sh -c
   "cp /src/config.yaml /cfg/"`）。
5. Arcane 建项目，项目 env 必填仅一项：`NB_PROXY_TOKEN`（先填占位）。
6. 首次部署后：`docker exec netbird-server /go/bin/netbird-server admin token create
   --name "default-proxy" --config /etc/netbird/config.yaml` 拿真 token → 填项目 env →
   重建（此前 proxy 起不来属预期）。
7. 浏览器开 `https://netbird.savorcare.com/setup` 建首个管理员。
8. Agent Network：Providers 接 provider → 生成 endpoint → Policies 授权 source group →
   客户端连网后 curl endpoint 验证 → Usage & Logs 确认计量。

## 验证计划

- 设计期已完成：两次渲染本地跑通；三文件合并（compose v5.6.0 standalone）产出符合
  全部正/反向断言；`${NB_PROXY_TOKEN}` 保留；独立解析通过。
- 实施期：workflow 首次 `workflow_dispatch` 跑通，产物与本地模拟一致；
  docker1 实际部署走 bootstrap 清单。

## 回滚

- sync 引入的上游不兼容：workflow 哨兵失败不提交，线上不动；已提交的坏变更在
  `netbird` 分支 revert 对应 commit 后 Arcane 重新同步。
- Agent Network 整体下线：override 移除 proxy 服务定制与
  `NETBIRD_AGENT_NETWORK_ENABLED`，重建即可（数据在卷里，随时可再加回）。

## 开放项（部署期确认）

- docker1 证书同步的实际落盘路径（override 的 `/opt/traefik/certs` 为占位）。
- endpoint 的 overlay DNS 记录是否由 management 自动下发（connect provider 后验证）。
- proxy 固定 WG 端口 51820 与 docker1 上潜在 netbird client 的端口冲突（预检）。
- ~~远程 proxy 路由差异~~（已关闭：override 用同 key label 覆盖给 gRPC 路由补上了
  `/management.ProxyService/` 前缀，未来加跨主机远程 proxy 无需再动路由）。
</content>
