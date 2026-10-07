---
name: compose-repo-portainer-stacks
description: xyonium/compose 仓库结构与约定——Portainer 栈每项目一 orphan 分支，三文件模式，sync workflow 钉 digest
metadata: 
  node_type: memory
  type: project
  originSessionId: 71e07b7d-2262-4afc-be66-ed3b495a6310
  modified: 2026-09-22T04:24:58.875Z
---

用户的 `xyonium/compose` 仓库（public，2026-09-22 创建）集中管理 Portainer 部署栈：

- **main**：只有索引 README + 每项目一个 `sync-<branch>.yml`（定时只跑默认分支所以集中在 main；当前 schedule 刻意注释未启用，待 Portainer 切换后取消注释）
- **项目 orphan 分支**（firecrawl、sub2api）：三文件模式——`docker-compose.upstream.yaml`（bot 同步上游原样拷贝）、`docker-compose.portainer.yaml`（唯一手改文件，全部自定义）、`docker-compose.yaml`（bot 生成的预合并产物，Portainer 部署它）
- **基础设施约定**：镜像走私服 `jcr.savorcare.com/{ghcr,docker}/`；traefik 走外部网络 `reverse-proxy`，`*.savorcare.com` 泛域名证书 certresolver `myresolver`；CE Portainer 无 re-pull image → 主镜像必须钉 digest 靠 compose diff 驱动更新，稳定第三方镜像浮动不钉；secrets 一律在 Portainer stack env 不进 git
- firecrawl 分支自 xyonium/firecrawl 的 portainer-stack 分支带 37 提交历史迁入（回滚链未断），分支内 3 个镜像构建 workflow 推 `ghcr.io/xyonium/firecrawl-*`（用户命名空间 package，需给 compose 仓库授 write）
- 本机直连 github.com 的 git/TLS 偶发握手失败，重试即可；api.github.com 与 raw.githubusercontent.com 稳定可用
