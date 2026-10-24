# aria2

部署 [P3TERX/Aria2-Pro-Docker](https://github.com/P3TERX/Aria2-Pro-Docker)
（Aria2-Pro 下载器 + AriaNg 静态前端）。对外域名走 env，不入库。

2026-10-24 自旧仓库 xyonium/Aria2-Pro-Docker 迁移入本仓库（旧 fork 除
docker-compose.yml 外与上游完全一致，迁移后旧仓库可删除）。

## 文件分工

| 文件 | 用途 | 谁来改 |
|---|---|---|
| `docker-compose.upstream.yaml` | 上游 docker-compose.yml 原样拷贝 | 只由同步机器人改 |
| `docker-compose.portainer.yaml` | 全部自定义（mirror、nginx-proxy、env 化路径/密钥） | **手改只动这个文件** |
| `docker-compose.yaml` | 机器人预合并产物（aria2-pro/ariang 钉 digest），部署平台直接消费 | 只由机器人生成 |

## 部署平台项目 env 必填

| 变量 | 说明 |
|---|---|
| `ARIA2_DOMAIN` | 对外域名，如 `aria.example.com`（不带 scheme） |
| `JCR_REGISTRY` | 私服 mirror 主机名（不带前导/后缀 `/`）。**可不设**：不设/空串时镜像回落 docker.io 官方源 |
| `ARIA2_RPC_SECRET` | aria2 RPC 密钥，`openssl rand -hex 16` 生成；上游默认 `P3TERX` 是公开弱口令，必须设 |
| `ARIA2_CONFIG_DIR` | aria2 配置目录，**不带前导 `/`**，如 `root/aria2-config` |
| `ARIA2_DOWNLOADS_DIR` | 下载目录，**不带前导 `/`**，如 `root/nfs/Video/videotmp` |

⚠️ 路径变量值格式是硬要求（compose-go bind 归一化 bug，见主仓库踩坑清单 #3）：
overlay 写的是 `source: /${VAR}`，展开成 `//root/...`，Linux 容忍双斜杠；
值若带前导 `/` 会变三斜杠或触发相对路径误判。

## 同步

main 分支 `sync-aria2.yml`（workflow_dispatch，默认定时未启用）：
拉上游 compose → 与 portainer 层 `--no-interpolate` 合并 → aria2-pro / ariang
两镜像钉 digest → 哨兵校验 → leakage 总闸 → 有变化才提交推送。
