# netbird 分支

NetBird 全功能自建（VPN 管理 + **Agent Network** Beta），目标主机 docker1，
对外地址 `https://netbird.savorcare.com`。

上游没有静态 compose 文件：官方安装入口是交互式脚本 `getting-started.sh`
（内嵌 Dex IdP，无需外部 IdP）。本分支的上游产物由 main 的 `sync-netbird.yml`
在 Action 里 **source 脚本、只调渲染函数（不部署）** 生成：

- 第一次渲染（`REVERSE_PROXY_TYPE=1`，外部 traefik）→ `docker-compose.upstream.yaml`
  （dashboard + netbird-server，标签自带 docker1 固定证书风格 `tls=true`）
- 第二次渲染（`REVERSE_PROXY_TYPE=0` + `ENABLE_PROXY=true`）→ 从中提取 proxy 服务
  → `docker-compose.upstream-proxy.yaml`（proxy 定义始终跟踪上游，非手抄）

## 文件分工

| 文件 | 用途 | 谁来改 |
|---|---|---|
| `docker-compose.upstream.yaml` | 脚本 option 1 渲染原样产物 | 只由机器人改 |
| `docker-compose.upstream-proxy.yaml` | 脚本 option 0 渲染后提取的 proxy 片段 | 只由机器人改 |
| `docker-compose.portainer.yaml` | 全部自定义（mirror、密钥外置、agent network、traefik 补充标签） | **只手改这个** |
| `docker-compose.yaml` | 三文件预合并产物，3 个 netbirdio 镜像钉 digest | 只由机器人生成 |
| `config.yaml` | 渲染参考模板（3 个密钥已洗成 `__GENERATE_AT_DEPLOY__`） | 只由机器人改 |
| `dashboard.env` / `proxy.env` | 渲染参考件（token 为 `__SET_ME__` 占位） | 只由机器人改 |

## 平台项目 env（必填）

| 变量 | 说明 |
|---|---|
| `NB_PROXY_TOKEN` | proxy 注册到管理面的 token。首次部署先填占位值（proxy 起不来属预期），拿到真 token 后替换重建（见 bootstrap 第 5 步） |
| `NB_RELAY_AUTH_SECRET` | relay 与 management 的共享密钥。**必须与 config.yaml 里 `relays.secret`（= `server.authSecret`）同值**，错一个字符表现为 relay 健康但拒绝所有 peer |

其余配置全部内联在 compose 里（dashboard env 无密钥；config.yaml 走命名卷）。

## 首次 bootstrap（按序执行）

1. **DNS**：`netbird.savorcare.com` A 记录指向 VPS（经 frp 隧道回源 docker1，
   见「公网接入架构」）；`relay.netbird.savorcare.com` A 记录指向公司静态 IP
   （OPNSense 映射进 docker1 的 relay 容器）。
   （`*.netbird.savorcare.com` 公网泛解析不需要——agent network endpoint 只在
   overlay 内解析；仅当启用公网暴露回退方案时才需要，见末节。）
2. **证书**：OPNSense 证书申请需包含 `*.netbird.savorcare.com`，同步到 docker1
   `/opt/traefik/certs/savorcare.com/`（bind 进 proxy 的 `/wildcard-certs` 只读挂载）。
   **proxy 容器以 UID/GID 1000 运行（非 root）**，同步工具须设置：公钥/私钥权限
   `0440`、组 `1000`（owner 保持 root），否则容器读不到私钥。proxy 主证书即该目录的
   `fullchain.pem` + `key.pem`（certwatch 热加载，续期免介入；override 环境变量
   `NB_PROXY_CERTIFICATE_FILE/KEY_FILE` 钉死这两个文件名，同步工具改名要同步改）。
   ⚠️ relay 容器（同样挂这个目录）与 proxy 不同：**证书只在启动时读一次，
   每次续期后要 `docker restart netbird-relay`**。
3. **端口预检**（docker1）：UDP 3479（STUN）、UDP 51821（proxy WG）、TCP/UDP 9443（relay）
   未被占用：`ss -lunp | grep -E '3479|51821|9443'` 应为空。
   （3478/51820 刻意避开：OPNSense 的 TURN 插件占了 3478，自带 NetBird 客户端占了 51820。）
