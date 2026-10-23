// src/keyless-signup-link.ts
var SIGNUP_HOSTS = /* @__PURE__ */ new Set(["firecrawl.dev", "www.firecrawl.dev"]);
var TOKEN_PATH = /^\/k\/[0-9abcdefghjkmnpqrstvwxyz]{12}$/;
var SURFACES = /* @__PURE__ */ new Set(["api", "mcp", "cli"]);
var SIGNIN_PARAMS = /* @__PURE__ */ new Set(["utm_source", "utm_medium", "redirect"]);
var SIGNIN_REDIRECT = "/app/api-keys";
function checkKeylessSignupUrl(value) {
  if (typeof value !== "string") return { ok: false, firecrawlHost: false };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, firecrawlHost: false };
  }
  const firecrawlHost = SIGNUP_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" || !firecrawlHost || url.port || url.username || url.password || url.hash) {
    return { ok: false, firecrawlHost };
  }
  if (TOKEN_PATH.test(url.pathname) && !url.search) {
    return { ok: true, url: value };
  }
  if (url.pathname === "/signin") {
    const params = url.searchParams;
    const keys = [...params.keys()];
    const known = keys.every((key) => SIGNIN_PARAMS.has(key)) && new Set(keys).size === keys.length;
    if (known && params.get("utm_source") === "keyless" && SURFACES.has(params.get("utm_medium") ?? "") && (!params.has("redirect") || params.get("redirect") === SIGNIN_REDIRECT)) {
      return { ok: true, url: value };
    }
  }
  return { ok: false, firecrawlHost };
}
export {
  checkKeylessSignupUrl
};
