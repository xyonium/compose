#!/usr/bin/env python3
"""bootstrap-config.py — 把分支的 config.yaml 模板变成可部署的真实配置。

用法（在 docker1 上）：
    python3 bootstrap-config.py config.yaml config.yaml [trusted subnet]
    # trusted subnet 例：172.18.0.0/16（docker network inspect reverse-proxy 查）

做的事（全部幂等断言，模板变了会报错而不是静默产坏文件）：
  1. 3 个 __GENERATE_AT_DEPLOY__ → 随机密钥（authSecret 去 base64 尾 =，与上游脚本一致；
     其余两个保留 =）
  2. trustedHTTPProxies 死值 172.30.0.10/32 → docker1 traefik 实际源地址段（给了参数才换）
  3. 追加外部 STUN/relay 配置（server: 块层级由缩进保证：模板最后一个块是 store:，
     文件尾以 2 空格缩进追加即落在 server: 下）。relays.secret 自动等于 authSecret，
     与 relay 容器的 NB_AUTH_SECRET（项目 env NB_RELAY_AUTH_SECRET）三者同值。

仅用标准库（docker 宿主可能没有 PyYAML）。
"""
import base64
import re
import secrets
import sys

STUN_URI = "stun:relay.netbird.savorcare.com:3478"
RELAY_ADDR = "rels://relay.netbird.savorcare.com:9443"


def b64(strip_padding=False):
    v = base64.b64encode(secrets.token_bytes(32)).decode()
    return v.rstrip("=") if strip_padding else v


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    trusted = sys.argv[3] if len(sys.argv) > 3 else None

    t = open(src).read()
    if "__GENERATE_AT_DEPLOY__" not in t:
        sys.exit("错误：模板里没有占位符——这是已处理过的文件？为避免覆盖密钥，退出。")

    relay_secret = b64(strip_padding=True)  # relay 共享密钥（上游脚本对它去尾 =）
    t, n1 = re.subn(r'(?<=authSecret: )"[^"]*"', f'"{relay_secret}"', t, count=1)
    t, n2 = re.subn(r'(?<=sessionCookieEncryptionKey: )"[^"]*"', f'"{b64()}"', t, count=1)
    t, n3 = re.subn(r'(?<=encryptionKey: )"[^"]*"', f'"{b64()}"', t, count=1)
    assert n1 == n2 == n3 == 1, "模板 3 个密钥字段未全部命中——上游模板结构变了，需人工核对"

    if trusted:
        t, n = re.subn(r'"172\.30\.0\.10/32"', f'"{trusted}"', t, count=1)
        assert n == 1, "trustedHTTPProxies 死值 172.30.0.10/32 未命中"

    assert "store:" in t, "模板缺少 store: 块——上游模板结构变了，追加层级需人工核对"
    if not t.endswith("\n"):
        t += "\n"
    t += f"""
  stuns:
    - uri: "{STUN_URI}"
      proto: "udp"
  relays:
    addresses:
      - "{RELAY_ADDR}"
    secret: "{relay_secret}"
    credentialsTTL: "24h"
"""
    open(dst, "w").write(t)
    print(f"OK: {dst}")
    print("已填入：3 个随机密钥 + 外部 STUN/relay（relays.secret == authSecret，")
    print("与项目 env 的 NB_RELAY_AUTH_SECRET 同值）。")
    if trusted:
        print(f"trustedHTTPProxies → {trusted}")
    else:
        print("注意：未给 trusted 子网参数，trustedHTTPProxies 仍是死值（功能可用，"
              "审计日志里客户端地址会是转发地址）。")


if __name__ == "__main__":
    main()
