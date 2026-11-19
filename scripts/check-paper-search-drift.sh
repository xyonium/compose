#!/usr/bin/env bash
# papers-service 漂移检测：镜像里烤进去的 paper-search commit 与 main 当前 head 比对。
#
# 构建时 papers-service-image.yml 给镜像打 org.xyonium.paper-search-ref 标签，
# 这里读运行中容器的该标签；不依赖 /healthz 的可达性（宿主机上 docker inspect 即可）。
#
# 退出码：0 一致；1 漂移（镜像落后）；2 无法判定（容器/标签缺失、网络失败）。
#
# 宿主机 cron 示例（每天 04:17；成功静默，漂移/失败才发邮件）：
#   MAILTO=you@example.com
#   17 4 * * * /path/to/compose/scripts/check-paper-search-drift.sh >/dev/null
# 不想收邮件就别装 cron：A 链路（notify→relay→build）已自动更新，这个脚本只是手工兜底。
# 成功信息走 stdout（被丢弃），drift/UNKNOWN 走 stderr（cron 只邮件 stderr）。
#
# 环境变量：PAPERS_SERVICE_CONTAINER（默认 firecrawl-papers-service）
#           PAPER_SEARCH_REPO（默认 https://github.com/xyonium/paper-search.git）
set -euo pipefail

container="${PAPERS_SERVICE_CONTAINER:-firecrawl-papers-service}"
repo="${PAPER_SEARCH_REPO:-https://github.com/xyonium/paper-search.git}"

actual=$(docker inspect "$container" \
  --format '{{index .Config.Labels "org.xyonium.paper-search-ref"}}' 2>/dev/null || true)
if [[ -z "$actual" ]]; then
  echo "UNKNOWN: $container 没有 org.xyonium.paper-search-ref 标签（旧镜像？先重建一次）" >&2
  exit 2
fi

expected=$(git ls-remote "$repo" refs/heads/main | cut -f1) || {
  echo "UNKNOWN: 无法解析 $repo 的 main（网络/git 失败）" >&2
  exit 2
}
if [[ -z "$expected" ]]; then
  echo "UNKNOWN: 无法解析 $repo 的 main" >&2
  exit 2
fi

if [[ "$actual" == "$expected" ]]; then
  echo "OK: papers-service 已是最新（paper-search ${actual:0:8}）"
  exit 0
fi

echo "DRIFT: papers-service 落后（image=${actual:0:8} main=${expected:0:8}）" >&2
echo "修复：xyonium/compose Actions → Build papers-service image → Run workflow（ref: firecrawl）" >&2
exit 1
