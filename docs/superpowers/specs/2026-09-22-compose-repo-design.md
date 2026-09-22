# compose 仓库设计

日期：2026-09-22
状态：已实施

## 背景

分散的自托管部署配置难追踪。目标：一个仓库集中管理所有 Portainer 部署的 docker compose 栈，
每项目一个 orphan 分支，GitHub Actions 自动同步上游 compose 并合并本地自定义。
模式移植自已验证的 xyonium/firecrawl 仓库 portainer-stack 分支（本次整体迁入，git 历史保留）。

## 决策

1. **仓库**：`xyonium/compose`，public（文件无密钥——密钥全在 Portainer stack env；
   域名/mirror 信息在原 fork 已公开，公开仓库省去 Portainer 拉取凭据配置）。
2. **main 分支**：只放分支索引 README + 每项目一个 `sync-<branch>.yml` 工作流
   （GitHub 定时任务只跑默认分支，故集中于此）。
3. **项目分支（orphan）**：三文件模式——
   - `docker-compose.upstream.yaml`（上游原样拷贝，bot 维护）
   - `docker-compose.portainer.yaml`（全部自定义，唯一手改文件）
   - `docker-compose.yaml`（`docker compose config --no-interpolate` 预合并产物，
     主镜像钉 digest，Portainer 部署它；bot 生成）
4. **同步工作流**：拉上游 → 合并 → 钉主镜像 digest（CE Portainer 无 re-pull，靠 compose diff
   驱动镜像更新）→ 哨兵校验 → 有变化才提交推回项目分支。上游不兼容改动 → Action 失败不静默部署。
   **定时刻意注释未启用**：firecrawl 待 Portainer stack 切换后启用；sub2api 随时可启用。
5. **firecrawl 分支**：portainer-stack 分支含 37 个提交整体迁入并更名
   （digest 回滚链不断）。只改引用：3 个镜像构建 workflow 的分支 ref、
   image.source label、toolwrap.py UA、README。compose 文件逐字节未动。
   ghcr 镜像包名不变（package 属用户命名空间，与旧 fork 解耦）。
   **对旧 fork 零依赖**：上游同步源是官方 firecrawl/firecrawl；
   paper-search 构建依赖的是独立仓库 xyonium/paper-search。
6. **sub2api 分支**：上游 Wei-Shaw/sub2api 的 deploy/docker-compose.yml。自定义：
   - 镜像走 `jcr.savorcare.com/docker/` mirror（weishaw/sub2api、postgres:18-alpine、redis:8-alpine）
   - sub2api 摘宿主端口（`ports: !reset null`），接 `reverse-proxy` 外部网络走 traefik
     （sub2api.savorcare.com，myresolver 泛域名证书，容器端口显式钉 8080）
   - 顶层 `name: sub2api` 固定项目名，命名卷保持上游默认（sub2api_data/postgres_data/redis_data）
   - 只钉主镜像 digest（docker.io 解析 weishaw/sub2api:latest）；postgres/redis 带版本号浮动

## 实施结果

- 三分支：main（索引+2 workflow）、firecrawl（迁移+引用更新 1 个新提交）、sub2api（全新）
- sub2api 合并产物本地验证：ports 已清除、双网络合并、traefik 标签齐全、
  digest 钉至 sha256:411d9ca5（2026-09-22）、哨兵全过、独立解析通过

## 遗留事项（用户操作）

- Portainer firecrawl stack 切到本仓库后：取消 main `sync-firecrawl.yml` 的 schedule 注释
- ghcr 三个 firecrawl-* package 给 compose 仓库授 Actions write 权限
- 旧 fork xyonium/firecrawl 可随时删除（本仓库对其零依赖）