4. **生成真实 `config.yaml` 并灌入命名卷**（用分支自带脚本，纯标准库、带断言，
   杜绝手改 YAML/sed 的坑）：

   ```bash
   curl -fsSL https://raw.githubusercontent.com/xyonium/compose/netbird/config.yaml -o config.yaml
   curl -fsSL https://raw.githubusercontent.com/xyonium/compose/netbird/scripts/bootstrap-config.py -o bootstrap-config.py
   python3 bootstrap-config.py config.yaml config.yaml \
     "$(docker network inspect reverse-proxy -f '{{(index .IPAM.Config 0).Subnet}}')"
   # 脚本完成：3 个随机密钥、trustedHTTPProxies 死值替换、追加外部 stuns/relays
   # （relays.secret 自动等于 authSecret）
   grep -c GENERATE config.yaml   # 必须为 0 再继续（server 对占位符会 FATL）：
                                  # decode encryption key: illegal base64 data
   docker volume create netbird_netbird_config
   docker run --rm -v netbird_netbird_config:/cfg -v "$PWD":/src alpine \
     sh -c "cp /src/config.yaml /cfg/config.yaml"
   ```
5. **Arcane 建项目**部署（compose 用本分支 `docker-compose.yaml`，项目 env 填
   `NB_PROXY_TOKEN=placeholder`）。待 netbird-server 正常后取真 token：

   ```bash
   docker exec netbird-server /go/bin/netbird-server admin token create \
     --name "default-proxy" --config /etc/netbird/config.yaml
   ```

   输出 `nbx_...` 填入项目 env `NB_PROXY_TOKEN`，重建项目（此前 proxy 起不来属预期）。
6. **建首个管理员**：浏览器开 `https://netbird.savorcare.com/setup`（仅无用户时可见）。

## Agent Network 验证

1. Dashboard 左侧应出现 **Agent Network** 菜单（Peers/DNS 等常规页面同时保留——
   本部署是完整面板，非 ONLY 模式）。
2. **Agent Network → Providers → Connect Provider**：填入 provider 密钥，
   保存后生成 tunnel-only endpoint（`*.netbird.savorcare.com` 形态）。
3. **Policies → Add Policy**：把 source group 关联到 provider（默认全拒）。
4. 测试设备连 NetBird 客户端后，在 overlay 内 curl endpoint 验证；
   **Usage & Logs** 应记录身份/模型/token/费用。
5. endpoint 证书由 proxy 容器从 `/wildcard-certs`（docker1 同步的泛域名证书）提供；
   若 TLS 报错先查该挂载路径与证书 SAN。

## 公网接入架构（外部 VPN 访问，方案 A）

公司宽带静态 IP 但 ISP 封 80/443 入站。**核心结论：只有控制面（TCP 443）需要经
VPS/frp 隧道中转；STUN、relay 数据面、WireGuard P2P 全部直连公司静态 IP，不碰 VPS。**

![proxy 工作机制（Agent Network 数据面）](docs/proxy-architecture.svg)

<details><summary>Mermaid 源（可直接编辑）</summary>

```mermaid
flowchart TB
    subgraph ext["外部（公网）"]
        PEER["员工/ agent 设备<br/>（NetBird Client）"]
        VPS["VPS · frps<br/>仅 TCP 443 透传<br/>（TLS 不终结，SNI 原样）"]
    end

    subgraph edge["公司边界 · OPNSense（静态 IP，443/80 被封）"]
        NAT["端口映射<br/>9443 tcp/udp → docker1 relay<br/>3479/udp → docker1 relay<br/>51821/udp → docker1 proxy（可选）"]
        OPN["OPNSense NetBird 客户端<br/>= routing peer，发布 VLAN 网段"]
    end

    subgraph d1["docker1（公司内网）"]
        T["traefik :443<br/>（固定证书）"]
        S["netbird-server<br/>mgmt/signal/oauth2/api"]
        D["dashboard"]
        R["relay 容器<br/>:9443(WS+QUIC) :3479(STUN)"]
        P["proxy 容器 :51821<br/>（agent network，WG 内）"]
    end

    VLAN["公司各 VLAN 资源"]
    LLM["上游 LLM API"]

    PEER -- "① 控制面 TLS :443<br/>netbird.savorcare.com" --> VPS
    VPS == "frp 隧道（frpc 在 docker1 主动拨出）" ==> T
    T --> S
    T --> D
    PEER -- "② STUN UDP 3479（打洞）" --> NAT
    PEER -- "③ relay 兜底 9443 tcp/udp<br/>（仅 P2P 失败时）" --> NAT
    NAT --> R
    PEER <-. "④ WireGuard P2P 直连<br/>（打洞成功后数据面）" .-> OPN
    OPN --> VLAN
    PEER <-. "agent network：WG 隧道" .-> P
    P --> LLM
```

