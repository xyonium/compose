# sub2api 生产部署清单（DIST-0 → DIST-1 → DIST-2）

> 分支状态：`sub2api` 分支已安全清洗重建（单 commit `e024e79`），digest 冻结于部署值
> `411d9ca53be0dded773f7418e570bbdc4834c2cf6ff4ecad4e5347f882b6e79b`（旧 compose diff
> Already verified 和内容正是生产需要的）。
> 你只需在部署平台（Arcane）上补两个项目 env + Sync。

## 1. 项目 env 补充（Arcane → 项目 sub2api → Settings → Environment / .env）

新增 2 个变量（其它既有变量照旧）：

| 变量 | 值 | 说明 |
|---|---|---|
| `SUB2API_DOMAIN` | `sub2api.example.com` | 对外访问域名（半段耦）——traefik 路由 Host 来源于此 |
| `JCR_REGISTRY` | `jcr.example.com` | 私服 mirror 主机名（**只写主机名，不带协议不带路径**） |

> 追加后保存 check：确认这些值不被 `${...}` 嵌进添加进 compose YAML——平台会自己代入。

## 2. Sync / Up（Arcane → sub2api 项目 → Sync / Redeploy）

- 入口：Arcane UI 的 sub2api 项目页面，`Sync`（拉取 sub2api 分支的预合并 compose）;
- 然后用让容器重建的路径（`Update/Redeploy`），三个服务（postgres/redis/sub2api）会然到
  带新 env 的 compose；
- 关键：postgres/redis 两卷的容器名是上游默认的 `sub2api-postgres` / `sub2api-redis`——
  卷名不被项目名份影响（`sub2api_postgres_data / sub2api_redis_data / sub2api_sub2api_data`），报重新挂回。

## 3. 验证

部署完成后（容器健康），在浏览器/ curl 验：
- `https://sub2api.example.com/` → sub2api 应用页 200
- Host header 重定向：`http://sub2api.example.com/` → 302 到 https
- 健康端点：`curl -sk https://sub2api.example.com/health` → 200/`ok`
- 日志确认 ADMIN_EMAIL 生成账号：`docker compose logs sub2api 2>&1 | grep -i "admin account"`，
  首次启动捺少可取管理员初始邮箱/密码涛，**登入后立刻修改**

## 若需要回滚

Arcane UI 在 sub2api 项目历史里选上一次 deployment 回滚；或修改分支 revert
到 `f75ab34^` 之前的 commit（我们的 digest 都在 git 里）。**最简方式**：
发布新 `run pin_mode=latest` 后不要动 env，到 500 分 GitOps 周期自动同步即可。
