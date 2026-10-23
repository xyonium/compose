// src/service/introspection-cache.ts
import { createHash } from "crypto";
function createIntrospectionCache(options) {
  const now = options.now ?? Date.now;
  const entries = /* @__PURE__ */ new Map();
  const inflight = /* @__PURE__ */ new Map();
  function store(key, value) {
    const at = now();
    const ttl = options.ttlMs(value, at);
    if (!(ttl > 0)) return;
    entries.delete(key);
    entries.set(key, { expiresAt: at + ttl, value });
    while (entries.size > options.maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === void 0) break;
      entries.delete(oldest);
    }
  }
  return {
    async get(parts, load) {
      const key = createHash("sha256").update(parts.join("\0")).digest("hex");
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        if (hit.expiresAt > now()) {
          entries.set(key, hit);
          return hit.value;
        }
      }
      const pending = inflight.get(key);
      if (pending) return pending;
      const request = load().then(
        (value) => {
          inflight.delete(key);
          store(key, value);
          return value;
        },
        (error) => {
          inflight.delete(key);
          throw error;
        }
      );
      inflight.set(key, request);
      return request;
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    }
  };
}
var INTROSPECTION_ACTIVE_TTL_MS = 6e4;
var INTROSPECTION_INACTIVE_TTL_MS = 1e4;
function introspectionTtlMs(value, now, activeTtlMs = INTROSPECTION_ACTIVE_TTL_MS, inactiveTtlMs = INTROSPECTION_INACTIVE_TTL_MS) {
  if (!value.active) return inactiveTtlMs;
  if (value.exp === void 0) return activeTtlMs;
  if (typeof value.exp !== "number" || !Number.isFinite(value.exp)) return 0;
  return Math.min(activeTtlMs, value.exp * 1e3 - now);
}
export {
  INTROSPECTION_ACTIVE_TTL_MS,
  INTROSPECTION_INACTIVE_TTL_MS,
  createIntrospectionCache,
  introspectionTtlMs
};