</details>

### 组件职责与暴露面

| 组件 | 谁需要可达 | 路径 | 端口 |
|---|---|---|---|
| netbird-server（mgmt/signal/oauth2/api） | 所有 peer | VPS frp 透传 → docker1 traefik | TCP 443 |
| dashboard | 仅管理员 | 同上（管理 UI 随 443 可达，官方形态如此） | TCP 443 |
| relay + STUN | 所有 peer（打洞/兜底） | OPNSense 映射 → docker1 relay 容器 | TCP+UDP 9443、UDP 3479 |
| proxy（agent network） | 仅 overlay 内 peer | 不公网暴露 | UDP 51821（可选映射，改善打洞；51820 被 OPNSense 自带客户端占用） |
| WireGuard P2P | peer ↔ peer | 直连（打洞） | UDP 51820 等 |

### VPS/frp 要点

- VPS 只需很小规格（512MB 内存足够，只过 TLS 加密控制面流量）。
- frp 用**纯 TCP 透传**（`type = tcp`，443 → docker1:443 经 frpc），TLS 在 docker1
  traefik 终结，证书/SNI 无感。frps 的 443 被 netbird 独占；要同端口复用其他服务
  （auth/firecrawl 等），在 VPS 上改用 nginx stream `ssl_preread` 按 SNI 分流。
- frpc 跑在 docker1（或任一内网主机），主动出站连接 frps——公司侧零入站端口。
- UDP 3479/9443 **不要**走 frp（延迟敏感且 frp UDP 支持有限），走 OPNSense 直连。

### 切换步骤（已在跑的部署加 relay）

顺序有讲究（外置 relay 是 cutover，不是渐变）：

1. 先部署新版 compose（relay 容器起来，`docker logs netbird-relay` 看到
   WS/QUIC/STUN 三行监听）。
2. OPNSense 配好 9443 tcp/udp + 3479/udp 映射，确认公网可连：
   `curl -v https://relay.netbird.savorcare.com:9443/` 应 TLS 握手成功（404 正常）。
3. 最后改 config.yaml 卷里的 stuns/relays（bootstrap 脚本已含）→
   `docker restart netbird-server`。**此重启即切断内嵌 relay**，peer 直连外置 relay。
4. peer 上验证：`netbird status -d` 应显示
   `[stun:relay.netbird.savorcare.com:3479] is Available` 和
   `[rels://relay.netbird.savorcare.com:9443] is Available via ws/quic`。
   强制中继测试：`sudo netbird service reconfigure --service-env NB_FORCE_RELAY=true`。

### OPNSense 组网建议

OPNSense 上的 NetBird 客户端配成 **Networks 的 routing peer**：Dashboard →
Networks → 发布各 VLAN 网段（如 192.168.10.0/24），配 ACL 按组授权——
"外部 VPN 访问 + 内部跨 VLAN 授权"都由 NetBird 策略统一管控。OPNSense 静态 IP +
UDP 51821 映射到 proxy，外部 peer 与它之间 P2P 直连成功率高。

draw.io 可编辑源文件：[docs/public-access-architecture.drawio](docs/public-access-architecture.drawio)
（在 draw.savorcare.com 里 File → Open from URL 贴 raw 地址即可打开）。

## 自定义摘要

