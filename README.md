# n8n

部署 [n8n-io/n8n-hosting](https://github.com/n8n-io/n8n-hosting) 的
`docker-compose/withPostgresAndWorker` 栈（queue 模式：n8n + worker + 两个 task runner
+ postgres + redis）。对外域名走 env，不入库。

2026-10-23 自旧仓库 xyonium/n8n-hosting 迁移入本仓库（旧仓库含真实域名与明文凭据，
将删除，一切引用以本分支为准）。

## 文件分工

| 文件 | 用途 | 谁来改 |
|---|---|---|
| `docker-compose.upstream.yaml` | 上游 compose 原样拷贝 | 只由同步机器人改 |
| `.env.example` | 上游 `.env` 原样拷贝，查变量的权威参考 | 只由同步机器人改 |
| `init-data.sh` | 上游 postgres 首启初始化脚本（建非 root 用户）原样拷贝 | 只由同步机器人改 |
| `docker-compose.portainer.yaml` | 全部自定义（镜像 mirror、traefik、pg 版本冻结） | **手改只动这个文件** |
| `docker-compose.yaml` | 机器人预合并产物（n8n/runners 镜像钉 digest），部署平台直接消费 | 只由机器人生成 |

## 部署平台项目 env 必填

| 变量 | 说明 |
|---|---|
| `N8N_DOMAIN` | 对外域名，如 `n8n.example.com`（不带 scheme） |
| `JCR_REGISTRY` | 私服 mirror 主机名（不带前导/后缀 `/`） |
| `POSTGRES_USER` | pg 超级用户 |
| `POSTGRES_PASSWORD` | pg 超级用户密码 |
| `POSTGRES_DB` | 数据库名，惯例 `n8n` |
| `POSTGRES_NON_ROOT_USER` | n8n 日常连接用的非 root 用户（init-data.sh 首启创建） |
| `POSTGRES_NON_ROOT_PASSWORD` | 同上密码 |
| `ENCRYPTION_KEY` | n8n 凭据加密 key，**换 key 后所有已存凭据密文不可读**，定了就别动 |
| `RUNNERS_AUTH_TOKEN` | task runner 认证 token，`openssl rand -hex 32` 生成 |

⚠️ 旧仓库（xyonium/n8n-hosting）曾把真实域名与上述全部凭据明文提交进公开仓库。
迁移后这些旧值视为已泄露，**必须全部轮换**；`ENCRYPTION_KEY` 轮换后 n8n 里已保存的
凭据需要重新录入（或在旧库用旧 key 导出再导入）。

## 迁移注意事项（自旧 Portainer stack 迁入）

- 旧 stack 的数据卷名带旧项目前缀（如 `<旧stack名>_db_storage`），本分支固定
  `name: n8n` 后卷名为 `n8n_db_storage` / `n8n_n8n_storage` / `n8n_redis_storage`。
  **首次部署前把旧卷改名对应上**（或先建空卷再灌数据），否则会以空库启动。
- postgres 冻结 `16-alpine`（见 portainer 文件注释），跟线上现有卷匹配；
  上游已用 pg18，pg 大版本升级要单独做 dump/restore。
- 旧栈没有 task runner 服务（上游后来加的），迁移后首次部署会多出
  `n8n-runner` / `n8n-worker-runner` 两个容器，属正常。

## 同步

main 分支 `sync-n8n.yml`（workflow_dispatch，默认定时未启用）：
拉上游 compose + `.env` + `init-data.sh` → 与 portainer 层 `--no-interpolate` 合并
→ n8n/runners 两镜像钉 digest → 哨兵校验 → leakage 总闸 → 有变化才提交推送。

镜像 pin 策略：n8nio/n8n 与 n8nio/runners 两主镜像钉 digest（`pin_mode=latest`
升级 / `keep` 只验证）；postgres:16-alpine / redis:7-alpine 稳定第三方镜像浮动不钉。
