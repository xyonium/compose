// src/origin.ts
import { createRequire } from "module";
var ORIGIN_SERVER = "mcp-fastmcp";
var DECLARED_ORIGIN_HEADER = "x-firecrawl-origin";
var NAME_MAX = 48;
var RUNTIME_PRODUCTS = /* @__PURE__ */ new Set([
  "apache-httpasyncclient",
  "apache-httpclient",
  "aiohttp",
  "axios",
  "bun",
  "curl",
  "dart",
  "deno",
  "faraday",
  "go-http-client",
  "got",
  "guzzlehttp",
  "java-http-client",
  "ktor-client",
  "libcurl-agent",
  "mozilla",
  "node",
  "node-fetch",
  "okhttp",
  "python",
  "python-httpx",
  "python-httpx2",
  "python-requests",
  "python-urllib",
  "reqwest",
  "ruby",
  "undici",
  "wget"
]);
var GENERIC_CLIENT_NAMES = /* @__PURE__ */ new Set([
  "client",
  "example-client",
  "mcp",
  "mcp-client",
  "test",
  "test-client"
]);
function slugOf(name) {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, NAME_MAX).replace(/-+$/, "");
}
function isOwnSlug(slug) {
  return slug === "" || slug === "fastmcp" || slug === "firecrawl-fastmcp";
}
function userAgentProduct(userAgent) {
  const first = (userAgent ?? "").trim().split(/\s+/)[0] ?? "";
  return slugOf(first.split("/")[0]);
}
function isRuntimeUserAgent(userAgent) {
  const product = userAgentProduct(userAgent);
  return product === "" || RUNTIME_PRODUCTS.has(product);
}
function initializeClientSlug(name) {
  const slug = slugOf(name);
  return isOwnSlug(slug) || GENERIC_CLIENT_NAMES.has(slug) ? "" : slug;
}
function publicHost(url) {
  let parsed;
  try {
    parsed = new URL(url ?? "");
  } catch {
    return "";
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local") || /^[\d.]+$/.test(host) || host.startsWith("[")) {
    return "";
  }
  return host.replace(/^www\./, "");
}
function referrerSlug(referrer) {
  return slugOf(publicHost(referrer));
}
var SHARED_STATIC_HOSTS = [
  "github.io",
  "gitlab.io",
  "pages.dev",
  "netlify.app",
  "vercel.app"
];
function isHttpUrl(value) {
  try {
    return /^https?:$/.test(new URL(value ?? "").protocol);
  } catch {
    return false;
  }
}
function oauthClientSlug(clientId, clientName) {
  if (!isHttpUrl(clientId)) return initializeClientSlug(clientName);
  const host = publicHost(clientId);
  if (!host || host === "firecrawl.dev" || host.endsWith(".firecrawl.dev")) {
    return "";
  }
  if (!SHARED_STATIC_HOSTS.some(
    (shared) => host === shared || host.endsWith(`.${shared}`)
  )) {
    return slugOf(host);
  }
  const [first = ""] = new URL(clientId ?? "").pathname.split("/").filter(Boolean);
  const segment = slugOf(first).slice(0, NAME_MAX / 2);
  if (!segment) return slugOf(host);
  const room = NAME_MAX - segment.length - 1;
  return slugOf(`${slugOf(host).slice(0, room)}-${segment}`);
}
function originForClient(client, serverVersion2, userAgent, signals = {}) {
  const declared = slugOf(signals.declaredOrigin);
  const slug = slugOf(client?.name);
  const product = userAgentProduct(userAgent);
  const remembered = initializeClientSlug(signals.initializeClient?.name);
  const oauthClient = oauthClientSlug(
    signals.oauthClientId,
    signals.oauthClientName
  );
  const referrer = referrerSlug(signals.referrer);
  const base = !isOwnSlug(declared) ? `mcp-${declared}` : !isOwnSlug(slug) ? `mcp-${slug}` : product && !RUNTIME_PRODUCTS.has(product) ? `mcp-ua-${product}` : remembered ? `mcp-${remembered}` : oauthClient ? `mcp-oauth-${oauthClient}` : referrer ? `mcp-ref-${referrer}` : product ? `mcp-ua-${product}` : ORIGIN_SERVER;
  return serverVersion2 ? `${base}@${serverVersion2}` : base;
}
function originHeaders(origin) {
  return { "X-Origin": origin };
}
var { version: serverVersion } = createRequire(import.meta.url)(
  "../package.json"
);
function requestOrigin(client, session) {
  return originForClient(
    client?.version ?? null,
    serverVersion,
    session?.clientUserAgent,
    {
      declaredOrigin: session?.clientOrigin,
      initializeClient: session?.initializeClient,
      oauthClientId: session?.oauthClientId,
      oauthClientName: session?.oauthClientName,
      referrer: session?.clientReferrer
    }
  );
}
export {
  DECLARED_ORIGIN_HEADER,
  ORIGIN_SERVER,
  initializeClientSlug,
  isRuntimeUserAgent,
  originForClient,
  originHeaders,
  requestOrigin,
  userAgentProduct
};