- 镜像全部走 `jcr.savorcare.com/docker/netbirdio/*` mirror，3 个主镜像钉 digest
  （bot 每次 sync 重钉 latest）。
- traefik 标签为 docker1 固定证书风格（`tls=true`，无 certresolver），override 只补了
  web 入口 `http2https` 跳转一条。
- `./config.yaml` bind 挂载改为 `netbird_config` 命名卷（密钥不进 git，
  合并产物单文件可部署）。
- proxy 私有模式：`NB_PROXY_PRIVATE=true`、无 traefik 路由（`traefik.enable=false`）、
  ACME 关闭、PROXY protocol 关闭——agent 流量走 WireGuard 隧道直连 proxy，
  不经过 docker1 的 traefik。

## 回退方案：proxy 公网暴露（默认不启用）

仅当未来要用 proxy 的"向公网暴露内网资源"功能时：

1. override 给 proxy 加回 TCP passthrough 标签，`HostSNIRegexp` 收敛到
   `^.+\.netbird.savorcare.com$`（**不得**用上游的 `HostSNI(*)`，会接管共享 traefik
   上其他栈的 443 流量）；
2. proxy 开 `NB_PROXY_ACME_CERTIFICATES=true`（tls-alpn-01）或继续用静态证书；
3. 公网 DNS 加 `*.netbird.savorcare.com` 泛解析；
4. 需要保真实客户端 IP 时再上 PROXY protocol v2（宿主 traefik 加 file provider
   的 serversTransport 片段 + `NB_PROXY_PROXY_PROTOCOL=true`）。

## proxy 工作机制（Agent Network 数据面）

![公网接入架构](docs/public-access-architecture.svg)

<details><summary>Mermaid 源（可直接编辑）</summary>

```mermaid
flowchart LR
    subgraph peers["Peers（WireGuard overlay）"]
        A["Agent 设备<br/>Claude Code / Codex<br/>（不带任何 API key）"]
        B["管理员浏览器"]
    end

    subgraph docker1["docker1 · compose 项目 netbird"]
        P["<b>proxy 容器</b><br/>内嵌 userspace WG netstack :8443<br/>TLS 用同步泛域名证书（热加载）<br/><br/>① WG 源 IP → peer 身份+组<br/>② 解析模型/流式标记<br/>③ 路由+策略+配额+guardrail<br/>④ 剥离客户端认证头，注入 provider key<br/>⑤ 转发 → 响应计量 → 回写"]
        S["<b>netbird-server</b><br/>management+signal+relay+STUN<br/>providers/policies/limits/usage"]
        D["<b>dashboard</b>（管理 UI）"]
        T["宿主 traefik :443<br/>（proxy 不经过它）"]
    end

    L["上游 LLM（公网）<br/>OpenAI / Anthropic / 网关<br/>key 只存服务端"]

    A -- "WG 隧道内 HTTPS<br/>xxx.netbird.savorcare.com" --> P
    P -- "注入 key 后转发" --> L
    P <-. "身份/策略查询 + 用量回写<br/>内网 :80" .-> S
    S -. "控制面下发" .-> P
    B -- "443 管理" --> T
    T --> D
    T --> S
```

</details>

要点：**agent 流量全程在 WireGuard 隧道内，不经过 traefik 或任何公网入口**；
身份来自 WG peer 映射（隧道即凭证），endpoint 仅 overlay 内可达；
provider key 只存服务端，客户端永远拿不到（keyless）。
draw.io 可编辑源文件：[docs/proxy-architecture.drawio](docs/proxy-architecture.drawio)。

## 回滚

- sync 引入上游不兼容变更：workflow 哨兵会失败且不提交，线上不动。
- 已提交的坏变更：在本分支 revert 对应 sync commit，Arcane 重新同步。
  digest 历史都在 git 里。
- 关闭 Agent Network：`docker-compose.portainer.yaml` 删掉
  `NETBIRD_AGENT_NETWORK_ENABLED` 与 proxy 定制，等下次 sync 或直接手改
  `docker-compose.yaml` 重建（数据在 `netbird_*` 卷里，随时可加回）。
