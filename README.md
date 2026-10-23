# dify

部署 [langgenius/dify](https://github.com/langgenius/dify) 的 `docker/` 栈
（api + worker 系 + web + plugin_daemon + sandbox + postgres + redis + weaviate，
向量库走 weaviate profile）。对外域名走 env，不入库。

2026-10-23 自旧仓库 xyonium/dify 迁移入本仓库（旧仓库 docker/stack.env 含真实域名
与多个明文凭据，将删除，一切引用以本分支为准）。

## 文件分工

| 文件 | 用途 | 谁来改 |
|---|---|---|
| `docker-compose.upstream.yaml` | 上游 docker/docker-compose.yaml 原样拷贝 | 只由同步机器人改 |
| `.env.example` | 上游 docker/.env.example 原样拷贝，查变量的权威参考 | 只由同步机器人改 |
| `docker-compose.portainer.yaml` | 全部自定义（镜像 mirror、traefik、named volume、env_file 清零） | **手改只动这个文件** |
| `docker-compose.yaml` | 机器人预合并产物（dify-api/web/plugin-daemon 钉 digest），部署平台直接消费 | 只由机器人生成 |

## 部署平台项目 env 必填

| 变量 | 说明 |
|---|---|
| `DIFY_DOMAIN` | 对外域名，如 `dify.example.com`（不带 scheme） |
| `JCR_REGISTRY` | 私服 mirror 主机名（不带前导/后缀 `/`） |
| `SECRET_KEY` | dify 会话签名 key，`openssl rand -base64 42` 生成 |
| `INIT_PASSWORD` | 首个管理员账号初始密码 |
| `DB_PASSWORD` | postgres 密码 |
| `REDIS_PASSWORD` | redis 密码 |
| `WEAVIATE_API_KEY` | dify api 侧连接 weaviate 的 key，`openssl rand -hex 24` 生成 |
| `WEAVIATE_AUTHENTICATION_APIKEY_ALLOWED_KEYS` | weaviate 服务端允许的 key 列表，与上行同值 |

其余变量照抄 `.env.example`（上游全部变量带默认值，按需覆盖）。域名相关的
`CONSOLE_API_URL` / `CONSOLE_WEB_URL` / `SERVICE_API_URL` / `APP_API_URL` /
`APP_WEB_URL` / `FILES_URL` 留空即是同源（traefik 同域路由），或显式填
`https://<你的域名>`。

⚠️ 旧仓库（xyonium/dify）的 `docker/stack.env` 曾把上述全部凭据明文提交进公开仓库。
迁移后旧值视为已泄露，**必须全部轮换**（`SECRET_KEY` 轮换后所有登录态失效；
`INIT_PASSWORD` 只对初始化生效，已有管理员账号的在界面里改密码即可）。

## 迁移注意事项（自旧 Portainer stack 迁入）

- 本分支固定 `name: dify`，卷名恒为 `dify_app` / `dify_db` / `dify_redis` /
  `dify_weaviate`。旧栈若项目名已是 dify 则自动挂回；否则先改名旧卷。
- **版本跳跃**：旧栈跑 1.13.2，本分支跟上游 main（当前 1.18.0）。首次部署即跨版本
  升级，dify 启动时自动做 DB migration（只向前）。部署前建议先备份
  `dify_db`（pg_dump）与 `dify_app`。
- `COMPOSE_PROFILES` 由 `.env.example` 第 299 行给出
  （`${VECTOR_STORE:-weaviate},${DB_TYPE:-postgresql},collaboration`），项目 env 照抄即可。
- 旧栈没有的服务（api_websocket、knowledge_fs 系、agent_backend、local_sandbox 等）
  首次部署会多出来，属上游 1.18 新架构，正常。

## 同步

main 分支 `sync-dify.yml`（workflow_dispatch，默认定时未启用）：
拉上游 compose + `.env.example` → 与 portainer 层 `--no-interpolate` 合并
→ dify-api（5 处）/ dify-web / dify-plugin-daemon 钉 digest → 哨兵校验 →
leakage 总闸 → 有变化才提交推送。

镜像 pin 策略：三个主镜像钉 digest（`pin_mode=latest` 按 portainer 文件里的 tag
解析当前 digest / `keep` 只验证合并）；postgres / redis / weaviate / squid 等
稳定第三方镜像浮动不钉。**上游升级到新版 dify 时，手改 portainer 文件里的 tag
再跑 sync**（哨兵会比对上游 compose 引用的版本号与 portainer tag，不一致即失败）。
